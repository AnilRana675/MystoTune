/** Protocol conformance (§4.2/4.3/4.4): manifest, search, stream, media. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_ID } from "./util.js";
import { buildTestServer, TEST_SECRET, fetchJson, type TestServer } from "./util.js";
import { packageVersion } from "../src/config.js";
import { createMediaToken } from "../src/sign.js";

let ts: TestServer;
const S = TEST_SECRET;

test.before(async () => {
  ts = await buildTestServer();
});
test.after(async () => {
  await ts.cleanup();
});

/* ------------------------------------------------------------------ manifest */

test("manifest: full contract shape", async () => {
  const res = await fetchJson(ts, `/${S}/manifest.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const m = await res.json() as any;
  assert.equal(typeof m.id, "string");
  assert.ok(m.id.length > 0);
  assert.equal(typeof m.name, "string");
  assert.ok(m.name.length > 0);
  assert.equal(typeof m.version, "string");
  assert.deepEqual(m.resources, ["search", "stream"]);
  assert.equal(typeof m.allowDownloads, "number"); // 0|1
  assert.equal(typeof m.checkValidLossless, "number");
});

test("manifest: wrong secret is a 404 without leaking", async () => {
  const res = await fetchJson(ts, `/wrongsecret-wrongsecret-wrongsecret-aa/manifest.json`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.ok(body.includes("<") === false && body.length < 32);
});

/* ------------------------------------------------------------------ healthz */

test("healthz: minimal public shape (ok + mode only)", async () => {
  const res = await fetchJson(ts, "/healthz");
  assert.equal(res.status, 200);
  const h = (await res.json() as any) as Record<string, unknown>;
  assert.equal(h.ok, true);
  assert.equal(typeof h.mode, "string");
  // M7.5 privacy split: the unauthenticated route must leak nothing else.
  assert.deepEqual(Object.keys(h).sort(), ["mode", "ok"]);
});

test("status: secret-gated ops diagnostics (moved off public healthz)", async () => {
  const res = await fetchJson(ts, `/${S}/status`);
  assert.equal(res.status, 200);
  const s = (await res.json() as any) as Record<string, unknown>;
  // M7.14.2: the running build version is visible in /status and mirrors the
  // manifest version (no ADDON_VERSION override in this harness env)
  assert.equal(s.version, packageVersion(), "status version mirrors the package/manifest version");
  for (const k of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers", "indexCount"]) {
    assert.equal(typeof s[k], "number", k);
  }
  assert.equal(typeof s.indexing, "boolean");
  assert.equal(typeof s.telegram, "string");
  assert.ok(Array.isArray(s.lastSearches), "lastSearches is secret-gated");
  const counters = s.counters as Record<string, unknown>;
  for (const k of ["searches", "streams", "media", "bytes"]) {
    assert.equal(typeof counters[k], "number", `counters.${k}`);
  }
  // M7.6: the ring records raw query strings and keeps exactly the newest ten.
  for (let i = 1; i <= 11; i++) {
    await fetchJson(ts, `/${S}/search?q=${encodeURIComponent(`probe${i}`)}`);
  }
  const s2 = (await (await fetchJson(ts, `/${S}/status`)).json() as any) as Record<string, unknown>;
  const ring = s2.lastSearches as string[];
  assert.equal(ring.length, 10, "lastSearches caps at ten");
  assert.deepEqual(ring.slice(-10), Array.from({ length: 10 }, (_, i) => `probe${i + 2}`));
});

test("status: ADDON_VERSION env overrides the package version (M7.14.2)", async () => {
  const ts2 = await buildTestServer({ extraEnv: { ADDON_VERSION: "9.9.9-test" } });
  try {
    const body = (await (await fetchJson(ts2, `/${S}/status`)).json() as any) as Record<string, unknown>;
    assert.equal(body.version, "9.9.9-test", "explicit env wins over packageVersion()");
    assert.notEqual(body.version, packageVersion(), "asserted against the override, not the package value");
  } finally {
    await ts2.cleanup();
  }
});

/* ------------------------------------------------- M7.9 status byte sizes */

test("status: per-channel + total byte sizes behind TRACK_SIZE_STATS (off by default)", async () => {
  // off: the keys are simply absent (default keeps /status lean)
  const offBody = (await (await fetchJson(ts, `/${S}/status`)).json() as any) as Record<string, unknown>;
  assert.equal(offBody.totalBytes, undefined, "no byte total without TRACK_SIZE_STATS");
  assert.equal(offBody.byChannel, undefined, "no byChannel without TRACK_SIZE_STATS");

  // on: one GROUP BY pass feeds totalBytes + byChannel
  const ts2 = await buildTestServer({ extraEnv: { TRACK_SIZE_STATS: "1" } });
  try {
    const body = (await (await fetchJson(ts2, `/${S}/status`)).json() as any) as Record<string, unknown>;
    assert.equal(typeof body.totalBytes, "number", "totalBytes present");
    assert.ok((body.totalBytes as number) > 0, "fixture rows carry real byte sizes");
    const chan = (body.byChannel as Array<{ chatId: number; count: number; bytes: number }>).find(
      (c) => c.chatId === CHAT_ID,
    );
    assert.ok(chan, "fixture channel listed in byChannel");
    assert.ok(chan.count >= 1, "per-channel count matches");
    assert.equal(chan.bytes, body.totalBytes, "single-channel fixture: channel size == total");
  } finally {
    await ts2.cleanup();
  }
});

/* ------------------------------------------------------------------- search */

const ID_RE = /^tg_n?\d+_\d+$/;

test("search: returns protocol rows", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=midnight`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json() as any;
  assert.ok(Array.isArray(body.tracks));
  assert.ok(body.tracks.length > 0);
  for (const t of body.tracks) {
    assert.match(t.id, ID_RE);
    assert.ok(typeof t.title === "string" && t.title.length > 0);
    if (t.artist !== null) assert.equal(typeof t.artist, "string");
    assert.equal(typeof t.format, "string");
    assert.ok(["LOSSLESS", "HIGH", "LOW"].includes(t.audioQuality));
    if (t.duration !== null) assert.ok(Number.isInteger(t.duration));
    // §4.3: rows carry only known fields
    for (const key of Object.keys(t)) {
      assert.ok(
        ["id", "title", "artist", "album", "duration", "format", "audioQuality"].includes(key),
        `unexpected field ${key}`,
      );
    }
  }
});

test("search: empty and hostile q return 200 with empty tracks", async () => {
  for (const q of ["", "  ", "???", '"', ":", "*", "-", "*", "'"]) {
    const res = await fetchJson(ts, `/${S}/search?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, `q=${q}`);
    assert.deepEqual((await res.json() as any).tracks, [], `q=${q}`);
  }
});

test("search: missing q returns 200", async () => {
  const res = await fetchJson(ts, `/${S}/search`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as any).tracks, []);
});

test("search: §4.6.4 dedupe - same song lossless and mp3 collapse to one lossless row", async () => {
  const res = await fetchJson(ts, `/${S}/search?q=midnight`);
  const tracks = (await res.json() as any).tracks;
  const flags = tracks.filter((t: { title: string }) => /midnight/i.test(t.title));
  assert.equal(flags.length, 1, "deduped to one row");
  assert.equal(flags[0].audioQuality, "LOSSLESS");
});

/* ------------------------------------------------------------------- stream */

test("stream: unknown id is 404 with empty body", async () => {
  const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_999`);
  assert.equal(res.status, 404);
  const t = await res.text();
  assert.ok(t.length < 3); // "{}" or ""
});

test("stream garbage id is 404", async () => {
  const res = await fetchJson(ts, `/${S}/stream/not-a-track-id`);
  assert.equal(res.status, 404);
});

test("stream: known fixture returns signed media URL", async () => {
  const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const s = (await res.json() as any) as Record<string, unknown>;
  assert.equal(s.manifest, "none");
  assert.equal(s.encrypted, false);
  assert.equal(s.codec, "flac");
  assert.equal(s.container, "flac");
  assert.equal(s.format, "flac");
  assert.equal(s.quality, "Lossless · FLAC");
  assert.equal(typeof s.url, "string");
  assert.ok((s.url as string).startsWith(`${ts.baseUrl}/media/`));
});

test("stream: mp3 320k and 96k both label Lossy · MP3", async () => {
  const hi = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_2`)).json() as any;
  assert.equal(hi.quality, "Lossy · MP3");
  assert.equal(hi.codec, "mp3");
  const lo = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_3`)).json() as any;
  assert.equal(lo.quality, "Lossy · MP3");
  assert.equal(lo.codec, "mp3");
});

/* -------------------------------------------------------------------- media */

const KEY = Buffer.alloc(32, 7);
const tr = (i: number) => ts.tracks[i]!; // tracks exist once before() ran

test("media: HEAD declares range support without a body", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const res = await fetch(`${s.url as string}`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.match(res.headers.get("etag") ?? "", /^"?\d+-\d+"?$/);
  assert.equal(res.headers.get("cache-control"), "private, max-age=300");
  assert.match(res.headers.get("content-type") ?? "", /flac/);
  const body = await res.text();
  assert.equal(body, "");
  const size = Number(res.headers.get("content-length"));
  assert.equal(size, tr(0).size);
});

test("media: Range 0-99 is 206 with exact bytes", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const res = await fetch(`${s.url as string}`, { headers: { range: "bytes=0-99" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), "100");
  assert.equal(res.headers.get("content-range"), `bytes 0-99/${tr(0).size}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
  const expected = readFileSync(tr(0).filePath!).subarray(0, 100);
  assert.deepEqual(buf, expected);
});

test("media: full GET is 200 with total length", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const res = await fetch(`${s.url as string}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(tr(0).size));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, tr(0).size);
  assert.deepEqual(buf, readFileSync(tr(0).filePath!));
});

test("media: tampered signature is 403", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const token = (s.url as string).split("/media/")[1]!;
  const [payload, sig] = token.split(".");
  const flipped = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
  const res = await fetch(`${ts.baseUrl}/media/${payload}.${flipped}`, {
    headers: { range: "bytes=0-99" },
  });
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.ok(body.length < 8); // no reason disclosure
});

test("media: expired token is 403", async () => {
  const token = createMediaToken(tr(0).id, KEY, -10);
  const res = await fetch(`${ts.baseUrl}/media/${token}`);
  assert.equal(res.status, 403);
});

test("media: If-Range mismatch falls back to full 200", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const res = await fetch(`${s.url as string}`, {
    headers: { range: "bytes=0-99", "if-range": '"99999-1"' },
  });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get("content-length")), tr(0).size);
});

test("media: If-Range match honours the slice", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const head = await fetch(s.url as string, { method: "HEAD" });
  const etag = head.headers.get("etag")!;
  const res = await fetch(`${s.url as string}`, {
    headers: { range: "bytes=0-99", "if-range": etag },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), "100");
});

test("media: out-of-bounds range is 416 with */total", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`)).json() as any;
  const res = await fetch(`${s.url as string}`, {
    headers: { range: `bytes=${tr(0).size! + 5}-${tr(0).size! + 10}` },
  });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), `bytes */${tr(0).size}`);
});

test("media: open-ended range runs to EOF", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_2`)).json() as any;
  const size = tr(1).size!;
  const res = await fetch(`${s.url as string}`, { headers: { range: `bytes=${size - 10}-` } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), "10");
});

test("media: suffix range returns last N bytes", async () => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_2`)).json() as any;
  const size = tr(1).size!;
  const res = await fetch(`${s.url as string}`, { headers: { range: `bytes=-7` } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-length"), "7");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(buf, readFileSync(tr(1).filePath!).subarray(size - 7));
});
