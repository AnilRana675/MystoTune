/**
 * SQLite storage layer — §4.11. Track index on local disk (WAL), FTS5 search
 * with bm25 ranking, hostile-query sanitization (FR-17), dedupe rules (§4.6.4).
 * Statements are prepared once per connection (§4.13).
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

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
  source: "telegram" | "fixture";
  /** Fixture-only: absolute path to a local file standing in for Telegram. */
  filePath: string | null;
  addedAt: number;
}

export type UpsertTrack = Omit<TrackRow, "rowid" | "addedAt">;

const SCHEMA_VERSION = "1";
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
      addedAt     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tracks_chat_msg ON tracks(chatId, msgId);
    CREATE INDEX IF NOT EXISTS tracks_docid ON tracks(docId);

    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
      title, artist, album, fileName,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  const meta = db.prepare<{ v: string }>(
    "INSERT INTO meta(key, value) VALUES('schema_version', @v) ON CONFLICT(key) DO NOTHING",
  );
  meta.run({ v: SCHEMA_VERSION });
}

/* --------------------------------------------------------------- write path */

export function upsertTrack(db: Database.Database, t: UpsertTrack): void {
  const run = db.transaction((track: UpsertTrack) => {
    // FTS is synced manually against the tracks rowid (§4.6.3); replace = delete+insert
    stmts(db).deleteRowForTrack.run({ id: track.id, chatId: track.chatId, msgId: track.msgId });
    const info = stmts(db).insertTrack.run({ ...track, addedAt: Date.now() });
    stmts(db).insertFts.run({
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

/* ---------------------------------------------------------------- cursors (FR-14) */

/** Oldest-rowids list used to trim `tracks` down to MAX_INDEX_ENTRIES (§4.6, keep newest). */
export function oldestTrackRowids(db: Database.Database, limit: number): Array<{ rowid: number; id: string }> {
  if (limit <= 0) return [];
  const rows = stmts(db).oldestIds.all({ limit }) as Array<{ rowid: number; id: string }>;
  return rows.map((r) => ({ rowid: Number(r.rowid), id: r.id }));
}

export function getCursor(db: Database.Database, chatId: number): number {
  const row = stmts(db).getCursor.get({ key: `cursor:${chatId}` }) as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function setCursor(db: Database.Database, chatId: number, minId: number): void {
  stmts(db).setCursor.run({ key: `cursor:${chatId}`, value: String(minId) });
}

/** Every stored sync cursor (used by the Redis snapshot export, §4.11). */
export function listCursors(db: Database.Database): Array<{ chatId: number; cursor: number }> {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'cursor:%'").all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Array<{ chatId: number; cursor: number }> = [];
  for (const r of rows) {
    const chatId = Number(r.key.slice("cursor:".length));
    const cursor = Number(r.value);
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
                          source, filePath, addedAt)
      VALUES (@id, @chatId, @msgId, @title, @artist, @album, @duration, @mime, @size,
              @fileName, @codec, @container, @lossless, @bitrateKbps, @docId,
              @source, @filePath, @addedAt)
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
  addedAt: number;
  r: number; // bm25 rank, lower is better
}

/**
 * Full search pipeline (§4.6.4): AND first, OR fallback (<5 rows), bm25 ranking,
 * exact title/artist boost, near-identical dedupe (same normalized title+artist,
 * duration within ±2 s; lossless first, then larger file). Max `limit` (25).
 */
export function searchTracks(db: Database.Database, rawQuery: string | undefined | null, limit = 25): TrackRow[] {
  const q = ftsQuery(rawQuery);
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

  const normTokens = normalizeText(rawQuery ?? "").split(" ").filter(Boolean);
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

  // dedupe near-identical tracks (same normalized title+artist, duration ±2 s)
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
    } else {
      // prefer lossless, then larger file (§4.6.4)
      const better =
        (row.lossless === 1 && g.best.lossless !== 1) ||
        (row.lossless === g.best.lossless && (g.best.size ?? 0) < (row.size ?? 0));
      if (better) {
        const tr = trackOf(row);
        kept[kept.indexOf(g.best)] = tr;
        g.best = tr;
        g.dur = dur;
      }
    }
  }
  return kept.slice(0, limit);
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
    source: r.source === "fixture" ? "fixture" : "telegram",
    filePath: r.filePath,
    addedAt: r.addedAt,
  };
}

/* --------------------------------------------------------------- statements */

interface Statements {
  insertTrack: Database.Statement<Record<string, unknown>>;
  deleteRowForTrack: Database.Statement<{ id: string; chatId: number; msgId: number }>;
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
                            fileName, codec, container, lossless, bitrateKbps, docId, source, filePath, addedAt)
        VALUES (@id, @chatId, @msgId, @title, @artist, @album, @duration, @mime, @size,
                @fileName, @codec, @container, @lossless, @bitrateKbps, @docId, @source, @filePath, @addedAt)
      `),
      deleteRowForTrack: db.prepare(`
        DELETE FROM tracks WHERE id = @id OR (chatId = @chatId AND msgId = @msgId)
      `),
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
      getCursor: db.prepare("SELECT value FROM meta WHERE key = @key"),
      setCursor: db.prepare(`
        INSERT INTO meta(key, value) VALUES(@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = @value
      `),
    };
    stmtCache.set(db, s);
  }
  return s;
}
