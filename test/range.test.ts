/** §10: 50 deterministic byte-exact slices incl. 200/206/416 semantics. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTestServer, TEST_SECRET, fetchJson, type TestServer } from "./util.js";

let ts: TestServer;
test.before(async () => {
  ts = await buildTestServer();
});
test.after(async () => {
  await ts.cleanup();
});

const S = TEST_SECRET;
const mediaUrl = async (msgId: number): Promise<string> => {
  const s = await (await fetchJson(ts, `/${S}/stream/tg_n1001234567890_${msgId}`)).json() as any;
  return s.url as string;
};

/** mulberry32 — deterministic slice picks so failures reproduce. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("50 random slices byte-exact against source files", async () => {
  const flac = ts.tracks[0]!; // .flac
  const mp3 = ts.tracks[1]!; // .mp3
  const cases = [flac, mp3];
  const rnd = prng(0xb17c04d);

  let n = 0;
  for (let i = 0; i < 50; i++) {
    const track = cases[i % 2]!;
    const src = readFileSync(track.filePath!);
    const size = src.length;
    const url = await mediaUrl(track.msgId);

    // pick a slice: B-C, B-, -suffix, full
    const style = n++ % 4;
    let range: string;
    let expectStart: number;
    let expectEnd: number;
    let expectStatus: number;
    if (style === 0) {
      const b = rint(rnd, 0, size - 2);
      const e = rint(rnd, b, size - 1);
      range = `bytes=${b}-${e}`;
      expectStart = b;
      expectEnd = e;
      expectStatus = 206;
    } else if (style === 1) {
      const b = rint(rnd, 0, size - 1);
      range = `bytes=${b}-`;
      expectStart = b;
      expectEnd = size - 1;
      expectStatus = 206;
    } else if (style === 2) {
      const k = rint(rnd, 1, Math.min(4096, size));
      range = `bytes=-${k}`;
      expectStart = size - k;
      expectEnd = size - 1;
      expectStatus = 206;
    } else {
      range = "";
      expectStart = 0;
      expectEnd = size - 1;
      expectStatus = 200;
    }

    const res = await fetch(url, range ? { headers: { range } } : undefined);
    assert.equal(res.status, expectStatus, `case ${i} range ${range}`);
    if (expectStatus === 206) {
      assert.equal(
        res.headers.get("content-range"),
        `bytes ${expectStart}-${expectEnd}/${size}`,
        `case ${i} range ${range}`,
      );
    }
    assert.equal(res.headers.get("accept-ranges"), "bytes", `case ${i} headers`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.length, expectEnd - expectStart + 1, `case ${i} length Range ${range}`);
    assert.deepEqual(
      buf,
      src.subarray(expectStart, expectEnd + 1),
      `case ${i} bytes Range ${range}`,
    );
  }
});

function rint(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

test("clamped end beyond EOF behaves as EOF slice", async () => {
  const url = await mediaUrl(ts.tracks[0]!.msgId);
  const res = await fetch(url, { headers: { range: `bytes=0-99999999` } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 0-${ts.tracks[0]!.size! - 1}/${ts.tracks[0]!.size}`);
});

test("416 for out-of-bounds starts", async () => {
  const url = await mediaUrl(ts.tracks[0]!.msgId);
  const res = await fetch(url, { headers: { range: `bytes=${ts.tracks[0]!.size! + 1}-` } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), `bytes */${ts.tracks[0]!.size}`);
});

test("malformed range headers fall back to full 200", async () => {
  const url = await mediaUrl(ts.tracks[0]!.msgId);
  for (const bad of ["items=0-99", "bytes=zz-yy", "bytes="]) {
    const res = await fetch(url, { headers: { range: bad } });
    assert.equal(res.status, 200, `Range ${bad}`);
  }
});

test("inverted range (start > end) is unsatisfiable 416", async () => {
  const url = await mediaUrl(ts.tracks[0]!.msgId);
  const res = await fetch(url, { headers: { range: "bytes=5-1" } });
  assert.equal(res.status, 416);
});

/* ------------------------------- M5 delta: explicit suffix / open-ended */

test("suffix -N is byte-exact (explicit cases)", async () => {
  const flac = ts.tracks[0]!;
  const src = readFileSync(flac.filePath!);
  const size = src.length;
  const url = await mediaUrl(flac.msgId);
  for (const k of [2048, 7]) {
    const res = await fetch(url, { headers: { range: `bytes=-${k}` } });
    assert.equal(res.status, 206, `suffix -${k}`);
    assert.equal(
      res.headers.get("content-range"),
      `bytes ${size - k}-${size - 1}/${size}`,
      `suffix -${k}`,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, src.subarray(size - k, size), `suffix -${k} bytes`);
  }
});

test("open-ended X- is byte-exact from X to EOF (explicit cases)", async () => {
  const flac = ts.tracks[0]!;
  const src = readFileSync(flac.filePath!);
  const size = src.length;
  const url = await mediaUrl(flac.msgId);
  for (const start of [4096, size - 1]) {
    const res = await fetch(url, { headers: { range: `bytes=${start}-` } });
    assert.equal(res.status, 206, `open ${start}`);
    assert.equal(
      res.headers.get("content-range"),
      `bytes ${start}-${size - 1}/${size}`,
      `open ${start}`,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, src.subarray(start, size), `open ${start} bytes`);
  }
});

test("zero suffix is 416; oversized suffix saturates to the whole file (RFC 7233)", async () => {
  const flac = ts.tracks[0]!;
  const src = readFileSync(flac.filePath!);
  const size = src.length;
  const url = await mediaUrl(flac.msgId);
  const bad = await fetch(url, { headers: { range: "bytes=-0" } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), `bytes */${size}`);

  const all = await fetch(url, { headers: { range: "bytes=-999999999" } });
  assert.equal(all.status, 206, "suffix longer than the file yields all bytes");
  assert.equal(all.headers.get("content-range"), `bytes 0-${size - 1}/${size}`);
  const buf = Buffer.from(await all.arrayBuffer());
  assert.deepEqual(buf, src);
});

test("FR-19 delta: same-token overlapping ranges run together", async () => {
  const flac = ts.tracks[0]!;
  const src = readFileSync(flac.filePath!);
  const size = src.length;
  const url = await mediaUrl(flac.msgId);
  const mid = Math.floor(size / 2);
  // First request spans most of the file ("0-5000000"), a mid-file tail probe
  // runs WHILE it is still streaming — the player's normal interleaving. The
  // same token owns both grants; the mid-file response must not abort the
  // first one (old one-grant-per-token semantics would have failed here).
  const first = fetch(url, { headers: { range: "bytes=0-5000000" } });
  const second = fetch(url, { headers: { range: `bytes=${mid}-${mid + 100}` } });
  const [r1, r2] = await Promise.all([first, second]);
  const expectEnd = Math.min(5_000_000, size - 1);
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get("content-range"), `bytes 0-${expectEnd}/${size}`);
  const buf1 = Buffer.from(await r1.arrayBuffer());
  assert.equal(buf1.length, expectEnd + 1);
  assert.deepEqual(buf1, src.subarray(0, expectEnd + 1));
  assert.equal(r2.status, 206);
  assert.equal(r2.headers.get("content-range"), `bytes ${mid}-${mid + 100}/${size}`);
  const buf2 = Buffer.from(await r2.arrayBuffer());
  assert.deepEqual(buf2, src.subarray(mid, mid + 101));
});
