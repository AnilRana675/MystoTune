/** §10 hostile-query battery: sanitization never 5xxes, folding works. */
import test from "node:test";
import assert from "node:assert/strict";
import { upsertTrack } from "../src/db.js";
import { buildTestServer, TEST_SECRET, fetchJson, type TestServer } from "./util.js";
import { audioDescriptor, looksLikeAudio } from "../src/indexer.js";

let ts: TestServer;
const S = TEST_SECRET;
test.before(async () => {
  ts = await buildTestServer();
  // Extra row to prove diacritic folding (NFKD + COMBINING strip → unicode61 remove_diacritics).
  const d = audioDescriptor("audio/mpeg", "Café Standby.mp3", 100_000, 30);
  upsertTrack(ts.db, {
    id: "tg_n1001234567890_77",
    chatId: -1001234567890,
    msgId: 77,
    title: "Café Standby",
    artist: "Séance Mixtape",
    album: null,
    duration: 30,
    mime: "audio/mpeg",
    size: 100_000,
    fileName: "Café Standby.mp3",
    codec: d.codec,
    container: d.container,
    lossless: 0,
    bitrateKbps: d.bitrateKbps,
    docId: 42,
    source: "fixture",
    filePath: ts.tracks[0]!.filePath,
    hasThumb: 0,
  });
});
test.after(async () => {
  await ts.cleanup();
});

const idOk = (t: unknown): boolean =>
  typeof t === "object" && t !== null && typeof (t as { title: unknown }).title === "string";

test("hostile strings never 5xx — always 200 with array", async () => {
  const hostile: Array<[string, number]> = [
    ["", 200],
    ["   ", 200],
    ["???", 200],
    ['"OR"1"="1"', 200],
    ["a' OR 1=1--", 200],
    ["NEAR(/a b) OR c", 200],
    ["&", 200],
    ["-", 200],
    ["=", 200],
    ["*", 200],
    ["\"", 200],
    [":", 200],
    ["\\", 200],
    ["%", 200],
    ["snowman ☃", 200],
    ["🤖🎵🔊", 200],
    ["10.1000/doi.12345", 200],
    ["https://example.com/?q=<script>alert(1)</script>", 200],
    ["a b c d e f g h i j k l m n o p", 200], // 16 tokens > cap of 8
    ["midnight glass vinyl rip [265kbps]", 200],
    ["(fixture strikes.back)\\-\"'", 200],
  ];
  for (const [q, want] of hostile) {
    const res = await fetchJson(ts, `/${S}/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, want, `q=${q}`);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.tracks), `q=${q} body is array`);
    if (body.tracks.length) body.tracks.forEach(idOk);
  }
});

test("diacritic folding: 'cafe' finds 'Café'", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=cafe`);
  assert.equal(res.status, 200);
  const titles = ((await res.json() as any).tracks as Array<{ title: string }>).map((t) => t.title);
  assert.ok(titles.some((t) => /café standby/i.test(t)), JSON.stringify(titles));
});

test("prefix matching: 'midn' finds 'Midnight Glass'", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=midn`);
  const titles = ((await res.json() as any).tracks as Array<{ title: string }>).map((t) => t.title);
  assert.ok(titles.some((t) => /midnight glass/i.test(t)), JSON.stringify(titles));
});

test("multi-word query narrows rows", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=${encodeURIComponent("aurora midnight")}`);
  const rows = (await res.json() as any).tracks as Array<{ title: string; artist: string | null }>;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => /aurora/i.test(`${r.title} ${r.artist ?? ""}`) || /midnight/i.test(r.title)));
});

test("no results q returns empty tracks, still 200", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=zzzqqqxx`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as any).tracks, []);
});

test("urlencoded ampersand + brackets are safe", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=${encodeURIComponent("hum (live) [v0]")}`);
  assert.equal(res.status, 200);
  const rows = (await res.json() as any).tracks as Array<{ title: string }>;
  assert.ok(rows.some((r) => /hum lapel/i.test(r.title)), JSON.stringify(rows));
});

test("audioDescriptor: AIFF variants are lossless PCM with no size-derived bitrate", () => {
  // Regression: .aif and MIME-only AIFF used to fall through to the unknown
  // branch, which fabricated a bitrate from size×8/duration and labelled the
  // row HIGH/Lossy. All AIFF spellings must resolve to lossless PCM instead.
  for (const [mime, name] of [
    ["audio/aiff", "Track.aif"],
    ["audio/x-aiff", "Track.aif"],
    ["application/octet-stream", "Track.aif"],
    ["application/octet-stream", "Track.aiff"],
  ] as const) {
    const d = audioDescriptor(mime, name, 4_000_000, 30);
    assert.equal(d.lossless, true, `${mime}/${name}: lossless`);
    assert.equal(d.codec, "pcm", `${mime}/${name}: codec`);
    assert.equal(d.container, "aiff", `${mime}/${name}: container`);
    assert.equal(d.bitrateKbps, null, `${mime}/${name}: no fake bitrate`);
  }
  // Lossy behaviour stays exactly as verified: the estimate is still supplied.
  const mp3 = audioDescriptor("audio/mpeg", "x.mp3", 4_000_000, 30);
  assert.equal(mp3.lossless, false);
  assert.equal(mp3.bitrateKbps, 1067);
});

test("looksLikeAudio: .aif docs are indexable audio", () => {
  assert.equal(looksLikeAudio("application/octet-stream", "Track.aif"), true);
  assert.equal(looksLikeAudio(null, "Track.aiff"), true);
});
