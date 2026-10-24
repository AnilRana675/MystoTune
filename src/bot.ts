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

/* ------------------------------------------------- B1 duplicates (pure) */

/** SDD §3: lowercase, drop bracketed extras + featuring tails, punctuation
 * collapses to separators so "Away (feat. X) [Full Song]" matches "away". */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[([].*?[)\]]/g, " ")
    .replace(/\b(?:featuring|feat|ft)\b\.?.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface DupeGroup {
  /** `dupe:{chatId}:{bestMsgId}:{smallestMember}` — one row can sit in two
   * rule clusters, so best-msgId alone is not unique per card. */
  id: string;
  chatId: number;
  members: ScanRow[]; // ordered by msgId ascending
  best: ScanRow; // suggested keeper (SDD §3: lossless first, then biggest file)
}

/** Deterministic keeper: lossless wins, then largest file, then newest message. */
export function pickBest(members: ScanRow[]): ScanRow {
  return [...members].sort((a, b) => {
    if (a.lossless !== b.lossless) return b.lossless - a.lossless;
    const sa = a.size ?? 0;
    const sb = b.size ?? 0;
    if (sa !== sb) return sb - sa;
    return b.msgId - a.msgId;
  })[0] as ScanRow;
}

/** SDD §3 duplicate rules: same (artist, normalized title) OR exact
 * (mime, size) twins. Rules merge into clusters (union-find over shared
 * rows) so a pair matching both rules yields ONE card, not two. */
export function dupeGroups(rows: ScanRow[]): DupeGroup[] {
  const byChat = new Map<number, ScanRow[]>();
  for (const r of rows) {
    if (r.size === null || r.size <= 0) continue; // unparseable sizes belong to the junk sweep
    const list = byChat.get(r.chatId) ?? [];
    list.push(r);
    byChat.set(r.chatId, list);
  }
  const out: DupeGroup[] = [];
  for (const [chatId, list] of byChat) {
    const clusters: Array<{ seen: Set<string>; rows: ScanRow[] }> = [];
    // place a row into the cluster owning its key; merge clusters sharing it
    const addTo = (key: string, r: ScanRow): void => {
      const hits = clusters.filter((c) => c.seen.has(key));
      if (hits.length === 0) {
        clusters.push({ seen: new Set([key]), rows: [r] });
        return;
      }
      const first = hits[0] as { seen: Set<string>; rows: ScanRow[] };
      if (!first.rows.includes(r)) first.rows.push(r);
      for (const extra of hits.slice(1)) {
        for (const rr of extra.rows) if (!first.rows.includes(rr)) first.rows.push(rr);
        for (const k of extra.seen) first.seen.add(k);
        clusters.splice(clusters.indexOf(extra), 1);
      }
    };
    for (const r of list) {
      addTo(`t:${r.artist ?? ""}|${normalizeTitle(r.title)}`, r);
      addTo(`s:${r.mime ?? ""}|${r.size}`, r);
    }
    for (const c of clusters) {
      if (c.rows.length < 2) continue;
      c.rows.sort((a, b) => a.msgId - b.msgId);
      const best = pickBest(c.rows);
      const min = c.rows[0]?.msgId;
      out.push({
        id: `dupe:${chatId}:${best.msgId}:${min}`,
        chatId,
        members: c.rows,
        best,
      });
    }
  }
  return out.sort((a, b) => a.chatId - b.chatId || a.best.msgId - b.best.msgId);
}

/** Plain-text card body: members listed, keeper starred. */
export function dupeCardText(g: DupeGroup): string {
  return [
    `👯 Duplicate set (${g.members.length} copies)`,
    `Title: ${g.best.title}`,
    `Artist: ${g.best.artist ?? "—"}`,
    "",
    ...g.members.map((r) =>
      `${r.msgId === g.best.msgId ? "★" : "·"} msg ${r.msgId} · ${fmtBytes(r.size ?? 0)} · ${r.mime ?? "?"}${r.lossless === 1 ? " · lossless" : ""}`,
    ),
    "",
    "Delete removes the other copies from your channel via your own logged-in session.",
  ].join("\n");
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

  const scanRows = (): ScanRow[] =>
    (
      db
        .prepare(
          "SELECT id, chatId, msgId, title, artist, duration, mime, size, bitrateKbps, lossless FROM tracks",
        )
        .all() as Array<Record<string, unknown>>
    ).map(junkRowFromDb);

  async function sweep(): Promise<number> {
    if (!cfg.bot.enabled) return 0;
    const rows = scanRows();
    const findings = junkFindings(rows).filter((f) => !asked.has(f.id));
    const groups = dupeGroups(rows).filter((g) => !asked.has(g.id));
    let junk = 0;
    let dupes = 0;
    for (const f of findings.slice(0, MAX_CARDS_PER_SWEEP)) {
      if (asked.has(f.id)) continue; // a cap slice seen while sending still counts as asked
      asked.add(f.id);
      try {
        const messageId = await transport.sendCard(ownerChat, junkCardText(f.row, f.why), {
          buttons: [[
            { text: `Delete msg ${f.row.msgId}`, data: `junk:${f.row.chatId}:${f.row.msgId}:del` },
            { text: "Keep", data: `junk:${f.row.chatId}:${f.row.msgId}:keep` },
          ]],
        });
        if (messageId === null) asked.delete(f.id); // unknown delivery — retry next sweep
        else junk += 1;
      } catch (e) {
        asked.delete(f.id); // failed sends retry on the next sweep
        log(`bot: failed to push junk card (${(e as Error).message})`);
      }
    }
    // B1: duplicate sets after junk, sharing the sweep budget
    for (const g of groups) {
      if (junk + dupes >= MAX_CARDS_PER_SWEEP) break;
      asked.add(g.id);
      try {
        const messageId = await transport.sendCard(ownerChat, dupeCardText(g), {
          buttons: [[
            {
              text: `Delete others (keep msg ${g.best.msgId})`,
              data: `dupe:${g.chatId}:${g.best.msgId}:${g.members[0]?.msgId}:del`,
            },
            { text: "Keep all", data: `dupe:${g.chatId}:${g.best.msgId}:${g.members[0]?.msgId}:keep` },
          ]],
        });
        if (messageId === null) asked.delete(g.id);
        else dupes += 1;
      } catch (e) {
        asked.delete(g.id);
        log(`bot: failed to push dupe card (${(e as Error).message})`);
      }
    }
    if (junk + dupes > 0) {
      log(`bot: sweep pushed ${junk} junk card(s) and ${dupes} dupe card(s)`);
    }
    return junk + dupes;
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
    const junkM = /^junk:(-?\d+):(\d+):(del|keep)$/.exec(data);
    const dupeM = /^dupe:(-?\d+):(\d+):(\d+):(del|keep)$/.exec(data);
    if (!junkM && !dupeM) {
      await transport.answerCallback(cb.id, "Unknown card.");
      return;
    }
    const chatId = Number(junkM?.[1] ?? dupeM?.[1]);
    const msgId = Number(junkM?.[2] ?? dupeM?.[2]); // junk: target msg · dupe: best msg
    const choice = (junkM ? junkM[3] : dupeM?.[4]) as "del" | "keep";
    let receipt: string;
    let answer = choice === "keep" ? "Kept" : "Deleting…";
    if (!dupeM) {
      if (choice === "keep") {
        receipt = `🫶 Kept “${msgId}” — will not be re-asked until the next restart.`;
      } else {
        const res = await deleter(chatId, [msgId]);
        receipt = res.error === undefined
          ? `✅ Deleted (msg ${msgId}). The next sync refreshes the index.`
          : `⚠️ Could not delete (msg ${msgId}): ${res.error} — it stays queued; the next sweep re-asks.`;
      }
    } else {
      // B1: recompute groups at tap time — the index may have moved; stateless.
      const dupeMin = Number(dupeM?.[3]);
      const group = dupeGroups(scanRows()).find(
        (g) => g.id === `dupe:${chatId}:${msgId}:${dupeMin}`,
      );
      if (!group) {
        receipt = `🫥 No duplicate set left (msg ${msgId}) — maybe already handled.`;
        answer = "Nothing left";
      } else if (choice === "keep") {
        receipt = `🫶 Kept the whole set — msg ${group.best.msgId} stays.`;
      } else {
        const others = group.members.map((r) => r.msgId).filter((id) => id !== group.best.msgId);
        const res = await deleter(chatId, others);
        receipt = res.error === undefined
          ? `✅ Deleted ${res.deleted} other cop${res.deleted === 1 ? "y" : "ies"} — kept msg ${group.best.msgId} (★). The next sync refreshes the index.`
          : `⚠️ Could not delete: ${res.error} — tap Delete others again to retry.`;
      }
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
    await transport.answerCallback(cb.id, answer);
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
