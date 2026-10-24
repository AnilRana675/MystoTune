/**
 * MystoTune curation bot (docs/SDD-channel-curation-bot.md, v0.2): a
 * zero-command owner janitor. It sweeps the index automatically, pushes
 * review cards (junk candidates; duplicate groups come in B1), and executes
 * button-driven deletions through the OWNER user session — never on its own.
 *
 * Design laws carried over from the addon: additive + optional (disabled
 * without BOT_TOKEN and BOT_ALLOWED_IDS), boot never depends on it (§4.11
 * rule 3), zero new npm deps (raw fetch against the Bot API), and all scan
 * functions are pure so tests stay network-free.
 */
import type { AppConfig } from "./config";
import type { Database } from "better-sqlite3";

/* ------------------------------------------------------------------ types */

/** The columns the scanners need (subset of TrackRow). */
export interface ScanRow {
  id: string;
  chatId: number;
  msgId: number;
  title: string;
  artist: string | null;
  duration: number | null;
  mime: string | null;
  size: number | null;
  bitrateKbps: number | null;
  lossless: number;
}

export interface JunkFinding {
  id: string; // stable: `junk:{chatId}:{msgId}`
  row: ScanRow;
  why: string; // human reasons, e.g. "12 s · 24 kbps"
}

/** Result of the owner-session delete call (telegram.ts). */
export type DeleteResult = { deleted: number; error?: string };
export type Sadle = (chatId: number, msgIds: number[]) => Promise<DeleteResult>;

export interface CardButton {
  text: string; // display label
  data: string; // callback_data (≤64 bytes)
}

export interface CardKeyboard {
  buttons: CardButton[][];
}

/** Transport the router talks through (real = Bot API over fetch; tests fake it). */
export interface BotTransport {
  /** Returns the Telegram message id of the sent card (null if unknown). */
  sendCard(chatId: number, text: string, keyboard: CardKeyboard): Promise<number | null>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
  /** Always answer taps so Telegram stops the client-side spinner. */
  answerCallback(callbackId: string, text: string): Promise<void>;
}

export interface TelegramUpdate {
  update_id?: number;
  callback_query?: {
    id: string;
    from?: { id?: number };
    data?: string;
    message?: { message_id?: number; chat?: { id?: number } };
  };
}

/* ------------------------------------------------------- pure scan (unit-tested) */

const JUNK_TITLE_RE = /^(?:audio|track|rec(?:ording)?|voice ?(?:msg|message)?)\s*\d*$/i;

/** SDD §3 v1 junk signals: too short, too low bitrate, empty file, junk title. */
export function junkFindings(rows: ScanRow[]): JunkFinding[] {
  const out: JunkFinding[] = [];
  for (const r of rows) {
    const why: string[] = [];
    if (r.duration !== null && r.duration < 15) why.push(`${r.duration} s`);
    if (r.bitrateKbps !== null && r.bitrateKbps > 0 && r.bitrateKbps < 48) why.push(`${r.bitrateKbps} kbps`);
    if (r.size === null || r.size <= 0) why.push("0 B");
    if (JUNK_TITLE_RE.test(r.title.trim())) why.push("placeholder title");
    if (why.length > 0) out.push({ id: `junk:${r.chatId}:${r.msgId}`, row: r, why: why.join(" · ") });
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

/** Plain-text card body (no Markdown — Telegram parse surprises stay out). */
export function junkCardText(r: ScanRow, why: string): string {
  const bits: string[] = [];
  if (r.duration !== null) bits.push(`${r.duration} s`);
  if (r.size !== null && r.size > 0) bits.push(fmtBytes(r.size));
  if (r.mime !== null) bits.push(r.mime);
  return [
    "🗑 Junk candidate",
    `Title: ${r.title}`,
    `Artist: ${r.artist ?? "—"}`,
    `Where: chat ${r.chatId} · msg ${r.msgId}`,
    `Why: ${why || "flagged"}${bits.length > 0 ? ` (${bits.join(" · ")})` : ""}`,
    "",
    "Delete removes the message from your channel via your own logged-in session.",
  ].join("\n");
}

function junkRowFromDb(row: Record<string, unknown>): ScanRow {
  return {
    id: String(row.id),
    chatId: Number(row.chatId),
    msgId: Number(row.msgId),
    title: String(row.title),
    artist: row.artist === null ? null : String(row.artist),
    duration: row.duration === null ? null : Number(row.duration),
    mime: row.mime === null ? null : String(row.mime),
    size: row.size === null ? null : Number(row.size),
    bitrateKbps: row.bitrateKbps === null ? null : Number(row.bitrateKbps),
    lossless: Number(row.lossless),
  };
}

/* ------------------------------------------------------------------ bot core */

const MAX_CARDS_PER_SWEEP = 10; // courtesy cap: never flood the owner

export interface CurationBot {
  sweep(): Promise<number>; // cards pushed
  handleUpdate(update: TelegramUpdate): Promise<void>;
  stop(): void;
}

export interface CurationDeps {
  cfg: AppConfig;
  db: Database;
  deleter: Sadle;
  transport: BotTransport;
  log: (line: string) => void;
}

export function createCurationBot(deps: CurationDeps): CurationBot {
  const { cfg, db, deleter, transport, log } = deps;
  const allowed = new Set(cfg.bot.allowedIds);
  const ownerChat = cfg.bot.allowedIds[0] as number;
  /** Cards pushed this process — pending answers re-ask after a restart (§5). */
  const asked = new Set<string>();

  async function sweep(): Promise<number> {
    if (!cfg.bot.enabled) return 0;
    const rows = db
      .prepare(
        "SELECT id, chatId, msgId, title, artist, duration, mime, size, bitrateKbps, lossless FROM tracks",
      )
      .all() as Array<Record<string, unknown>>;
    const findings = junkFindings(rows.map(junkRowFromDb)).filter((f) => !asked.has(f.id));
    let pushed = 0;
    for (const f of findings.slice(0, MAX_CARDS_PER_SWEEP)) {
      if (asked.has(f.id)) continue; // a capslice seen while sending still counts as asked
      asked.add(f.id);
      try {
        const messageId = await transport.sendCard(ownerChat, junkCardText(f.row, f.why), {
          buttons: [[
            { text: `Delete msg ${f.row.msgId}`, data: `junk:${f.row.chatId}:${f.row.msgId}:del` },
            { text: "Keep", data: `junk:${f.row.chatId}:${f.row.msgId}:keep` },
          ]],
        });
        if (messageId === null) asked.delete(f.id); // unknown delivery — retry next sweep
        else pushed += 1;
      } catch (e) {
        asked.delete(f.id); // failed sends retry on the next sweep
        log(`bot: failed to push junk card (${(e as Error).message})`);
      }
    }
    if (pushed > 0) log(`bot: sweep pushed ${pushed} junk card(s)`);
    return pushed;
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const cb = update.callback_query;
    if (!cb) return; // zero commands: text updates are ignored outright
    const fromId = cb.from?.id;
    const data = cb.data ?? "";
    if (fromId === undefined || !allowed.has(fromId)) {
      await transport.answerCallback(cb.id, "MystoTune cards are owner-only.");
      return;
    }
    const m = /^junk:(-?\d+):(\d+):(del|keep)$/.exec(data);
    if (!m) {
      await transport.answerCallback(cb.id, "Unknown card.");
      return;
    }
    const chatId = Number(m[1]);
    const msgId = Number(m[2]);
    const choice = m[3] as "del" | "keep";
    let receipt: string;
    if (choice === "keep") {
      receipt = `🫶 Kept “${m[2]}” — will not be re-asked until the next restart.`;
    } else {
      const res = await deleter(chatId, [msgId]);
      receipt = res.error === undefined
        ? `✅ Deleted (msg ${msgId}). The next sync refreshes the index.`
        : `⚠️ Could not delete (msg ${msgId}): ${res.error} — it stays queued; the next sweep re-asks.`;
    }
    const chatT = cb.message?.chat?.id;
    const msgT = cb.message?.message_id;
    if (chatT !== undefined && msgT !== undefined) {
      try {
        await transport.editMessage(chatT, msgT, receipt);
      } catch (e) {
        log(`bot: receipt edit failed (${(e as Error).message})`);
      }
    }
    await transport.answerCallback(cb.id, choice === "keep" ? "Kept" : "Deleting…");
  }

  return { sweep, handleUpdate, stop: () => undefined };
}

/* ------------------------------------------------------ real Bot API transport */

class BotApi implements BotTransport {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(method), {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`bot ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["callback_query"],
    });
  }

  sendCard(chatId: number, text: string, keyboard: CardKeyboard): Promise<number | null> {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: keyboard.buttons.map((row) =>
          row.map((b) => ({ text: b.text, callback_data: b.data })),
        ),
      },
    }).then((r) => r?.message_id ?? null);
  }

  editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text }).then(
      () => undefined,
    );
  }

  answerCallback(callbackId: string, text: string): Promise<void> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, text }).then(
      () => undefined,
    );
  }
}

/** Long-poll router loop: pushes updates into the router with error backoff. */
export function startCurationBot(
  deps: Omit<CurationDeps, "transport">,
): CurationBot | null {
  if (!deps.cfg.bot.enabled) return null;
  const api = new BotApi(deps.cfg.bot.token);
  const bot = createCurationBot({ ...deps, transport: api });
  let stopped = false;
  let offset = 0;
  let backoffMs = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  void (async () => {
    try {
      await bot.sweep();
    } catch (e) {
      deps.log(`bot: startup sweep failed (${(e as Error).message})`);
    }
  })();

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const updates = await api.getUpdates(offset);
        backoffMs = 1000;
        for (const u of updates) {
          if (typeof u.update_id === "number" && u.update_id >= offset) offset = u.update_id + 1;
          await bot.handleUpdate(u);
        }
      } catch (e) {
        backoffMs = Math.min(backoffMs * 2, 30_000);
        deps.log(`bot: poll backoff ${backoffMs} ms (${(e as Error).message})`);
      }
      if (stopped) return;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, backoffMs); // keep the handle live for stop()
      });
    }
  };
  void loop();

  return {
    sweep: bot.sweep,
    handleUpdate: bot.handleUpdate,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
