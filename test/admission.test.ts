/** §10/FR-19: slot accounting, free probes, same-token abort. */
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaToken } from "../src/sign.js";
import { Admissions, AdmissionTimeoutError } from "../src/media.js";
import { buildTestServer, type TestServer } from "./util.js";

let ts: TestServer;
test.before(async () => {
  ts = await buildTestServer({ maxConcurrentStreams: 2, admissionWaitMs: 300 });
});
test.after(async () => {
  await ts.cleanup();
});

const KEY = Buffer.alloc(32, 7);
const urlFor = (i: number): string => {
  const id = ts.tracks[i]!.id;
  return `${ts.baseUrl}/media/${createMediaToken(id, KEY, 600)}`;
};

const health = async (): Promise<{ activeStreams: number }> => {
  const h = await (await fetch(`${ts.baseUrl}/healthz`)).json();
  return h as { activeStreams: number };
};

/**
 * Fetch a full stream, read exactly ONE chunk, then stop pulling. The client
 * applies backpressure, the server stalls on drain, and the slot stays
 * occupied — proving admissions sees an *active* byte stream (§4.14).
 */
async function hold(url: string): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; first: Uint8Array }> {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.ok(res.body, "streaming body");
  const reader = res.body!.getReader();
  const first = (await reader.read()).value!;
  return { reader, first };
}

const done = async (r: { reader: ReadableStreamDefaultReader<Uint8Array> }): Promise<void> => {
  await r.reader.cancel().catch(() => {});
};

test("up to two streams per token coexist; the 3rd evicts the oldest (FR-19 v2.2)", async () => {
  const url = urlFor(6);
  const first = await hold(url);
  await new Promise((r) => setTimeout(r, 80));

  // A player may probe the tail while playing: TWO concurrent grants per token
  const second = await hold(url);
  assert.ok(first.first.byteLength > 0);
  const h2 = await health();
  assert.equal(h2.activeStreams, 2, "two concurrent streams on one token");

  // The THIRD same-token request evicts the oldest grant synchronously
  const third = await hold(url);
  const h3 = await health();
  assert.equal(h3.activeStreams, 2, "evicted one + the new one");

  // the evicted first reader must eventually be closed by the server
  const follow = await (async (): Promise<string> => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 20));
      const r = await first.reader
        .read()
        .then((x) => (x.done ? "done" : "chunk"), () => "error");
      if (r !== "chunk") return r;
    }
  })();
  assert.ok(follow === "done" || follow === "error", `evicted reader state: ${follow}`);

  await done(first);
  await done(second);
  await done(third);
  await new Promise((r) => setTimeout(r, 40));
  const h = await health();
  assert.equal(h.activeStreams, 0, "all slots released after cancels");
});

test("third concurrent full GET queues then 503 Retry-After 2", async () => {
  const a = await hold(urlFor(6));
  const b = await hold(urlFor(7));

  const h1 = await health();
  assert.equal(h1.activeStreams, 2);

  const started = Date.now();
  const c = await fetch(urlFor(3)); // third token, full GET
  const waited = Date.now() - started;
  assert.equal(c.status, 503, `waited ${waited}ms`);
  assert.equal(c.headers.get("retry-after"), "2");
  assert.ok(waited >= 200, `refused too early: ${waited}ms`);

  const h = await health();
  assert.equal(h.activeStreams, 2);

  await done(a);
  await done(b);
  void c.body?.cancel();
});

test("range probes (<=4KiB) bypass admission while slots are full", async () => {
  const a = await hold(urlFor(6));
  const b = await hold(urlFor(7));
  const h = await health();
  assert.equal(h.activeStreams, 2, "precondition: two slots busy");

  const probe = await fetch(urlFor(3), { headers: { range: "bytes=0-99" } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get("content-length"), "100");

  const head = await fetch(urlFor(3), { method: "HEAD" });
  assert.equal(head.status, 200);

  await done(a);
  await done(b);
});

/* ----------------------- FR-19 v2.2 delta: direct Admissions unit checks */

test("Admissions unit: two grants per token coexist; 3rd evicts the oldest", async () => {
  const adm = new Admissions(4, 200);
  const g1 = await adm.acquire("tok", { probe: false });
  const g2 = await adm.acquire("tok", { probe: false });
  assert.equal(adm.activeCount, 2, "two synchronous grants on one token");

  const aborted = new Promise<void>((res) => g1.controller.signal.addEventListener("abort", () => res()));
  const g3 = await adm.acquire("tok", { probe: false }); // must NOT queue
  assert.equal(g3.probe, false);
  assert.ok(g1.controller.signal.aborted, "oldest grant of the token was aborted");
  await aborted;
  assert.equal(adm.activeCount, 2, "evicted + replacement");

  adm.release(g1); // evicted grants release as no-ops (already marked released)
  adm.release(g2);
  adm.release(g3);
  assert.equal(adm.activeCount, 0, "all grants released");
});

test("Admissions unit: extra tokens still queue up to waitMs then 503", async () => {
  const adm = new Admissions(2, 120);
  const a = await adm.acquire("a", { probe: false });
  const b = await adm.acquire("b", { probe: false });

  const started = Date.now();
  await assert.rejects(
    adm.acquire("c", { probe: false }),
    (e: unknown) => e instanceof AdmissionTimeoutError && e.retryAfterSeconds === 2,
    "timeout shape",
  );
  assert.ok(Date.now() - started >= 100, "queued for the wait window first");

  const probe = await adm.acquire("c", { probe: true }); // probes bypass
  assert.ok(probe.controller.signal.aborted === false);

  adm.release(a);
  adm.release(b);
  adm.release(probe);
  assert.equal(adm.activeCount, 0);
});
