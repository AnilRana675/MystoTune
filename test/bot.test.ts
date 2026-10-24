/** M7.11 curation bot, slice B0 (SDD-channel-curation-bot.md): junk scan,
 * review cards, owner-gated taps, and deletion via the owner-session seam —
 * all network-free (transport + deleter are injectables). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSchema, openDb, upsertTrack, type TrackRow } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { TEST_SECRET } from "./util.js";
import {
  createCurationBot,
  junkCardText,
  junkFindings,
  type BotTransport,
  type CardKeyboard,
  type Sadle,
  type TelegramUpdate,
} from "../src/bot.js";

function baseEnv(env: Record<string, string | undefined>): ReturnType<typeof loadConfig> {
  return loadConfig({
    PORT: "1",
    PUBLIC_BASE_URL: "http://127.0.0.1:9",
    ALLOW_INSECURE_BASE_URL: "1",
    ADDON_SECRET: TEST_SECRET,
    MEDIA_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
    DB_PATH: mkdtempSync(path.join(os.tmpdir(), "m-bot-")),
    ...env,
  });
}

function row(over: Partial<TrackRow> = {}): Parameters<typeof upsertTrack>[1] {
  return {
    id: "tg_n-100555_1",
    chatId: -100555,
    msgId: 1,
    title: "Good Song",
    artist: "Artist",
    album: null,
    duration: 200,
    mime: "audio/mpeg",
    size: 3_000_000,
    fileName: "good.mp3",
    codec: null,
    container: "mp3",
    lossless: 0,
    bitrateKbps: 128,
    docId: 11,
    source: "telegram",
    filePath: null,
    hasThumb: 0,
    addedAt: 1,
    ...over,
  };
}

interface SentCard {
  chatId: number;
  text: string;
  keyboard: CardKeyboard;
}

class FakeTransport implements BotTransport {
  cards: SentCard[] = [];
  sentIds: Array<number | null> = [7];
  edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  answered: Array<{ id: string; text: string }> = [];
  failEdits = false;

  async sendCard(chatId: number, text: string, keyboard: CardKeyboard): Promise<number | null> {
    const id = this.sentIds.shift() ?? this.cards.length + 100;
    this.cards.push({ chatId, text, keyboard });
    return id;
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    if (this.failEdits) throw new Error("edit backend down");
    this.edits.push({ chatId, messageId, text });
  }

  async answerCallback(id: string, text: string): Promise<void> {
    this.answered.push({ id, text });
  }
}

const OWNER = 1000;

function tap(data: string, fromId = OWNER, messageText = true): TelegramUpdate {
  return {
    callback_query: {
      id: `cb-${Math.random().toString(16).slice(2)}`,
      from: { id: fromId },
      data,
      message: messageText
        ? { message_id: 77, chat: { id: OWNER } }
        : undefined,
    },
  };
}

test("junkFindings flags the SDD v1 signals and nothing else", () => {
  const rows = [
    row(), // healthy — not flagged
    row({ id: "tg_n-100555_2", msgId: 2, title: "Ringtone", duration: 8 }), // too short
    row({ id: "tg_n-100555_3", msgId: 3, title: "Whisper", bitrateKbps: 24 }), // low bitrate
    row({ id: "tg_n-100555_4", msgId: 4, title: "Broken", size: 0 }), // empty
    row({ id: "tg_n-100555_5", msgId: 5, title: "audio 3" }), // placeholder title
  ];
  const found = junkFindings(rows);
  assert.deepEqual(found.map((f) => f.row.msgId), [2, 3, 4, 5]);
  // indices proven by the deepEqual above; values asserted by scan rules
  const whyOf = (i: number): string => found[i]!.why;
  assert.ok(whyOf(0).includes("8 s"));
  assert.ok(whyOf(1).includes("24 kbps"));
  assert.ok(whyOf(2).includes("0 B"));
  assert.ok(whyOf(3).includes("placeholder title"));
  // card text carries the msg id so the owner can cross-check in-chat
  const card = junkCardText(found[0]!.row, whyOf(0));
  assert.ok(card.includes("Ringtone"), card);
  assert.ok(card.includes("msg 2"), card);
  assert.ok(card.includes("8 s"), card);
});

test("B0 end-to-end: sweep pushes owner-gated cards; delete tap drives the session seam", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot2-"));
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:A", BOT_ALLOWED_IDS: `${OWNER}` });
    assert.equal(cfg.bot.enabled, true, "token + owner id => enabled");
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    upsertTrack(db, row());
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Ringtone", duration: 8 }));

    const transport = new FakeTransport();
    const deletions: Array<{ chatId: number; msgIds: number[] }> = [];
    const deleter: Sadle = async (chatId, msgIds) => {
      deletions.push({ chatId, msgIds });
      return { deleted: msgIds.length };
    };
    const bot = createCurationBot({ cfg, db, deleter, transport, log: () => undefined });

    // config-on/off contract: without token/owner the bot sweeps nothing
    const disabled = createCurationBot({
      cfg: baseEnv({}),
      db,
      deleter,
      transport: new FakeTransport(),
      log: () => undefined,
    });
    assert.equal(await disabled.sweep(), 0, "disabled config sweeps nothing");

    const pushed = await bot.sweep();
    assert.equal(pushed, 1, "one junk card (healthy row is not flagged)");
    const card = transport.cards[0]!;
    assert.equal(card.chatId, OWNER, "cards go to the owner chat");
    assert.ok(card.text.includes("Ringtone"));
    assert.equal(card.keyboard.buttons[0]!.length, 2, "Delete + Keep");
    assert.deepEqual(
      card.keyboard.buttons[0]!.map((b) => b.data),
      ["junk:-100555:2:del", "junk:-100555:2:keep"],
    );

    await bot.sweep();
    assert.equal(transport.cards.length, 1, "asked memory: no re-spam within the process");

    // stranger taps are refused before any deletion plan exists
    await bot.handleUpdate(tap("junk:-100555:2:del", 999));
    assert.deepEqual(deletions, [], "stranger never drives the seam");
    assert.equal(transport.answered.at(-1)?.text, "MystoTune cards are owner-only.");

    // keep: no deletion, receipt confirms
    await bot.handleUpdate(tap("junk:-100555:2:keep"));
    assert.deepEqual(deletions, [], "Keep must not delete");
    assert.ok(transport.edits.at(-1)?.text.startsWith("🫶"), "keep receipt");

    // delete: session seam receives (chatId, [msgId]) and the recipe reports
    await bot.handleUpdate(tap("junk:-100555:2:del"));
    assert.deepEqual(deletions, [{ chatId: -100555, msgIds: [2] }]);
    assert.ok(transport.edits.at(-1)?.text.startsWith("✅"), `receipt: ${transport.edits.at(-1)?.text}`);
    assert.ok(transport.edits.at(-1)?.text.includes("msg 2"));

    // malformed / unknown callback data is answered, not thrown
    await bot.handleUpdate(tap("junk:hack"));
    assert.equal(transport.answered.at(-1)?.text, "Unknown card.");

    // edit backend down → tap still answers (no hourglass) and nothing throws
    transport.failEdits = true;
    await bot.handleUpdate(tap("junk:-100555:2:del", OWNER, false));
    assert.ok(transport.answered.at(-1)?.id.startsWith("cb-"), "answered despite edit failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
