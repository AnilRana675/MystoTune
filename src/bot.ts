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
import { decidedReview, recordReview } from "./db";

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
  /** Edits card text. `keyboard` undefined = leave markup intact (receipts);
   * null = clear the inline keyboard (finished cards). */
  editMessage(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: CardKeyboard | null,
  ): Promise<void>;
  /** Always answer taps so Telegram stops the client-side spinner. */
  answerCallback(callbackId: string, text: string): Promise<void>;
  /** Router-only: the long-poll update source. Real = BotApi; fakes may omit
   * it (the loop then just idles without updates) to stay network-free. */
  getUpdates?(offset: number): Promise<TelegramUpdate[]>;
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

/** gate-2 L3: attacker-influenced strings never blow the 4096 send cap. */
const clamp = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Plain-text card body (no Markdown — Telegram parse surprises stay out). */
export function junkCardText(r: ScanRow, why: string): string {
  const bits: string[] = [];
  if (r.duration !== null) bits.push(`${r.duration} s`);
  if (r.size !== null && r.size > 0) bits.push(fmtBytes(r.size));
  if (r.mime !== null) bits.push(r.mime);
  return [
    "🗑 Junk candidate",
    `Title: ${clamp(r.title)}`,
    `Artist: ${r.artist === null ? "—" : clamp(r.artist)}`,
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

/** DJ-style trailing version markers; dash-form titles only ("Song - Extended
 * Mix"). Bracket-form extras are captured wholesale, so no list needed there. */
const DASH_VERSION_RE =
  /(?:remix|extended|radio|live|acoustic|instrumental|cover|remaster|nightcore|slowed|sped|lo-fi|lofi|bootleg|vip|karaoke|bass|boosted|edit|mix|version|explicit|clean|club|dub|flip|cut)/i;

/** M7.13 v2 (SDD §3): split a raw Telegram title into the song identity and
 * its version annotation. "Away (feat. X) [HQ] - Extended Mix" →
 * base "away", extras "feat x hq extended mix". Two files are the SAME
 * recording only when both parts match (plus duration) — a remix is never
 * a duplicate of the original. */
export function splitTitle(raw: string): { base: string; extras: string } {
  let rest = String(raw ?? "");
  const parts: string[] = [];
  rest = rest.replace(/[([{]([^)\]}]*)[)\]}]/g, (_m: string, inner: string) => {
    parts.push(inner); // the CONTENT, not the brackets — normalizeTitle would eat both
    return " "; // keep spacing so base text around brackets stays separated
  });
  const ft = /(?:\bfeaturing\b|\bfeats?\b|\bft\b)[.:\s]+(.+)$/i.exec(rest);
  if (ft?.[1] !== undefined) {
    parts.push(ft[1]);
    rest = rest.slice(0, ft.index);
  } else {
    const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(rest);
    if (dash?.[2] !== undefined && DASH_VERSION_RE.test(dash[2])) {
      parts.push(dash[2]);
      rest = dash[1] ?? rest;
    }
  }
  return { base: normalizeTitle(rest), extras: normLoose(parts.join(" ")) };
}

/** normalizeTitle minus the feat-tail stripper — the extras text IS the feat
 * annotation; stripping it would collapse every "(feat. X)" back to "". */
const normLoose = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Durations this close read as the same take (radio edits usually shorter).
 * Telegram audio always carries a duration; null is metadata damage. */
const DURATION_SAME_SEC = 3;

/** Same-take proof: byte-identical uploads (mime+size, any titles), or same
 * base + same version annotation + near-equal duration. */
export function sameTake(a: ScanRow, b: ScanRow): boolean {
  if ((a.mime ?? "") === (b.mime ?? "") && a.size !== null && a.size === b.size) return true;
  const { extras: ea } = splitTitle(a.title);
  const { extras: eb } = splitTitle(b.title);
  if (ea !== eb) return false;
  if (a.duration === null && b.duration === null) return true;
  if (a.duration === null || b.duration === null) return false;
  return Math.abs(a.duration - b.duration) <= DURATION_SAME_SEC;
}

export interface DupeGroup {
  /** `dupe:{chatId}:{bestMsgId}:{smallestMember}` — stable review id (old
   * cards' bulk buttons and tap-time recompute both key on this). */
  id: string;
  chatId: number;
  /** M7.13 v2: "copies" = same recording (byte twins / same version+dur);
   * "variant" = same song, different recording (remix/feat/live) — per-copy
   * delete only, never mass-delete. */
  kind: "copies" | "variant";
  members: ScanRow[]; // ordered by msgId ascending
  best: ScanRow; // keeper hint (lossless first); for variants: quality pick
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

/** SDD §3 v2: cluster by artist + base title, bridged by byte-twin uploads
 * (same mime+size). Inside a cluster, `sameTake` chains tell real duplicates
 * (one chain → kind "copies") from version variants (≥2 chains → kind
 * "variant": same song, remix/feat/live recordings — safe, per-copy only).
 * Outer clustering stays the O(1) key→cluster union (gate-2). */
export function dupeGroups(rows: ScanRow[]): DupeGroup[] {
  const byChat = new Map<number, ScanRow[]>();
  for (const r of rows) {
    if (r.size === null || r.size <= 0) continue; // unparseable sizes belong to the junk sweep
    const list = byChat.get(r.chatId) ?? [];
    list.push(r);
    byChat.set(r.chatId, list);
  }
  const out: DupeGroup[] = [];
  const fmtGroup = (chatId: number, rows: ScanRow[], kind: "copies" | "variant"): DupeGroup => {
    const best = pickBest(rows);
    return {
      id: `dupe:${chatId}:${best.msgId}:${rows[0]?.msgId}`,
      chatId,
      kind,
      members: rows,
      best,
    };
  };
  for (const [chatId, list] of byChat) {
    interface Cluster {
      seen: Set<string>;
      rows: ScanRow[];
    }
    const clusters: Cluster[] = [];
    const owner = new Map<string, Cluster>();
    for (const r of list) {
      const { base } = splitTitle(r.title);
      const tk = `t:${r.artist ?? ""}|${base}`;
      const sk = `s:${r.mime ?? ""}|${r.size}`;
      const tC = owner.get(tk);
      const sC = owner.get(sk);
      if (tC && sC && tC !== sC) {
        // both-rule row bridges two clusters → union sC into tC
        for (const rr of sC.rows) if (!tC.rows.includes(rr)) tC.rows.push(rr);
        for (const k of sC.seen) owner.set(k, tC);
        clusters.splice(clusters.indexOf(sC), 1);
      }
      const home = tC ?? sC;
      if (home) {
        home.seen.add(tk);
        home.seen.add(sk);
        owner.set(tk, home);
        owner.set(sk, home);
        if (!home.rows.includes(r)) home.rows.push(r);
      } else {
        const fresh: Cluster = { seen: new Set([tk, sk]), rows: [r] };
        clusters.push(fresh);
        owner.set(tk, fresh);
        owner.set(sk, fresh);
      }
    }
    for (const c of clusters) {
      if (c.rows.length < 2) continue;
      // same-take chains within this (small) cluster — pair scan is fine
      const parent = new Map<number, number>();
      for (let i = 0; i < c.rows.length; i++) parent.set(i, i);
      const find = (x: number): number => {
        let cur = x;
        while (parent.get(cur) !== cur) cur = parent.get(cur) as number;
        return cur;
      };
      const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
      };
      for (let i = 0; i < c.rows.length; i++) {
        for (let j = i + 1; j < c.rows.length; j++) {
          const ri = c.rows[i];
          const rj = c.rows[j];
          if (ri && rj && sameTake(ri, rj)) union(i, j);
        }
      }
      const chainList: ScanRow[][] = [];
      const byRoot = new Map<number, ScanRow[]>();
      for (let i = 0; i < c.rows.length; i++) {
        const ri = c.rows[i];
        if (!ri) continue;
        const root = find(i);
        const arr = byRoot.get(root);
        if (arr) arr.push(ri);
        else {
          const fresh: ScanRow[] = [ri];
          byRoot.set(root, fresh);
          chainList.push(fresh);
        }
      }
      c.rows.sort((a, b) => a.msgId - b.msgId);
      out.push(fmtGroup(chatId, c.rows, chainList.length === 1 ? "copies" : "variant"));
    }
  }
  return out.sort(
    (a, b) =>
      a.chatId - b.chatId ||
      (a.kind === b.kind ? a.best.msgId - b.best.msgId : a.kind === "copies" ? -1 : 1),
  );
}

/** Card length caps: per-copy delete buttons stop at 6 (huge sets get the
 * ★ bulk + Keep-all), text stays readable. */
const MAX_PER_COPY_BUTTONS = 6;

const fmtDur = (sec: number): string => {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
};

/** Plain-text card body: EVERY copy listed with its real title (remix/feat
 * labels included), numbered #N to match the per-copy buttons. Keeper starred. */
export function dupeCardText(g: DupeGroup): string {
  const body: string[] = [];
  body.push(
    g.kind === "copies"
      ? `👯 Duplicate copies (${g.members.length}) — same song, same version`
      : `🎵 Versions of one song (${g.members.length}) — remix / feat / live?`,
  );
  body.push(`Artist: ${g.best.artist === null ? "—" : clamp(g.best.artist)}`);
  body.push("");
  body.push(
    ...g.members.map((r, i) => {
      const { extras } = splitTitle(r.title);
      return [
        `${r.msgId === g.best.msgId ? "★" : " "} #${i + 1} “${clamp(r.title)}”`,
        `    ${fmtBytes(r.size ?? 0)} · ${r.duration === null ? "?" : fmtDur(r.duration)} · ${r.mime ?? "?"}${r.lossless === 1 ? " · lossless" : ""}${extras ? ` · ${extras}` : ""} · msg ${r.msgId}`,
      ].join("\n");
    }),
  );
  body.push("");
  if (g.kind === "copies") {
    body.push("Delete removes that copy from your channel via your own logged-in session.");
    if (g.members.length > MAX_PER_COPY_BUTTONS) {
      body.push(`(more than ${MAX_PER_COPY_BUTTONS} copies — use ★ Delete-all for the rest)`);
    }
  } else {
    body.push(
      "Different versions are separate recordings — usually keep all. Delete only a version you truly don't want.",
    );
  }
  return body.join("\n");
}

/** Inline keyboard for a dupe card: per-copy 🗑 (paired rows), Keep-all,
 * and the ★ bulk delete for copies-kind only (variants never mass-delete). */
export function dupeKeyboard(g: DupeGroup): CardKeyboard {
  const buttons: Array<Array<CardButton>> = [];
  const cap = Math.min(g.members.length, MAX_PER_COPY_BUTTONS);
  for (let i = 0; i < cap; i += 2) {
    const pair = g.members.slice(i, i + 2);
    buttons.push(
      pair.map((r, j) => ({
        text: `🗑 Delete #${i + j + 1}`,
        data: `dupe:${g.chatId}:${r.msgId}:del`,
      })),
    );
  }
  const seg = `${g.chatId}:${g.best.msgId}:${g.members[0]?.msgId}`;
  buttons.push([{ text: "🫶 Keep all", data: `dupe:${seg}:keep` }]);
  if (g.kind === "copies") {
    buttons.push([{ text: `🗑 Delete all but ★ (msg ${g.best.msgId})`, data: `dupe:${seg}:del` }]);
  }
  return { buttons };
}

/* ------------------------------------------------------------------ bot core */

const MAX_CARDS_PER_SWEEP = 10; // courtesy cap: never flood the owner

export interface CurationBot {
  sweep(): Promise<number>; // cards pushed
  handleUpdate(update: TelegramUpdate): Promise<void>;
  /** B5: the indexer calls this when new rows land — triggers a coalesced sweep. */
  notifyNewRows(count: number): void;
  stop(): void;
}

export interface CurationDeps {
  cfg: AppConfig;
  db: Database;
  deleter: Sadle;
  transport: BotTransport;
  log: (line: string) => void;
  /** gate-2: lease/mode gate — standby replicas and drain states must not
   * poll Telegram or push cards (deps.active defaults to always-on). */
  active?: () => boolean;
  /** B5 test seam: trailing delay after a new-rows event before the sweep
   * (default 15 000 ms — lets the indexer pass finish flushing). */
  eventDelayMs?: number;
}

export function createCurationBot(deps: CurationDeps): CurationBot {
  const { cfg, db, deleter, transport, log: rawLog } = deps;
  const isActive = deps.active ?? (() => true);
  /** Bot tokens sit in fetch URLs — a malformed-token URL-parse error would
   * carry the whole URL. Every log line gets token-redacted (review M1). */
  const log = (line: string): void =>
    rawLog(cfg.bot.token && line.includes(cfg.bot.token)
      ? line.split(cfg.bot.token).join("<bot-token>")
      : line);
  const allowed = new Set(cfg.bot.allowedIds);
  const ownerChat = cfg.bot.allowedIds[0] as number;
  /** Cards pushed this process — pending decisions re-ask after a restart (§5). */
  const asked = new Set<string>();
  /** M7.13 v2: copies already deleted via taps (per-copy, bulk ★, or junk) —
   * the SQLite index outlives Telegram deletions (next sync refreshes), so
   * duplicate sets must stop counting removed copies or they never settle. */
  const removed = new Set<string>();
  /** gate-2 L2: ids that failed delivery /too many times retire for the run. */
  const attempts = new Map<string, number>();

  const scanRows = (): ScanRow[] =>
    (
      db
        .prepare(
          "SELECT id, chatId, msgId, title, artist, duration, mime, size, bitrateKbps, lossless FROM tracks",
        )
        .all() as Array<Record<string, unknown>>
    ).map(junkRowFromDb);

  /** One card send with retry bookkeeping: mark-asked first (so a cap slice
   * seen mid-sweep counts), dead-letter after 3 failed sends. */
  async function sendOnce(
    id: string,
    text: string,
    keyboard: CardKeyboard,
    onOk: () => void,
  ): Promise<void> {
    asked.add(id);
    try {
      const messageId = await transport.sendCard(
        ownerChat,
        text.length > 4000 ? text.slice(0, 4000) : text,
        keyboard,
      );
      if (messageId === null) throw new Error("unknown delivery");
      attempts.delete(id);
      onOk();
    } catch (e) {
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      if (n >= 3) {
        log(`bot: card ${id} retired after 3 failed sends (${(e as Error).message})`);
      } else {
        asked.delete(id); // retry on the next sweep
        log(`bot: failed to push card ${id} (${(e as Error).message})`);
      }
    }
  }

  async function sweep(): Promise<number> {
    if (!cfg.bot.enabled || !isActive()) return 0;
    const rows = scanRows();
    const groups = dupeGroups(rows).filter(
      (g) => !asked.has(g.id) && decidedReview(db, g.id) === null,
    );
    // junk-first, but reserve up to two budget slots so dupes never starve
    const junkCap = Math.max(1, MAX_CARDS_PER_SWEEP - Math.min(2, groups.length));
    const findings = junkFindings(rows).filter(
      (f) => !asked.has(f.id) && decidedReview(db, f.id) === null,
    );
    let junk = 0;
    let dupes = 0;
    for (const f of findings.slice(0, junkCap)) {
      if (asked.has(f.id)) continue;
      await sendOnce(f.id, junkCardText(f.row, f.why), {
        buttons: [[
          { text: `Delete msg ${f.row.msgId}`, data: `junk:${f.row.chatId}:${f.row.msgId}:del` },
          { text: "Keep", data: `junk:${f.row.chatId}:${f.row.msgId}:keep` },
        ]],
      }, () => {
        junk += 1;
      });
    }
    // B1: duplicate sets after junk, sharing the sweep budget — v2 sorts
    // copies (actionable dupes) before variant alerts; one card per base.
    for (const g of groups) {
      if (junk + dupes >= MAX_CARDS_PER_SWEEP) break;
      if (asked.has(g.id)) continue; // gate-2 C1 belt: both-rules pairs dedupe by id
      await sendOnce(g.id, dupeCardText(g), dupeKeyboard(g), () => {
        dupes += 1;
      });
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
    const dupeBulkM = /^dupe:(-?\d+):(\d+):(\d+):(del|keep)$/.exec(data);
    // M7.13 v2: per-copy delete — `dupe:{chatId}:{targetMsgId}:del`
    const dupeOneM = /^dupe:(-?\d+):(\d+):del$/.exec(data);
    if (!junkM && !dupeBulkM && !dupeOneM) {
      await transport.answerCallback(cb.id, "Unknown card.");
      return;
    }
    const chatId = Number(junkM?.[1] ?? dupeBulkM?.[1] ?? dupeOneM?.[1]);
    const msgId = Number(junkM?.[2] ?? dupeBulkM?.[2] ?? dupeOneM?.[2]);
    const choice = (junkM ? junkM[3] : (dupeBulkM?.[4] ?? "del")) as "del" | "keep";
    const cardId = data.slice(0, data.lastIndexOf(":")); // stable review id (no action suffix)
    let receipt: string;
    /** Final card state: per-copy v2 re-renders the whole card + keyboard;
     * older paths paste the receipt over it (markup kept). */
    let cardText: string | null = null;
    let cardKeyboard: CardKeyboard | null | undefined; // undefined = leave as-is
    let answer = choice === "keep" ? "Kept" : "Deleting…";
    try {
      if (dupeOneM) {
        // SDD §3 v2 per-copy delete: the tapped copy alone. Recompute finds
        // the group the copy currently belongs to; the card edits itself
        // until ≤1 copy remains, then the set records "delete" (no re-ask).
        const target = msgId;
        answer = "Deleting…";
        const group = dupeGroups(scanRows()).find((g) => g.members.some((r) => r.msgId === target));
        const res = await deleter(chatId, [target]);
        if (res.error !== undefined) {
          receipt = `⚠️ Could not delete (msg ${target}): ${res.error} — tap again to retry.`;
        } else {
          // remembered until the index catches up: deleted copies leave the
          // group on the NEXT tap too, so a set always settles at ≤1 copy
          removed.add(`dupe:${chatId}:${target}`);
          const rest = group
            ? group.members.filter((r) => !removed.has(`dupe:${chatId}:${r.msgId}`))
            : [];
          if (group) {
            if (rest.length <= 1) recordReview(db, group.id, "delete");
            receipt =
              rest.length === 0
                ? `✅ Deleted msg ${target} — last copy of the set is gone.`
                : `✅ Deleted msg ${target} — ${rest.length} cop${rest.length === 1 ? "y" : "ies"} remain (card updated).`;
          } else {
            receipt = `✅ Deleted msg ${target} (the card no longer matches the index).`;
          }
          if (group && rest.length > 1) {
            // self-editing card: show what remains with matching buttons
            const next: DupeGroup = { ...group, members: rest, best: pickBest(rest) };
            cardText = dupeCardText(next);
            cardKeyboard = dupeKeyboard(next);
          } else {
            cardText =
              rest.length === 1
                ? `✅ Settled — msg ${rest[0]?.msgId} stays; this set won't ask again.`
                : `✅ Done — ${
                    group ? "last copy of the set" : `msg ${target}`
                  } removed. The next sync refreshes the index.`;
            cardKeyboard = null; // clears the stale inline keyboard
          }
        }
      } else if (!dupeBulkM) {
        if (choice === "keep") {
          recordReview(db, cardId, "keep");
          receipt = `🫶 Kept “${msgId}” — this card will not come back.`;
        } else {
          const res = await deleter(chatId, [msgId]);
          if (res.error === undefined) {
            recordReview(db, cardId, "delete");
            removed.add(`dupe:${chatId}:${msgId}`); // junk dupes stop counting in dupe sets too
            receipt = `✅ Deleted (msg ${msgId}). The next sync refreshes the index.`;
          } else {
            receipt = `⚠️ Could not delete (msg ${msgId}): ${res.error} — it stays queued; the next sweep re-asks.`;
          }
        }
      } else {
        // B1: recompute groups at tap time — the index may have moved; stateless.
        const dupeMin = Number(dupeBulkM[3]);
        const group = dupeGroups(scanRows()).find(
          (g) => g.id === `dupe:${chatId}:${msgId}:${dupeMin}`,
        );
        if (!group) {
          receipt = `🫥 No duplicate set left (msg ${msgId}) — maybe already handled.`;
          answer = "Nothing left";
        } else if (choice === "keep") {
          recordReview(db, cardId, "keep");
          receipt = `🫶 Kept the whole set — msg ${group.best.msgId} stays.`;
        } else if (group.kind === "variant") {
          // M7.13 v2: variants are separate recordings — per-copy buttons only.
          answer = "Use per-copy buttons";
          receipt = `🎵 These are different versions (remix/feat/live) — delete a specific copy above instead of mass-deleting.`;
        } else {
          const others = group.members.map((r) => r.msgId).filter((id) => id !== group.best.msgId);
          const res = await deleter(chatId, others);
          if (res.error === undefined) {
            recordReview(db, cardId, "delete");
            for (const id of others) removed.add(`dupe:${chatId}:${id}`);
            receipt = `✅ Deleted ${res.deleted} other cop${res.deleted === 1 ? "y" : "ies"} — kept msg ${group.best.msgId} (★). The next sync refreshes the index.`;
          } else {
            receipt = `⚠️ Could not delete: ${res.error} — tap Delete all but ★ again to retry.`;
          }
        }
      }
      const chatT = cb.message?.chat?.id;
      const msgT = cb.message?.message_id;
      if (chatT !== undefined && msgT !== undefined) {
        try {
          await transport.editMessage(chatT, msgT, cardText ?? receipt, cardKeyboard);
        } catch (e) {
          log(`bot: receipt edit failed (${(e as Error).message})`);
        }
      }
    } finally {
      // gate-2 L5/M6: the spinner ALWAYS stops, even if the receipt path throws
      await transport.answerCallback(cb.id, answer);
    }
  }

  return {
    sweep,
    handleUpdate,
    // B5: real notification decorates this in startCurationBot (it owns
    // botHealth + the active() gate); the pure core has no event notion.
    notifyNewRows: () => undefined,
    stop: () => undefined,
  };
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

  editMessage(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: CardKeyboard | null,
  ): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
    if (keyboard !== undefined) {
      body.reply_markup = keyboard ?? { inline_keyboard: [] };
    }
    return this.call("editMessageText", body).then(() => undefined);
  }

  answerCallback(callbackId: string, text: string): Promise<void> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, text }).then(
      () => undefined,
    );
  }
}

/** B3: process-wide bot health counters — surfaced in /payload status only. */
export const botHealth = {
  running: false,
  sweeps: 0,
  pushed: 0,
  lastSweepAt: 0,
  errors: 0,
};

/** Long-poll router loop: pushes updates into the router with error backoff. */
export function startCurationBot(
  deps: Omit<CurationDeps, "transport"> & { transport?: BotTransport },
): CurationBot | null {
  if (!deps.cfg.bot.enabled) return null;
  // gate-2 M7 test seam: the transport is injectable; production keeps BotApi.
  const api: BotTransport = deps.transport ?? new BotApi(deps.cfg.bot.token);
  const bot = createCurationBot({ ...deps, transport: api });
  // loop-level logs carry raw fetch error messages — redact the token here too
  const redLog = (line: string): void =>
    deps.log(deps.cfg.bot.token && line.includes(deps.cfg.bot.token)
      ? line.split(deps.cfg.bot.token).join("<bot-token>")
      : line);
  const isActive = deps.active ?? (() => true);
  let stopped = false;
  let offset = 0;
  let backoffMs = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveSleep: (() => void) | null = null;
  let lastSweep = Date.now();
  botHealth.running = isActive();

  void (async () => {
    try {
      if (!isActive()) {
        lastSweep = Date.now(); // standby first boots sweep when promoted
        return;
      }
      botHealth.pushed += await bot.sweep();
      botHealth.sweeps += 1;
      botHealth.lastSweepAt = Date.now();
      lastSweep = botHealth.lastSweepAt;
    } catch (e) {
      botHealth.errors += 1;
      redLog(`bot: startup sweep failed (${(e as Error).message})`);    }
  })();

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      resolveSleep = resolve;
      timer = setTimeout(resolve, ms); // keep the handle live for stop()
    });

  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (!isActive()) {
        // gate-2 H2: a replica without the lease polls Telegram for nothing
        // (409 storms against the active instance); idle cheaply instead.
        botHealth.running = false;
        await sleep(Math.min(backoffMs, 5_000));
        continue;
      }
      botHealth.running = true;
      try {
        // fakes may omit getUpdates → the loop idles quietly (network-free)
        const updates = (await api.getUpdates?.(offset)) ?? [];
        backoffMs = 1000;
        for (const u of updates) {
          if (typeof u.update_id === "number" && u.update_id >= offset) offset = u.update_id + 1;
          if (stopped) return; // gate-2 M5: no work rides during the drain exit
          try {
            await bot.handleUpdate(u); // gate-2 M6: one bad update can't sink its batch
          } catch (e) {
            botHealth.errors += 1;
            redLog(`bot: update failed (${(e as Error).message})`);
          }
        }
      } catch (e) {
        botHealth.errors += 1;
        backoffMs = Math.min(backoffMs * 2, 30_000);
        redLog(`bot: poll backoff ${backoffMs} ms (${(e as Error).message})`);
      }
      // B3: periodic sweep is independent of update traffic (SDD §5 automatic)
      if (Date.now() - lastSweep >= deps.cfg.bot.sweepSeconds * 1000) {
        lastSweep = Date.now();
        try {
          botHealth.pushed += await bot.sweep();
          botHealth.sweeps += 1;
          botHealth.lastSweepAt = Date.now();
        } catch (e) {
          botHealth.errors += 1;
          redLog(`bot: sweep failed (${(e as Error).message})`);
        }
      }
      if (stopped) return;
      await sleep(backoffMs);
    }
  };
  void loop();

  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  return {
    sweep: bot.sweep,
    handleUpdate: bot.handleUpdate,
    // B5 (SDD §5): new-rows events from the indexer trigger a trailing,
    // coalesced sweep — new tracks get curated minutes after arriving,
    // not at the next BOT_SWEEP_SECONDS tick. Standby replicas skip.
    notifyNewRows: (count: number): void => {
      if (count <= 0 || !isActive()) return;
      if (eventTimer !== null) return; // one sweep per burst
      eventTimer = setTimeout(() => {
        eventTimer = null;
        void bot
          .sweep()
          .then((pushed) => {
            botHealth.sweeps += 1;
            botHealth.lastSweepAt = Date.now();
            lastSweep = botHealth.lastSweepAt;
            if (pushed > 0) botHealth.pushed += pushed;
          })
          .catch((e: unknown) => {
            botHealth.errors += 1;
            redLog(`bot: event sweep failed (${(e as Error).message})`);
          });
      }, deps.eventDelayMs ?? 15_000);
    },
    stop: () => {
      stopped = true;
      if (eventTimer) {
        clearTimeout(eventTimer);
        eventTimer = null;
      }
      botHealth.running = false;
      if (timer) clearTimeout(timer);
      if (resolveSleep) resolveSleep(); // gate-2 M5: wake the parked await so the loop can exit
    },
  };
}
