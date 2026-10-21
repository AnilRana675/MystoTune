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
