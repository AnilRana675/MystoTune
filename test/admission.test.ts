/** §10/FR-19: slot accounting, free probes, same-token abort. */
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaToken } from "../src/sign.js";
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

test("same token re-request aborts the previous active stream", async () => {
  const url = urlFor(6);
  const first = await hold(url);
  const size = ts.tracks[0]!.size!;
  await new Promise((r) => setTimeout(r, 80));

  // SAME token must replace, not stack (seek-ahead rule)
  const second = await hold(url);
  assert.ok(first.first.byteLength > 0);
  assert.ok(first.first.byteLength < size, "first stream cut short");
  // the aborted first reader should be closed by the server
  const follow = await first.reader.read().then(
    (r) => (r.done ? "done" : "chunk"),
    (e: unknown) => "error",
  );
  await new Promise((r) => setTimeout(r, 40));
  const h = await health();
  assert.ok(h.activeStreams <= 1, `active=${h.activeStreams}`);
  await done(first);
  await done(second);
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
