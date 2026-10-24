/**
 * SQLite storage layer — §4.11. Track index on local disk (WAL), FTS5 search
 * with bm25 ranking, hostile-query sanitization (FR-17), dedupe rules (§4.6.4).
 * Statements are prepared once per connection (§4.13).
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isStructured, parseQuery, type ParsedQuery, type SortMode } from "./query";

export interface TrackRow {
  rowid: number | bigint;
  id: string;
  chatId: number;
  msgId: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mime: string | null;
  size: number | null;
  fileName: string | null;
  codec: string | null;
  container: string | null;
  lossless: number;
  bitrateKbps: number | null;
  /** Telegram document id (used for ETag / LRU keys), positive int64. */
  docId: number;
  /** source: "telegram" | "fixture"; */
  source: "telegram" | "fixture";
  /** Fixture-only: absolute path to a local file standing in for Telegram. */
  filePath: string | null;
  /** FR-12: the indexed document carried a thumbnail (art is served live). */
  hasThumb: number;
  addedAt: number;
}

export type UpsertTrack = Omit<TrackRow, "rowid" | "addedAt"> & {
  /** enrichment (M4 probes) preserves the original index time when set */
  addedAt?: number;
};

const SCHEMA_VERSION = "3";
const FETCH_LIMIT = 200; // candidate pool before JS-side boost/dedupe (§4.17)

export function openDb(dbPath: string): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // §4.13: WAL, synchronous=NORMAL, cache_size=-8000, prepared-once
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -8000");
  db.pragma("busy_timeout = 3000");
  return db;
}

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS tracks (
      id          TEXT PRIMARY KEY,
      chatId      INTEGER NOT NULL,
      msgId       INTEGER NOT NULL,
      title       TEXT NOT NULL,
      artist      TEXT,
      album       TEXT,
      duration    INTEGER,
      mime        TEXT,
      size        INTEGER,
      fileName    TEXT,
      codec       TEXT,
      container   TEXT,
      lossless    INTEGER NOT NULL DEFAULT 0,
      bitrateKbps INTEGER,
      docId       INTEGER NOT NULL,
      source      TEXT NOT NULL DEFAULT 'telegram',
      filePath    TEXT,
      hasThumb    INTEGER NOT NULL DEFAULT 0,
      addedAt     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tracks_chat_msg ON tracks(chatId, msgId);
    CREATE INDEX IF NOT EXISTS tracks_docid ON tracks(docId);

    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      title, artist, album, fileName,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS sync_cursors (
      chatId TEXT PRIMARY KEY,
      minId  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_reviews (
      id       TEXT PRIMARY KEY,
      decidedAt INTEGER NOT NULL,
      outcome  TEXT NOT NULL
    );
  `);
  // v1 → v2 migration: FR-12 hasThumb column on pre-M4 databases
  const cols = db.prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "hasThumb")) {
    db.exec("ALTER TABLE tracks ADD COLUMN hasThumb INTEGER NOT NULL DEFAULT 0");
  }
  // v2 → v3 migration (TRD v2.2 FINAL §4.11 rule 5): per-chat cursors move
  // from opaque meta rows ("cursor:{chatId}") into a real sync_cursors table
  // so the Redis snapshot can reseed them verbatim on ephemeral-disk hosts.
  const migrate = db.transaction(() => {
    for (const r of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'cursor:%'").all() as Array<{ key: string; value: string }>) {
      const chatId = r.key.slice("cursor:".length);
      db.prepare("INSERT OR IGNORE INTO sync_cursors(chatId, minId) VALUES(@chatId, @minId)").run({
        chatId,
        minId: Number(r.value) || 0,
      });
      db.prepare("DELETE FROM meta WHERE key = @key").run({ key: r.key });
    }
  });
  migrate();
  const meta = db.prepare<{ v: string }>(
    "INSERT INTO meta(key, value) VALUES('schema_version', @v) ON CONFLICT(key) DO UPDATE SET value = @v",
  );
  meta.run({ v: SCHEMA_VERSION });
}

/* --------------------------------------------------------------- write path */

export function upsertTrack(db: Database.Database, t: UpsertTrack): void {
  const run = db.transaction((track: UpsertTrack) => {
    const s = stmts(db);
    // FTS is synced manually against the tracks rowid (§4.6.3); replace = delete+insert.
    // The replaced rows' FTS entries must be purged first, or the recycled rowid
    // collides with the stale docid on re-insert (SQLITE_CONSTRAINT_PRIMARYKEY).
    const oldRowids = new Set<number>();
    const byId = s.byId.get({ id: track.id }) as { rowid: number | bigint } | undefined;
    if (byId) oldRowids.add(Number(byId.rowid));
    const byChatMsg = s.rowidsByChatMsg.all({
      chatId: track.chatId,
      msgId: track.msgId,
    }) as Array<{ rowid: number | bigint }>;
    for (const r of byChatMsg) oldRowids.add(Number(r.rowid));
    for (const rowid of oldRowids) s.deleteFtsRow.run({ rowid });
    s.deleteRowForTrack.run({ id: track.id, chatId: track.chatId, msgId: track.msgId });
    const info = s.insertTrack.run({ ...track, addedAt: track.addedAt ?? Date.now() });
    s.insertFts.run({
      rowid: Number(info.lastInsertRowid),
      title: track.title,
      artist: track.artist,
      album: track.album,
      fileName: track.fileName,
    });
  });
  run(t);
}

export function removeTracksByRowids(db: Database.Database, rowids: Array<number | bigint>): void {
  const run = db.transaction((ids: number[]) => {
    for (const rowid of ids) {
      stmts(db).deleteByRowid.run({ rowid });
      stmts(db).deleteFtsRow.run({ rowid });
    }
  });
  run(rowids.map(Number));
}

/** List every track (bounded batches) for the M1 reconcile sweep. */
export function listTrackIds(db: Database.Database, offset: number, limit: number): Array<{ rowid: number; id: string }> {
  const rows = stmts(db).listIds.all({ offset, limit }) as Array<{ rowid: number; id: string }>;
  return rows.map((r) => ({ rowid: Number(r.rowid), id: r.id }));
}

/** All indexed rows of one chat, for the reconcile sweep (§4.6). */
export function listChatTrackRows(db: Database.Database, chatId: number): Array<{ rowid: number; msgId: number }> {
  const stmt = db.prepare("SELECT rowid, msgId FROM tracks WHERE chatId = @chatId");
  const rows = stmt.all({ chatId }) as Array<{ rowid: number; msgId: number }>;
  return rows.map((r) => ({ rowid: Number(r.rowid), msgId: Number(r.msgId) }));
}

/* ---------------------------------------------------------------- read path */

export function getTrack(db: Database.Database, id: string): TrackRow | null {
  const stmt = stmts(db).byId;
  const row = stmt.get({ id }) as (Record<string, unknown> & { rowid: number }) | undefined;
  return row ? (row as unknown as TrackRow) : null;
}

export function countTracks(db: Database.Database): number {
  const row = stmts(db).count.get({}) as { n: number };
  return row.n;
}

/** M7.9: per-channel + total library byte size (one GROUP BY pass, opt-in via
 * TRACK_SIZE_STATS — /status only reads it when cfg.trackSizes is true). */
export interface ChannelSize {
  chatId: number;
  count: number;
  bytes: number;
}

export function channelSizes(db: Database.Database): { totalBytes: number; byChannel: ChannelSize[] } {
  const rows = db
    .prepare("SELECT chatId, COUNT(*) AS count, SUM(size) AS bytes FROM tracks GROUP BY chatId ORDER BY bytes DESC")
    .all() as Array<{ chatId: number | string; count: number; bytes: number | null }>;
  const byChannel: ChannelSize[] = rows.map((r) => ({
    chatId: Number(r.chatId),
    count: Number(r.count),
    bytes: Number(r.bytes ?? 0),
  }));
  return { totalBytes: byChannel.reduce((sum, r) => sum + r.bytes, 0), byChannel };
}

/* ---------------------------------------------------------------- bot reviews (M7.11 B2) */

export type ReviewOutcome = "keep" | "delete";

/** The owner's durable answer for a review card id (`junk:*` / `dupe:*`):
 * decided cards never re-ask across restarts (SDD §5 B2). */
export function decidedReview(db: Database.Database, id: string): ReviewOutcome | null {
  const row = db.prepare("SELECT outcome FROM bot_reviews WHERE id = ?").get(id) as
    | { outcome: string }
    | undefined;
  return row ? (row.outcome as ReviewOutcome) : null;
}

/** Idempotent: the first decision wins (PK conflict ignores later writes). */
export function recordReview(db: Database.Database, id: string, outcome: ReviewOutcome): void {
  db.prepare("INSERT OR IGNORE INTO bot_reviews (id, decidedAt, outcome) VALUES (?, ?, ?)").run(
    id,
    Date.now(),
    outcome,
  );
}

/* ---------------------------------------------------------------- cursors (FR-14) */

/** Oldest-rowids list used to trim `tracks` down to MAX_INDEX_ENTRIES (§4.6, keep newest). */
export function oldestTrackRowids(db: Database.Database, limit: number): Array<{ rowid: number; id: string }> {
  if (limit <= 0) return [];
  const rows = stmts(db).oldestIds.all({ limit }) as Array<{ rowid: number; id: string }>;
  return rows.map((r) => ({ rowid: Number(r.rowid), id: r.id }));
}

export function getCursor(db: Database.Database, chatId: number): number {
  const row = stmts(db).getCursor.get({ chatId: String(chatId) }) as { minId: number } | undefined;
  return row ? Number(row.minId) : 0;
}

export function setCursor(db: Database.Database, chatId: number, minId: number): void {
  stmts(db).setCursor.run({ chatId: String(chatId), minId });
}

/** Every stored sync cursor (used by the Redis snapshot export, §4.11). */
export function listCursors(db: Database.Database): Array<{ chatId: number; cursor: number }> {
  const rows = db.prepare("SELECT chatId, minId FROM sync_cursors").all() as Array<{
    chatId: string;
    minId: number;
  }>;
  const out: Array<{ chatId: number; cursor: number }> = [];
  for (const r of rows) {
    const chatId = Number(r.chatId);
    const cursor = Number(r.minId);
    if (Number.isFinite(chatId) && Number.isFinite(cursor)) out.push({ chatId, cursor });
  }
  return out;
}

/* --------------------------------------------- index snapshot (§4.11, FR-15) */

/** Pure data dump; the caller gzip-compresses it into Redis's index:snapshot. */
export interface IndexSnapshot {
  version: 1;
  exportedAt: number;
  tracks: Array<Omit<TrackRow, "rowid">>;
  cursors: Array<{ chatId: number; cursor: number }>;
}

export function exportTrackSnapshot(db: Database.Database): IndexSnapshot {
  const rows = db.prepare("SELECT rowid, * FROM tracks").all() as TrackRow[];
  const tracks: Array<Omit<TrackRow, "rowid">> = [];
  for (const r of rows) {
    const { rowid: _rowid, ...row } = r;
    void _rowid;
    tracks.push(row as Omit<TrackRow, "rowid">);
  }
  return { version: 1, exportedAt: Date.now(), tracks, cursors: listCursors(db) };
}

/**
 * Replays a snapshot into `tracks` (+ manual FTS sync) and restores the sync
 * cursors. Preserves addedAt so cap trimming keeps the correct newest set.
 */
export function restoreTrackSnapshot(db: Database.Database, snap: IndexSnapshot): number {
  if (!snap || snap.version !== 1 || !Array.isArray(snap.tracks)) return 0;
  let restored = 0;
  const insert = db.prepare(`
      INSERT INTO tracks (id, chatId, msgId, title, artist, album, duration, mime, size,
                          fileName, codec, container, lossless, bitrateKbps, docId,
                          source, filePath, hasThumb, addedAt)
      VALUES (@id, @chatId, @msgId, @title, @artist, @album, @duration, @mime, @size,
              @fileName, @codec, @container, @lossless, @bitrateKbps, @docId,
              @source, @filePath, @hasThumb, @addedAt)
    `);
  const run = db.transaction(() => {
    for (const row of snap.tracks) {
      const chatId = Number(row.chatId);
      const msgId = Number(row.msgId);
      const addedAt = Number(row.addedAt);
      const lossless = Number(row.lossless);
      const docId = Number(row.docId);
      if (!Number.isFinite(chatId) || !Number.isFinite(msgId) || typeof row.id !== "string" || row.id === "") continue;
      if (typeof row.title !== "string" || row.title === "") continue;
      if (row.source !== "telegram" && row.source !== "fixture") continue;
      stmts(db).deleteRowForTrack.run({ id: row.id, chatId, msgId });
      const info = insert.run({
        chatId,
        msgId,
        addedAt: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : Date.now(),
        title: row.title,
        artist: row.artist ?? null,
        album: row.album ?? null,
        duration: row.duration ?? null,
        mime: row.mime ?? null,
        size: row.size ?? null,
        fileName: row.fileName ?? null,
        codec: row.codec ?? null,
        container: row.container ?? null,
        lossless: lossless === 1 ? 1 : 0,
        bitrateKbps: row.bitrateKbps ?? null,
        docId: Number.isFinite(docId) ? docId : 0,
        source: row.source,
        filePath: row.filePath ?? null,
        hasThumb: Number(row.hasThumb) === 1 ? 1 : 0,
        id: row.id,
      });
      stmts(db).insertFts.run({
        rowid: Number(info.lastInsertRowid),
        title: row.title,
        artist: row.artist ?? null,
        album: row.album ?? null,
        fileName: row.fileName ?? null,
      });
      restored += 1;
    }
    for (const c of snap.cursors ?? []) {
      if (Number.isFinite(c.chatId) && Number.isFinite(c.cursor)) setCursor(db, c.chatId, c.cursor);
    }
  });
  run();
  return restored;
}

/* --------------------------------------------------------------------- search */

function normalizeText(input: string): string {
  // §4.14 builder: NFKD, strip combining marks, lowercase, punctuation -> space
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize a hostile free-text query into FTS-safe prefix phrases (FR-17). */
export function ftsQuery(raw: string | undefined | null): { and: string; or: string } | null {
  if (!raw) return null;
  const tokens = normalizeText(raw)
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `"${t}"*`);
  if (!tokens.length) return null;
  return { and: tokens.join(" AND "), or: tokens.join(" OR ") };
}

interface CandidateRow {
  rowid: number | bigint;
  id: string;
  chatId: number;
  msgId: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mime: string | null;
  size: number | null;
  fileName: string | null;
  codec: string | null;
  container: string | null;
  lossless: number;
  bitrateKbps: number | null;
  docId: number;
  source: string;
  filePath: string | null;
  hasThumb: number;
  addedAt: number;
  r: number; // bm25 rank, lower is better
}

/* ------------------------------------------------------- typed grammar (M7) */

type DynStmt = Database.Statement<Record<string, unknown>>;
const dynCache = new WeakMap<Database.Database, Map<string, DynStmt>>();
/** Dynamic grammar SQL has few distinct shapes — cache per db like the fixed stmts. */
function dyn(db: Database.Database, sql: string): DynStmt {
  let m = dynCache.get(db);
  if (!m) {
    m = new Map();
    dynCache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

/** FTS5 units for a typed query: prefix terms, quoted phrases, column filters. */
function matchUnits(q: ParsedQuery): Array<string> {
  const tok = (s: string): Array<string> =>
    normalizeText(s ?? "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 8);
  const scope = (col: string, vals: Array<string>) => {
    for (const v of vals) {
      const ts = tok(v);
      if (!ts.length) continue;
      // single word: bare prefix; multiword: exact adjacency (FTS5 col filter)
      units.push(ts.length === 1 ? `${col} : ${ts[0]}*` : `${col} : "${ts.join(" ")}"`);
    }
  };
  const units: Array<string> = [];
  for (const t of tok(q.free)) units.push(`"${t}"*`);
  for (const p of q.phrases) {
    const ts = tok(p);
    if (ts.length) units.push(`"${ts.join(" ")}"*`); // adjacency, last token prefix
  }
  scope("title", q.title);
  scope("artist", q.artist);
  scope("album", q.album);
  // No artificial cap: q is capped at 300 chars upstream (server), so the unit
  // count is already bounded. Trimming here would silently drop AND constraints
  // and broaden results (pre-M7.6 slice(0,16) bug).
  return units;
}

/* dynamic WHERE for typed filters: lossless bare flag, dur: window, recent: window */
function wherePartsOf(parsed: ParsedQuery): Array<{ sql: string; p: Record<string, unknown> }> {
  const parts: Array<{ sql: string; p: Record<string, unknown> }> = [];
  if (parsed.lossless) parts.push({ sql: "t.lossless = 1", p: {} });
  if (parsed.durOp && parsed.durVal !== null) {
    parts.push({ sql: `t.duration ${parsed.durOp} @dur`, p: { dur: parsed.durVal } });
  }
  if (parsed.recentDays !== null) {
    parts.push({ sql: "t.addedAt >= @since", p: { since: Date.now() - parsed.recentDays * 86_400_000 } });
  }
  return parts;
}

/** non-relevance sorts need dedicated pool ordering (FETCH_LIMIT pool semantics) */
const POOL_ORD: Record<SortMode, string> = {
  relevance: "ORDER BY r, t.rowid",
  recent: "ORDER BY t.addedAt DESC, t.rowid DESC",
  oldest: "ORDER BY t.addedAt ASC, t.rowid ASC",
  longest: "ORDER BY t.duration DESC, t.addedAt DESC, t.rowid DESC",
};

/** Candidate pool for typed queries: FTS match (or full scan when filter-only),
 * plus typed WHERE, plus the explicit sort order. r is 0 on the scan path. */
function fetchPool(
  db: Database.Database,
  parsed: ParsedQuery,
  joiner: "and" | "or",
  match: { and: string; or: string } | null,
): CandidateRow[] {
  const wh = wherePartsOf(parsed);
  const whereSql = wh.map((w) => w.sql).join(" AND ");
  const params: Record<string, unknown> = { limit: FETCH_LIMIT };
  if (match) params.match = match[joiner];
  for (const w of wh) Object.assign(params, w.p);
  const where = match
    ? `tracks_fts MATCH @match${whereSql ? ` AND ${whereSql}` : ""}`
    : `1=1${whereSql ? ` AND ${whereSql}` : ""}`;
  const sql = match
    ? `SELECT t.rowid AS rowid, t.*, bm25(tracks_fts, 4.0, 3.0, 2.0, 1.0) AS r
       FROM tracks_fts f
       JOIN tracks t ON t.rowid = f.rowid
       WHERE ${where} ${POOL_ORD[parsed.sort]} LIMIT @limit`
    : `SELECT t.rowid AS rowid, t.*, 0 AS r FROM tracks t WHERE ${where} ${POOL_ORD[parsed.sort]} LIMIT @limit`;
  return dyn(db, sql).all(params) as CandidateRow[];
}

/** Near-identical dedupe (§4.6.4): same normalized title+artist within ±2 s.
 * Relevance keeps the §4.6.4 preference (lossless, then larger file) and
 * replaces in place so bm25 positions survive. Explicit sorts must pick the
 * survivor that matches the requested order (recent→newest, oldest→oldest,
 * longest→longest) — pre-M7.6 bug: an older lossless copy could jump ahead of
 * a newer lossy one under sort:recent — then re-sort the kept slice so the
 * in-place survivor lands at its correct rank. */
function dedupeKeep(
  scored: Array<{ row: CandidateRow; score: number }>,
  normOf: (s: string | null | undefined) => string,
  limit: number,
  sort: SortMode = "relevance",
): TrackRow[] {
  const preferCandidate = (best: TrackRow, row: CandidateRow): boolean => {
    if (sort === "recent") return row.addedAt > best.addedAt;
    if (sort === "oldest") return row.addedAt < best.addedAt;
    if (sort === "longest") return (row.duration ?? -1) > (best.duration ?? -1);
    return (
      (row.lossless === 1 && best.lossless !== 1) ||
      (row.lossless === best.lossless && (best.size ?? 0) < (row.size ?? 0))
    );
  };
  const kept: TrackRow[] = [];
  const groups: Array<{ key: string; dur: number | null; best: TrackRow }> = [];
  for (const { row } of scored) {
    const key = `${normOf(row.title)}|${normOf(row.artist)}`;
    const dur = row.duration ?? null;
    const g = groups.find((x) => {
      if (x.key !== key) return false;
      if (x.dur === null || dur === null) return true;
      return Math.abs(x.dur - dur) <= 2;
    });
    if (!g) {
      const tr = trackOf(row);
      groups.push({ key, dur, best: tr });
      kept.push(tr);
    } else if (preferCandidate(g.best, row)) {
      const tr = trackOf(row);
      kept[kept.indexOf(g.best)] = tr;
      g.best = tr;
      g.dur = dur;
    }
  }
  if (sort !== "relevance") {
    const by: Record<"recent" | "oldest" | "longest", (a: TrackRow, b: TrackRow) => number> = {
      recent: (a, b) => Number(b.addedAt) - Number(a.addedAt) || Number(b.rowid) - Number(a.rowid),
      oldest: (a, b) => Number(a.addedAt) - Number(b.addedAt) || Number(a.rowid) - Number(b.rowid),
      longest: (a, b) =>
        (b.duration ?? -1) - (a.duration ?? -1) ||
        Number(b.addedAt) - Number(a.addedAt) ||
        Number(b.rowid) - Number(a.rowid),
    };
    kept.sort(by[sort]);
  }
  return kept.slice(0, limit);
}

/**
 * Full search pipeline (§4.6.4): AND first, OR fallback (<5 rows), bm25 ranking,
 * exact title/artist boost, near-identical dedupe. Max `limit` (25).
 * M7.0 grammar: untyped q runs the legacy hot path byte-for-byte (M3 locks it);
 * typed queries (artist:/album:/title:/ phrases / lossless / dur:/recent:/sort:)
 * switch to the dynamic pool above.
 */
export function searchTracks(db: Database.Database, rawQuery: string | undefined | null, limit = 25): TrackRow[] {
  const parsed = parseQuery(typeof rawQuery === "string" ? rawQuery : "");

  if (!isStructured(parsed)) {
    // Bind the lexer's degradation output, not the raw string: tokens the
    // grammar dropped (e.g. a junk `dur:soon`) must not resurface here as
    // keyword searches (pre-M7.6 path-dependent behavior).
    const q = ftsQuery(parsed.free);
    if (!q) return [];

    const seen = new Set<string>();
    const candidates: CandidateRow[] = [];
    for (const r of stmts(db).search.all({ match: q.and, limit: FETCH_LIMIT }) as CandidateRow[]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        candidates.push(r);
      }
    }
    if (candidates.length < 5) {
      for (const r of stmts(db).search.all({ match: q.or, limit: FETCH_LIMIT }) as CandidateRow[]) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          candidates.push(r);
        }
      }
    }
    if (!candidates.length) return [];

    const normTokens = normalizeText(parsed.free).split(" ").filter(Boolean);
    const normOf = (s: string | null | undefined) => normalizeText(s ?? "");
    const tokensOf = (s: string | null | undefined) => new Set(normOf(s).split(" ").filter(Boolean));

    // boost exact title/artist (§4.6.4, §4.14)
    const scored = candidates.map((r) => {
      const titleTokens = tokensOf(r.title);
      const artistTokens = tokensOf(r.artist);
      const titleNorm = normOf(r.title);
      const queryNorm = normTokens.join(" ");
      let boost = 0;
      if (titleTokens.size && normTokens.every((t) => titleTokens.has(t))) boost += 4; // all query tokens in title
      if (artistTokens.size && normTokens.every((t) => artistTokens.has(t))) boost += 3;
      if (titleNorm === queryNorm) boost += 6; // exact title
      if (r.artist && normOf(r.artist) === queryNorm) boost += 6; // exact artist
      return { row: r, score: boost - r.r };
    });
    scored.sort((a, b) => b.score - a.score || String(a.row.addedAt).localeCompare(String(b.row.addedAt)));

    return dedupeKeep(scored, normOf, limit);
  }

  /* M7.1 structured path: typed units + WHERE filters + explicit sort order.
   * Strict-first for every mode: the AND pool (all units) wins when it has
   * enough rows; otherwise ONE OR pool is fetched — each pool carries its own
   * ORDER BY, so ordering stays global (pre-M7.6 bug: appending an unsorted OR
   * fallback broke explicit sorts; M7.6's "always OR" then ignored strict
   * matching when the AND pool was already rich).
   * Filter/sort-only queries are browse mode — a sorted window of the library;
   * junk-only queries (no units, no filters, no sort token) return []. */
  const units = matchUnits(parsed);
  const match = units.length ? { and: units.join(" AND "), or: units.join(" OR ") } : null;
  if (!match && !wherePartsOf(parsed).length && !parsed.sorted) return [];
  const seen = new Set<string>();
  const candidates: CandidateRow[] = [];
  const add = (rows: CandidateRow[]): void => {
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        candidates.push(r);
      }
    }
  };
  if (!match) {
    add(fetchPool(db, parsed, "and", null)); // filter-only browse window
  } else {
    const strict = fetchPool(db, parsed, "and", match);
    if (strict.length >= 5) {
      add(strict);
    } else if (parsed.sort === "relevance") {
      // legacy rule: union AND + OR, then the scorer re-ranks everything
      add(strict);
      add(fetchPool(db, parsed, "or", match));
    } else {
      // explicit sort: one globally ordered pool (AND rows are a subset of OR)
      add(fetchPool(db, parsed, "or", match));
    }
  }
  if (!candidates.length) return [];

  const normOf = (s: string | null | undefined) => normalizeText(s ?? "");
  const tokensOf = (s: string | null | undefined) => new Set(normOf(s).split(" ").filter(Boolean));
  // free + scoped tokens feed the containment boosts; the +6 whole-string
  // equalities stay legacy-only (they compare the full raw string — meaningless
  // once operators are present)
  const boostTokens = [parsed.free, ...parsed.title, ...parsed.artist]
    .map((s) => normalizeText(s ?? ""))
    .join(" ")
    .split(" ")
    .filter(Boolean);

  const scored = candidates.map((r) => {
    let boost = 0;
    if (boostTokens.length) {
      if (tokensOf(r.title).size && boostTokens.every((t) => tokensOf(r.title).has(t))) boost += 4;
      if (tokensOf(r.artist).size && boostTokens.every((t) => tokensOf(r.artist).has(t))) boost += 3;
    }
    return { row: r, score: boost - r.r };
  });
  if (parsed.sort === "relevance") {
    scored.sort((a, b) => b.score - a.score || String(a.row.addedAt).localeCompare(String(b.row.addedAt)));
  }
  return dedupeKeep(scored, normOf, limit, parsed.sort);
}

function trackOf(r: CandidateRow): TrackRow {
  return {
    rowid: r.rowid,
    id: r.id,
    chatId: r.chatId,
    msgId: r.msgId,
    title: r.title,
    artist: r.artist,
    album: r.album,
    duration: r.duration,
    mime: r.mime,
    size: r.size,
    fileName: r.fileName,
    codec: r.codec,
    container: r.container,
    lossless: r.lossless,
    bitrateKbps: r.bitrateKbps,
    docId: r.docId,
    hasThumb: r.hasThumb,
    source: r.source === "fixture" ? "fixture" : "telegram",
    filePath: r.filePath,
    addedAt: r.addedAt,
  };
}

/* --------------------------------------------------------------- statements */

interface Statements {
  insertTrack: Database.Statement<Record<string, unknown>>;
  deleteRowForTrack: Database.Statement<{ id: string; chatId: number; msgId: number }>;
  rowidsByChatMsg: Database.Statement<Record<string, unknown>>;
  deleteByRowid: Database.Statement<Record<string, unknown>>;
  insertFts: Database.Statement<Record<string, unknown>>;
  deleteFtsRow: Database.Statement<Record<string, unknown>>;
  search: Database.Statement<Record<string, unknown>>;
  byId: Database.Statement<Record<string, unknown>>;
  count: Database.Statement<Record<string, unknown>>;
  listIds: Database.Statement<Record<string, unknown>>;
  oldestIds: Database.Statement<Record<string, unknown>>;
  getCursor: Database.Statement<Record<string, unknown>>;
  setCursor: Database.Statement<Record<string, unknown>>;
}

const stmtCache = new WeakMap<Database.Database, Statements>();

function stmts(db: Database.Database): Statements {
  let s = stmtCache.get(db);
  if (!s) {
    s = {
      insertTrack: db.prepare(`
        INSERT INTO tracks (id, chatId, msgId, title, artist, album, duration, mime, size,
                            fileName, codec, container, lossless, bitrateKbps, docId, source,
                            filePath, hasThumb, addedAt)
        VALUES (@id, @chatId, @msgId, @title, @artist, @album, @duration, @mime, @size,
                @fileName, @codec, @container, @lossless, @bitrateKbps, @docId, @source,
                @filePath, @hasThumb, @addedAt)
      `),
      deleteRowForTrack: db.prepare(`
        DELETE FROM tracks WHERE id = @id OR (chatId = @chatId AND msgId = @msgId)
      `),
      rowidsByChatMsg: db.prepare("SELECT rowid FROM tracks WHERE chatId = @chatId AND msgId = @msgId"),
      deleteByRowid: db.prepare("DELETE FROM tracks WHERE rowid = @rowid"),
      insertFts: db.prepare(
        "INSERT INTO tracks_fts(rowid, title, artist, album, fileName) VALUES (@rowid, @title, @artist, @album, @fileName)",
      ),
      deleteFtsRow: db.prepare("DELETE FROM tracks_fts WHERE rowid = @rowid"),
      search: db.prepare(`
        SELECT t.rowid AS rowid, t.*, bm25(tracks_fts, 4.0, 3.0, 2.0, 1.0) AS r
        FROM tracks_fts f
        JOIN tracks t ON t.rowid = f.rowid
        WHERE tracks_fts MATCH @match
        ORDER BY r
        LIMIT @limit
      `),
      byId: db.prepare("SELECT rowid, * FROM tracks WHERE id = @id"),
      count: db.prepare("SELECT COUNT(*) AS n FROM tracks"),
      listIds: db.prepare("SELECT rowid, id FROM tracks ORDER BY rowid LIMIT @limit OFFSET @offset"),
      // newest-first: addedAt ascending selects the OLDEST rows for trimming past the cap
      oldestIds: db.prepare("SELECT rowid, id FROM tracks ORDER BY addedAt ASC, rowid ASC LIMIT @limit"),
      getCursor: db.prepare("SELECT minId FROM sync_cursors WHERE chatId = @chatId"),
      setCursor: db.prepare(`
        INSERT INTO sync_cursors(chatId, minId) VALUES(@chatId, @minId)
        ON CONFLICT(chatId) DO UPDATE SET minId = @minId
      `),
    };
    stmtCache.set(db, s);
  }
  return s;
}
