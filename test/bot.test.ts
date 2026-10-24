/** M7.11 curation bot, slice B0 (SDD-channel-curation-bot.md): junk scan,
 * review cards, owner-gated taps, and deletion via the owner-session seam —
 * all network-free (transport + deleter are injectables). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSchema, decidedReview, openDb, upsertTrack, type TrackRow } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { TEST_SECRET } from "./util.js";
import {
  botHealth,
  createCurationBot,
  dupeCardText,
  dupeGroups,
  dupeKeyboard,
  junkCardText,
  junkFindings,
  normalizeTitle,
  pickBest,
  splitTitle,
  startCurationBot,
  type BotTransport,
  type CardKeyboard,
  type Sadle,
  type ScanRow,
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
  edits: Array<{
    chatId: number;
    messageId: number;
    text: string;
    keyboard?: CardKeyboard | null;
  }> = [];
  answered: Array<{ id: string; text: string }> = [];
  failEdits = false;
  failSends = false;

  async sendCard(chatId: number, text: string, keyboard: CardKeyboard): Promise<number | null> {
    if (this.failSends) throw new Error("send backend down");
    const id = this.sentIds.shift() ?? this.cards.length + 100;
    this.cards.push({ chatId, text, keyboard });
    return id;
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: CardKeyboard | null,
  ): Promise<void> {
    if (this.failEdits) throw new Error("edit backend down");
    this.edits.push({ chatId, messageId, text, keyboard });
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
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    assert.equal(cfg.bot.enabled, true, "token + owner id => enabled");
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    upsertTrack(db, row());
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Ringtone", duration: 8, size: 40_000 }));

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

/* ---------------------------------------------------- B1 duplicates */

function srow(over: Partial<ScanRow> & { msgId: number }): ScanRow {
  return {
    id: `tg_n-100555_${over.msgId}`,
    chatId: -100555,
    title: "Away",
    artist: null,
    duration: 200,
    mime: "audio/mpeg",
    size: 3_000_000,
    bitrateKbps: 128,
    lossless: 0,
    ...over,
  } as ScanRow;
}

test("B1 pure v2: splitTitle/versionKey, copy-vs-variant tiers, deterministic keeper", () => {
  assert.equal(normalizeTitle("Away (Official Video) [Remaster]"), "away");
  assert.equal(normalizeTitle("Stayin' Alive — Feat. Somebody"), "stayin alive");
  assert.deepEqual(splitTitle("Away (Official Video) [Remaster]"), {
    base: "away",
    extras: "official video remaster",
  });
  assert.deepEqual(splitTitle("Stayin' Alive — Feat. Somebody"), {
    base: "stayin alive",
    extras: "somebody",
  });
  assert.deepEqual(splitTitle("Song - Extended Mix"), { base: "song", extras: "extended mix" });
  assert.deepEqual(splitTitle("Song"), { base: "song", extras: "" });

  const groups = dupeGroups([
    srow({ msgId: 2, size: 100 }), // "Away" — base cluster {2,3}; byte twin bridges {7}
    srow({ msgId: 3, size: 200, title: "away (feat. x)" }), // different version → variant tier
    srow({ msgId: 4, artist: "DJ K" }), // different artist → own cluster, alone
    srow({ msgId: 5, size: 500, title: "Alpha" }), // byte twins {5,6} → copies
    srow({ msgId: 6, size: 500, title: "Beta" }),
    srow({ msgId: 7, size: 100, title: "Gamma", lossless: 1 }), // byte twin of 2 → same chain
    srow({ msgId: 8, size: 900, title: "Gamma" }), // same gamma version+dur → joins the chain
    srow({ msgId: 9, size: 0 }), // zero-size rows are the junk sweep's job, not dupes
    srow({ msgId: 10, chatId: -100777, size: 100 }), // per-chat isolation, alone
  ]);
  assert.deepEqual(groups.map((g) => g.id), ["dupe:-100555:6:5", "dupe:-100555:7:2"]);
  assert.equal(groups[0]!.kind, "copies", "byte twins are always copies");
  assert.equal(
    groups[1]!.kind,
    "variant",
    "same song with a (feat. x) version + unmatched takes = variant, not dupes",
  );
  assert.deepEqual(
    groups[1]!.members.map((r) => r.msgId),
    [2, 3, 7, 8],
    "both rules union into one cluster (one card, not two)",
  );
  assert.deepEqual(groups[0]!.members.map((r) => r.msgId), [5, 6]);
  assert.equal(groups[1]!.best.msgId, 7, "lossless wins over size");
  assert.equal(pickBest(groups[0]!.members).msgId, 6, "size tie → newest message wins");
  const card = dupeCardText(groups[1]!);
  assert.ok(card.includes("Versions of one song (4)"));
  assert.ok(card.includes("★ #3 “Gamma”"), "keeper starred with its copy number");
  assert.ok(card.includes("feat x"), "each copy shows its own version annotation");
  const copyCard = dupeCardText(groups[0]!);
  assert.ok(copyCard.includes("Duplicate copies (2)"), "copies tier keeps the actionable wording");
  const kb = dupeKeyboard(groups[1]!);
  assert.deepEqual(
    kb.buttons.map((row) => row.map((b) => b.data)),
    [
      ["dupe:-100555:2:del", "dupe:-100555:3:del"],
      ["dupe:-100555:7:del", "dupe:-100555:8:del"],
      ["dupe:-100555:7:2:keep"],
    ],
    "variants get per-copy delete + keep-all, never a mass-delete button",
  );
});

test("B1 end-to-end v2: variant card pushes per-copy buttons; tapped copy deletes; set settles", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot3-"));
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    upsertTrack(db, row({ size: 5_000_000 })); // healthy — distinct size so twin rule leaves it alone
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Away", size: 3_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_3", msgId: 3, title: "Away (feat. X)", size: 4_000_000 }));

    const transport = new FakeTransport();
    const deletions: Array<{ chatId: number; msgIds: number[] }> = [];
    const deleter: Sadle = async (chatId, msgIds) => {
      deletions.push({ chatId, msgIds });
      return { deleted: msgIds.length };
    };
    const bot = createCurationBot({ cfg, db, deleter, transport, log: () => undefined });

    assert.equal(await bot.sweep(), 1, "one variant card, no junk overlap");
    const card = transport.cards[0]!;
    assert.ok(card.text.startsWith("🎵 Versions of one song (2)"), "feat-X is a version, not a dupe");
    assert.ok(card.text.includes("#2 “Away (feat. X)”"), "every copy shows its own title");
    assert.deepEqual(
      card.keyboard.buttons.map((r) => r.map((b) => b.data)),
      [["dupe:-100555:2:del", "dupe:-100555:3:del"], ["dupe:-100555:3:2:keep"]],
      "per-copy delete buttons + keep-all; never a mass-delete row on variants",
    );

    await bot.sweep();
    assert.equal(transport.cards.length, 1, "re-sweep does not re-push (restart-only memory)");

    // per-copy delete: only the tapped copy goes away; the card self-edits
    await bot.handleUpdate(tap("dupe:-100555:2:del"));
    assert.deepEqual(deletions, [{ chatId: -100555, msgIds: [2] }]);
    const edit = transport.edits.at(-1)!;
    assert.ok(edit.text.startsWith("✅"), "the card shows the settled state");
    assert.ok(edit.text.includes("msg 3 stays"), "remaining copy acknowledged");
    assert.equal(edit.keyboard, null, "keyboard cleared once the set is decided");

    await bot.handleUpdate(tap("dupe:-100555:3:2:keep"));
    assert.equal(deletions.length, 1, "keep tap deletes nothing");
    // the purge already dropped msg 2 from the index, so only one "copy" is
    // left — nothing forms a set anymore: the old card answers gracefully
    assert.ok(transport.edits.at(-1)?.text.startsWith("🫥"), "set already settled — nothing to keep");

    await bot.handleUpdate(tap("dupe:-100555:9:8:del"));
    assert.ok(transport.edits.at(-1)?.text.startsWith("🫥"), "vanished group receipt");
    assert.equal(transport.answered.at(-1)?.text, "Nothing left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1 copies e2e: byte-twin set per-copy deletes down to one, then records the set", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot3b-"));
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    // three byte-identical uploads (same mime + size) → copies tier
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Away", size: 3_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_3", msgId: 3, title: "Away (Re-up)", size: 3_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_4", msgId: 4, title: "AWAY again", size: 3_000_000 }));

    const transport = new FakeTransport();
    const deletions: Array<{ chatId: number; msgIds: number[] }> = [];
    const deleter: Sadle = async (chatId, msgIds) => {
      deletions.push({ chatId, msgIds });
      return { deleted: msgIds.length };
    };
    const bot = createCurationBot({ cfg, db, deleter, transport, log: () => undefined });
    assert.equal(await bot.sweep(), 1);
    const card = transport.cards[0]!;
    assert.ok(card.text.startsWith("👯 Duplicate copies (3)"));
    assert.deepEqual(
      card.keyboard.buttons[0]!.map((b) => b.data),
      ["dupe:-100555:2:del", "dupe:-100555:3:del"],
    );

    // tap #1 → card re-renders with 2 remaining copies and fresh buttons
    await bot.handleUpdate(tap("dupe:-100555:2:del"));
    assert.deepEqual(deletions.at(-1), { chatId: -100555, msgIds: [2] });
    // M7.14: the deleted copy's index row is purged immediately, not "next sync"
    const msg2Rows = db
      .prepare("SELECT COUNT(*) AS n FROM tracks WHERE chatId = ? AND msgId = ?")
      .get(-100555, 2) as unknown as { n: number };
    assert.equal(msg2Rows.n, 0, "deleted copy's index row purged on tap");
    const edit1 = transport.edits.at(-1)!;
    assert.ok(edit1.text.includes("Duplicate copies (2)"), "card self-edits");
    assert.equal(
      edit1.keyboard?.buttons.flat().map((b) => b.data).includes("dupe:-100555:2:del"),
      false,
      "deleted copy's button gone",
    );

    // tap the next copy → one left → the set records "delete" (no re-ask)
    await bot.handleUpdate(tap("dupe:-100555:3:del"));
    assert.deepEqual(deletions.at(-1), { chatId: -100555, msgIds: [3] });
    assert.equal(
      decidedReview(db, "dupe:-100555:4:3"),
      "delete",
      "set finalized under its review id once a single copy remains (purged copies leave the recomputed id)",
    );
    // the settled card cleared its keyboard — a stale per-copy tap retried
    // against the live index is answered harmlessly (index lags reality)
    await bot.handleUpdate(tap("dupe:-100555:4:del"));
    assert.deepEqual(deletions.at(-1), { chatId: -100555, msgIds: [4] });
    assert.ok(transport.answered.at(-1)?.id.startsWith("cb-"), "spinner always stops");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------- gate-2 remediation regressions */

test("gate-2: both-rules pair yields exactly ONE card; budget caps junk-first; dead senders retire", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot5-"));
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    // C1: identical title AND identical size/mime → both rules, one card
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Echo", size: 3_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_3", msgId: 3, title: "Echo (feat. X)", size: 3_000_000 }));
    const transport = new FakeTransport();
    const bot = createCurationBot({ cfg, db, deleter: async () => ({ deleted: 0 }), transport, log: () => undefined });
    assert.equal(await bot.sweep(), 1, "both rules → one card, not two");
    assert.equal(transport.cards[0]!.text.startsWith("👯"), true);
    await bot.sweep();
    assert.equal(transport.cards.length, 1, "re-sweep stays quiet");

    // budget: 12 junk + 2 dupe pairs → 10 cards total, junk capped, dupes never starve
    const db2 = openDb(path.join(dir, "j.sqlite"));
    createSchema(db2);
    for (let i = 1; i <= 12; i++) {
      upsertTrack(db2, row({
        id: `tg_n-100555_${i}`,
        msgId: i,
        title: `Clip ${i}`,
        duration: 5,
        size: 100_000 * i + 50_000, // distinct sizes: no accidental dupe rules
      }));
    }
    for (const [msg, size] of [[30, 2_000_000], [31, 2_100_000]] as Array<[number, number]>) {
      upsertTrack(db2, row({
        id: `tg_n-100555_${msg}`,
        msgId: msg,
        title: size === 2_000_000 ? "Same Name" : "Other Name",
        artist: "The Band",
        size,
      }));
      upsertTrack(db2, row({
        id: `tg_n-100555_${msg + 10}`,
        msgId: msg + 10,
        title: size === 2_000_000 ? "Same Name (feat. x)" : "Other Name (feat. x)",
        artist: "The Band",
        size,
      }));
    }
    const transport2 = new FakeTransport();
    const bot2 = createCurationBot({
      cfg,
      db: db2,
      deleter: async () => ({ deleted: 0 }),
      transport: transport2,
      log: () => undefined,
    });
    assert.equal(await bot2.sweep(), 10, "budget caps the sweep at 10");
    assert.equal(transport2.cards.filter((c) => c.text.startsWith("🗑")).length, 8, "junk capped");
    assert.equal(transport2.cards.filter((c) => c.text.startsWith("👯")).length, 2, "dupes never starve");

    // dead-letter: an always-throwing transport retires the card after 3 sweeps
    const db3 = openDb(path.join(dir, "k.sqlite"));
    createSchema(db3);
    upsertTrack(db3, row({ id: "tg_n-100555_7", msgId: 7, title: "Ringtone", duration: 8, size: 40_000 }));
    const stale = new FakeTransport();
    stale.failSends = true;
    const bot3 = createCurationBot({
      cfg,
      db: db3,
      deleter: async () => ({ deleted: 0 }),
      transport: stale,
      log: () => undefined,
    });
    await bot3.sweep(); // attempt 1
    await bot3.sweep(); // attempt 2
    assert.equal(stale.cards.length, 0, "failed sends never surface cards");
    await bot3.sweep(); // attempt 3 → dead-letter retires the card
    stale.failSends = false;
    assert.equal(await bot3.sweep(), 0, "retired card does not re-push once delivery recovers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate-2: malformed BOT_TOKEN fails config; junk allowed ids never enable", () => {
  assert.throws(() => baseEnv({ BOT_TOKEN: "not-a-token" }), /malformed/);
  const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: "1e3,-2" });
  assert.equal(cfg.bot.enabled, false, "non-digit ids are filtered, not coerced");
  assert.deepEqual(cfg.bot.allowedIds, []);
});

test("gate-2: standby replicas sweep nothing until promoted to active", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot6-"));
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Ringtone", duration: 8, size: 40_000 }));
    let activeNow = false;
    const bot = createCurationBot({
      cfg,
      db,
      deleter: async () => ({ deleted: 0 }),
      transport: new FakeTransport(),
      log: () => undefined,
      active: () => activeNow,
    });
    assert.equal(await bot.sweep(), 0, "standby sweeps nothing");
    activeNow = true;
    assert.equal(await bot.sweep(), 1, "promoted to active → sweeps");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- B2 durable review memory */

test("B2 durable: keep + successful delete decisions survive a fresh bot over the same database", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot4-"));
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    upsertTrack(db, row({ size: 5_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_2", msgId: 2, title: "Ringtone", duration: 8, size: 40_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_3", msgId: 3, title: "Away", size: 3_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_4", msgId: 4, title: "Away (feat. X)", size: 4_000_000 }));
    upsertTrack(db, row({ id: "tg_n-100555_5", msgId: 5, title: "Rung 2", duration: 7, size: 20_000 }));

    // the session seam fails only for msg 5 (simulates a transient telegram outage)
    const deletions: Array<{ chatId: number; msgIds: number[] }> = [];
    const deleter: Sadle = async (chatId, msgIds) => {
      deletions.push({ chatId, msgIds });
      return msgIds.includes(5) ? { deleted: 0, error: "telegram 420" } : { deleted: msgIds.length };
    };
    const bot1 = createCurationBot({
      cfg,
      db,
      deleter,
      transport: new FakeTransport(),
      log: () => undefined,
    });
    assert.equal(await bot1.sweep(), 3, "two junk cards + one dupe card");

    await bot1.handleUpdate(tap("junk:-100555:2:keep"));
    await bot1.handleUpdate(tap("dupe:-100555:3:del")); // v2: per-copy (variants refuse mass-delete)
    await bot1.handleUpdate(tap("junk:-100555:5:del"));
    assert.equal(deletions.length, 2, "the failed msg-5 delete never reaches the fake twice");

    assert.equal(decidedReview(db, "junk:-100555:2"), "keep", "junk keep recorded");
    assert.equal(decidedReview(db, "dupe:-100555:4:3"), "delete", "dupe delete recorded");
    assert.equal(decidedReview(db, "junk:-100555:5"), null, "failed delete stays undecided");

    // a brand-new process over the SAME database: only the undecided card returns
    const transport2 = new FakeTransport();
    const bot2 = createCurationBot({ cfg, db, deleter, transport: transport2, log: () => undefined });
    assert.equal(await bot2.sweep(), 1, "only the failed-delete junk re-asks");
    assert.ok(transport2.cards[0]?.text.includes("Rung 2"), "the right card came back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------ B5: event-driven sweeps */

const sleepB5 = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("B5 event-driven: new-row notifications trigger a trailing, coalesced sweep", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m-bot5-"));
  let bot: NonNullable<ReturnType<typeof startCurationBot>> | null = null;
  try {
    const cfg = baseEnv({ BOT_TOKEN: "123:AAAAAAAAAAAAAAAAAAAA", BOT_ALLOWED_IDS: `${OWNER}` });
    const db = openDb(path.join(dir, "i.sqlite"));
    createSchema(db);
    upsertTrack(db, row()); // healthy row — the index is clean

    const transport = new FakeTransport();
    bot = startCurationBot({
      cfg,
      db,
      deleter: async () => ({ deleted: 0 }),
      transport, // gate-2 M7 seam: no real BotApi, no network
      log: () => undefined,
      eventDelayMs: 10, // B5 test seam: 15 s default is unusable in tests
    })!;
    assert.equal(botHealth.running, true, "active(Long-poll) router starts"); // sanity: router alive

    // clean index: event fires, sweep scans, nothing is pushed
    bot.notifyNewRows(5);
    await sleepB5(80);
    assert.equal(transport.cards.length, 0, "clean index pushes no cards");

    // junk lands → one event → one card after the trailing delay
    upsertTrack(
      db,
      row({ id: "tg_n-100555_9", msgId: 9, title: "Voice 1", duration: 6, size: 30_000 }),
    );
    bot.notifyNewRows(1);
    await sleepB5(120);
    assert.equal(transport.cards.length, 1, "new junk gets curated by the event sweep");
    assert.ok(transport.cards[0]!.text.includes("Voice 1"));

    // burst: three rapid notifications coalesce into ONE more sweep; the
    // asked-memory keeps the same junk from re-appearing as a second card
    bot.notifyNewRows(1);
    bot.notifyNewRows(3);
    bot.notifyNewRows(1);
    await sleepB5(120);
    assert.equal(transport.cards.length, 1, "bursts coalesce; asked memory blocks re-push");

    assert.ok(botHealth.lastSweepAt > 0, "event sweeps update bot health");
  } finally {
    bot?.stop(); // clears any pending event timer
    rmSync(dir, { recursive: true, force: true });
  }
});
