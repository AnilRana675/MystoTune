/**
 * M7 discovery tests (typed search grammar).
 *
 * M7.0 table-driven lexer checks: every typed token lands in the right slot,
 * degenerate input degrades harmlessly (unbalanced quotes, junk values,
 * unknown prefixes, empty operator values).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isStructured, parseQuery, type ParsedQuery } from "../src/query.js";

test("query: plain free text parses unchanged (legacy behavior)", () => {
  const q = parseQuery("morning jazz");
  assert.equal(q.free, "morning jazz");
  assert.deepEqual(q.phrases, []);
  assert.deepEqual(q.artist, []);
  assert.deepEqual(q.album, []);
  assert.deepEqual(q.title, []);
  assert.equal(q.lossless, false);
  assert.equal(q.durVal, null);
  assert.equal(q.recentDays, null);
  assert.equal(q.sort, "relevance");
  assert.equal(isStructured(q), false);
});

test("query: empty / hostile input still parses", () => {
  for (const raw of [null, undefined, "", "   "]) {
    const q = parseQuery(raw as string | undefined | null);
    assert.equal(q.free, "");
    assert.equal(isStructured(q), false);
  }
});

/* ---------------------------------------------- lexer table (M7.0) */

interface Row {
  name: string;
  raw: string;
  check: (q: ParsedQuery) => unknown;
  want: unknown;
}

const TABLE: Row[] = [
  {
    name: "bare quoted phrase",
    raw: '"night sky" blue',
    check: (q) => [q.phrases, q.free, isStructured(q)],
    want: [["night sky"], "blue", true],
  },
  {
    name: "scoped single word",
    raw: "artist:adele",
    check: (q) => [q.artist, q.free],
    want: [["adele"], ""],
  },
  {
    name: "scoped multiword via quotes",
    raw: 'artist:"depeche mode" album:violator',
    check: (q) => [q.artist, q.album],
    want: [["depeche mode"], ["violator"]],
  },
  {
    name: "title scope multiword",
    raw: 'title:"gta vice city"',
    check: (q) => q.title,
    want: ["gta vice city"],
  },
  {
    name: "phrase + scope mix",
    raw: '"midnight" artist:m83',
    check: (q) => [q.phrases, q.artist],
    want: [["midnight"], ["m83"]],
  },
  {
    name: "case-insensitive operator, value case kept",
    raw: "ARTIST:Adele",
    check: (q) => q.artist,
    want: ["Adele"],
  },
  {
    name: "duration >= < <= > =",
    raw: "dur:>=300",
    check: (q) => [q.durOp, q.durVal],
    want: [">=", 300],
  },
  {
    name: "duration default operator is =",
    raw: "dur:200",
    check: (q) => [q.durOp, q.durVal],
    want: ["=", 200],
  },
  {
    name: "duration upper bounds",
    raw: "dur:<180 dur:<=90 dur:>45",
    check: (q) => [q.durOp, q.durVal],
    want: [">", 45],
  },
  {
    name: "duration junk value dropped",
    raw: "dur:soon",
    check: (q) => [q.durOp, q.durVal],
    want: [null, null],
  },
  {
    name: "recent: days with optional d suffix",
    raw: "recent:7d",
    check: (q) => q.recentDays,
    want: 7,
  },
  {
    name: "recent: bare number is days too",
    raw: "recent:30",
    check: (q) => q.recentDays,
    want: 30,
  },
  {
    name: "recent: 0-day window dropped, junk dropped (last wins)",
    raw: "recent:0 recent:soon",
    check: (q) => q.recentDays,
    want: null,
  },
  {
    name: "sort modes parse",
    raw: "sort:oldest",
    check: (q) => q.sort,
    want: "oldest",
  },
  {
    name: "unknown sort value ignored",
    raw: "sort:nonsense",
    check: (q) => q.sort,
    want: "relevance",
  },
  {
    name: "bare lossless filter",
    raw: "m83 lossless",
    check: (q) => [q.lossless, q.free],
    want: [true, "m83"],
  },
  {
    name: "scoped lossless stays a term, not a filter",
    raw: "artist:lossless",
    check: (q) => [q.lossless, q.artist],
    want: [false, ["lossless"]],
  },
  {
    name: "quoted lossless stays a phrase, not a filter",
    raw: '"lossless"',
    check: (q) => [q.lossless, q.phrases],
    want: [false, ["lossless"]],
  },
  {
    name: "unknown prefix degrades to free text",
    raw: "genre:bossa nova",
    check: (q) => q.free,
    want: "genre:bossa nova",
  },
  {
    name: "unbalanced quote degrades to free text",
    raw: 'abc"def ghi',
    check: (q) => q.free,
    want: 'abc"def ghi',
  },
  {
    name: "trailing unmatched quote after a pair",
    raw: '"a b" c"d',
    check: (q) => [q.phrases, q.free],
    want: [["a b"], 'c"d'],
  },
  {
    name: "empty operator value degrades to free text",
    raw: "artist:",
    check: (q) => q.free,
    want: "artist:",
  },
  {
    name: "multiple scoped terms in one field are kept (AND later)",
    raw: "artist:adele artist:xyz",
    check: (q) => q.artist,
    want: ["adele", "xyz"],
  },
];

test("query: lexer table", () => {
  for (const row of TABLE) {
    const q = parseQuery(row.raw);
    assert.deepEqual(row.check(q), row.want, `lexer: ${row.name}`);
  }
});

/* ===================== M7.1-M7.2 grammar bindings ===================== */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSchema, openDb, searchTracks, upsertTrack, type TrackRow } from "../src/db.js";
import { buildTestServer, TEST_SECRET } from "./util.js";

/* /tmp is read-only in some dev sandboxes; /tmp/opencode is the approved base */
const tmpBase = existsSync("/tmp/opencode") ? "/tmp/opencode" : os.tmpdir();

function titleOf(rows: TrackRow[]): string[] {
  return rows.map((r) => r.title);
}

const mk = (
  n: number,
  title: string,
  artist: string,
  album: string | null,
  duration: number,
  lossless: 0 | 1,
  mime: string,
  container: string,
  ageDays: number,
): Parameters<typeof upsertTrack>[1] => ({
  id: `tg_-7001_${11 + n}`,
  chatId: -7001,
  msgId: 11 + n,
  title,
  artist,
  album,
  duration,
  mime,
  size: lossless ? 9000 : 3000,
  fileName: `${title.toLowerCase().replace(/\s+/g, "-")}.${container}`,
  codec: null,
  container,
  lossless,
  bitrateKbps: null,
  docId: 11 + n,
  source: "telegram",
  filePath: null,
  hasThumb: 0,
  addedAt: Date.now() - ageDays * 86_400_000,
});

test("search: typed grammar filters, phrases, scoped fields, explicit sorts", () => {
  const dir = mkdtempSync(path.join(tmpBase, "m7-grammar-"));
  const db = openDb(path.join(dir, "g.sqlite"));
  try {
    createSchema(db);
    upsertTrack(db, mk(0, "Midnight City", "M83", "Hurry", 244, 0, "audio/mpeg", "mp3", 100));
    upsertTrack(db, mk(1, "Midnight City", "M83", "Hurry", 243, 1, "audio/flac", "flac", 50));
    upsertTrack(db, mk(2, "Skinny Love", "Birdy", null, 180, 0, "audio/mpeg", "mp3", 10));
    upsertTrack(db, mk(3, "Day Glow", "Aesop Rock", "Skelethon", 320, 1, "audio/flac", "flac", 0.04));
    upsertTrack(db, mk(4, "Lossless", "X", null, 100, 0, "audio/mpeg", "mp3", 2));

    /* legacy parity: plain text behaves exactly like pre-M7 (dedupe keeps lossless) */
    assert.deepEqual(titleOf(searchTracks(db, "midnight")), ["Midnight City"]);
    assert.equal(searchTracks(db, "midnight")[0]?.mime, "audio/flac");

    /* scoped fields */
    assert.deepEqual(titleOf(searchTracks(db, "artist:m83")), ["Midnight City"]);
    assert.deepEqual(titleOf(searchTracks(db, "album:hurry")), ["Midnight City"]);
    assert.deepEqual(titleOf(searchTracks(db, 'title:"Day Glow"')), ["Day Glow"]);

    /* quoted phrases: adjacency, order matters */
    assert.deepEqual(titleOf(searchTracks(db, '"skinny love"')), ["Skinny Love"]);
    assert.deepEqual(titleOf(searchTracks(db, '"love skinny"')), []);

    /* filters: bare lossless excludes the track merely TITLED lossless */
    assert.deepEqual(titleOf(searchTracks(db, "lossless midnight")), ["Midnight City"]);
    assert.deepEqual(titleOf(searchTracks(db, "lossless X")), []);
    assert.deepEqual(titleOf(searchTracks(db, "dur:>=300")), ["Day Glow"]);
    assert.deepEqual(titleOf(searchTracks(db, "dur:<200")), ["Skinny Love", "Lossless"]);
    assert.deepEqual(titleOf(searchTracks(db, "dur:180")), ["Skinny Love"]);
    assert.deepEqual(
      [...titleOf(searchTracks(db, "recent:3"))].sort(),
      ["Day Glow", "Lossless"],
    );

    /* explicit sorts over the full-scan pool */
    assert.deepEqual(titleOf(searchTracks(db, "lossless sort:oldest")), ["Midnight City", "Day Glow"]);
    assert.deepEqual(titleOf(searchTracks(db, "lossless sort:recent")), ["Day Glow", "Midnight City"]);
    assert.deepEqual(titleOf(searchTracks(db, "sort:longest")), [
      "Day Glow",
      "Midnight City",
      "Skinny Love",
      "Lossless",
    ]);

    /* mixed grammar across slots */
    assert.deepEqual(titleOf(searchTracks(db, "artist:birdy dur:<200")), ["Skinny Love"]);
    assert.deepEqual(titleOf(searchTracks(db, "midnight artist:m83")), ["Midnight City"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- M7.6 regression: ordering, dedupe survivor, binding parity ---------------- */

function row(n: number, title: string, artist: string, duration: number, lossless: number, ageDays: number, mime = "audio/mpeg", container = "mp3") {
  return {
    id: `tg_n-7199_${100 + n}`,
    chatId: -7199,
    msgId: 100 + n,
    title,
    artist,
    album: null,
    duration,
    mime,
    size: lossless ? 9000 + n : 400 + n,
    fileName: `${title.toLowerCase().replace(/\s+/g, "-")}.${container}`,
    codec: null,
    container,
    lossless,
    bitrateKbps: null,
    docId: 700 + n,
    source: "telegram" as const,
    filePath: null,
    hasThumb: 0,
    addedAt: Date.now() - Math.round(ageDays * 86_400_000),
  };
}

test("search: explicit sorts read one globally ordered OR pool (no unsorted fallback tail)", () => {
  const dir = mkdtempSync(path.join(tmpBase, "m7-or-order-"));
  const db = openDb(path.join(dir, "o.sqlite"));
  try {
    createSchema(db);
    upsertTrack(db, row(0, "T400", "Beta", 400, 0, 20));
    upsertTrack(db, row(1, "T300", "Beta", 300, 0, 21));
    upsertTrack(db, row(2, "T200", "Beta", 200, 0, 22));
    upsertTrack(db, row(3, "T100", "Alpha", 100, 0, 23));
    upsertTrack(db, row(4, "T50", "Beta", 50, 0, 24));
    // AND pool (artist:alpha* AND beta*) is empty; OR pool holds all five and
    // must carry the sort order itself (pre-fix tail was bm25-ordered).
    assert.deepEqual(titleOf(searchTracks(db, "artist:alpha beta sort:longest")), [
      "T400",
      "T300",
      "T200",
      "T100",
      "T50",
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: near-dup survivor follows the active sort, not always lossless", () => {
  const dir = mkdtempSync(path.join(tmpBase, "m7-dedupe-sort-"));
  const db = openDb(path.join(dir, "d.sqlite"));
  try {
    createSchema(db);
    upsertTrack(db, row(0, "Dup Song", "ArtistX", 240, 1, 30, "audio/flac", "flac")); // older lossless
    upsertTrack(db, row(1, "Dup Song", "ArtistX", 241, 0, 2)); // newer lossy
    const recent = searchTracks(db, "dup sort:recent");
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.mime, "audio/mpeg", "sort:recent keeps the newest copy");
    const oldest = searchTracks(db, "dup sort:oldest");
    assert.equal(oldest.length, 1);
    assert.equal(oldest[0]?.mime, "audio/flac", "sort:oldest keeps the oldest copy");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: dropped grammar tokens never resurface as keywords (path parity)", () => {
  const dir = mkdtempSync(path.join(tmpBase, "m7-binding-"));
  const db = openDb(path.join(dir, "b.sqlite"));
  try {
    createSchema(db);
    upsertTrack(db, row(0, "Dur Soon", "Zed", 120, 0, 3));
    upsertTrack(db, row(1, "Lossless One", "Zed", 200, 1, 4, "audio/flac", "flac"));
    // legacy path (no structured clause survives): junk operator fully dropped
    assert.deepEqual(titleOf(searchTracks(db, "dur:soon")), []);
    // structured path (a filter is present): junk operator dropped identically
    assert.deepEqual(titleOf(searchTracks(db, "dur:soon lossless")), ["Lossless One"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: HTTP route serves typed grammar (sort:longest end to end)", async () => {
  const ts = await buildTestServer();
  try {
    const res = await fetch(`${ts.baseUrl}/${TEST_SECRET}/search?q=${encodeURIComponent("sort:longest")}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tracks: Array<{ duration?: number | null }> };
    assert.ok(Array.isArray(body.tracks) && body.tracks.length > 0);
    const durs = body.tracks.map((t) => t.duration ?? -1);
    assert.deepEqual(durs, [...durs].sort((a, b) => b - a));
  } finally {
    await ts.cleanup();
  }
});

/* ---------------- M7.7 BitChord-compat + edge-case regressions ---------------- */

test("search: explicit sorts are strict-first (AND pool wins when it has >= 5 rows)", () => {
  const dir = mkdtempSync(path.join(tmpBase, "m7-strict-sort-"));
  const db = openDb(path.join(dir, "s.sqlite"));
  try {
    createSchema(db);
    for (let i = 0; i < 5; i++) upsertTrack(db, row(i, `Strict ${i}`, "Alpha Beta", 100 + i * 10, 0, 2 + i));
    upsertTrack(db, row(9, "Long Or", "Alpha", 999, 0, 1)); // OR-only, longest overall
    const titles = titleOf(searchTracks(db, "artist:alpha beta sort:longest"));
    assert.deepEqual(titles, ["Strict 4", "Strict 3", "Strict 2", "Strict 1", "Strict 0"]);
    assert.ok(!titles.includes("Long Or"), "OR-only row must not leak when the AND pool is rich");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: empty phrase returns nothing; sort:relevance alone is a browse window", () => {
  const dir = mkdtempSync(path.join(tmpBase, "m7-browse-"));
  const db = openDb(path.join(dir, "q.sqlite"));
  try {
    createSchema(db);
    upsertTrack(db, row(0, "Browse A", "YA", 100, 0, 1));
    upsertTrack(db, row(1, "Browse B", "YB", 200, 0, 2));
    assert.deepEqual(titleOf(searchTracks(db, '""')), [], "empty phrase must not browse the library");
    assert.deepEqual(titleOf(searchTracks(db, 'artist:"..."')), [], "punctuation-only scope is empty, not a browse");
    assert.deepEqual(titleOf(searchTracks(db, 'artist:""')), [], "empty scoped phrase is empty, not a browse");
    assert.equal(titleOf(searchTracks(db, "sort:relevance")).length, 2, "explicit sort:relevance browses");
    assert.deepEqual(titleOf(searchTracks(db, "sort:longest")), ["Browse B", "Browse A"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream: bitrate in bps and wav format for PCM rows (BitChord compat)", async () => {
  const ts = await buildTestServer();
  try {
    const fixture = ts.db.prepare("SELECT id FROM tracks LIMIT 1").get() as { id: string };
    ts.db
      .prepare(
        "UPDATE tracks SET bitrateKbps = 320, mime = 'audio/wav', fileName = 'compat.wav', codec = 'pcm', container = 'wav' WHERE id = @id",
      )
      .run({ id: fixture.id });
    const res = await fetch(`${ts.baseUrl}/${TEST_SECRET}/stream/${encodeURIComponent(fixture.id)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { format?: string; bitrate?: number; container?: string };
    assert.equal(body.format, "wav", "pcm codec advertises wav (BitChord unknown-codec fallback)");
    assert.equal(body.bitrate, 320000, "kbps stored -> bps on the wire");
    assert.equal(body.container, "wav");

    // AIFF PCM must advertise aiff, not the raw "pcm" codec label
    const second = ts.db.prepare("SELECT id FROM tracks LIMIT 1 OFFSET 1").get() as { id: string };
    ts.db
      .prepare(
        "UPDATE tracks SET bitrateKbps = NULL, mime = 'audio/aiff', fileName = 'compat.aiff', codec = 'pcm', container = 'aiff' WHERE id = @id",
      )
      .run({ id: second.id });
    const aiff = await fetch(`${ts.baseUrl}/${TEST_SECRET}/stream/${encodeURIComponent(second.id)}`);
    assert.equal(aiff.status, 200);
    const aiffBody = (await aiff.json()) as { format?: string; container?: string };
    assert.equal(aiffBody.format, "aiff", "pcm in an aiff container advertises aiff");
    assert.equal(aiffBody.container, "aiff");
  } finally {
    await ts.cleanup();
  }
});
