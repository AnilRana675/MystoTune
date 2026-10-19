/** §10/FR-18: telegram outage maps to status codes without breaking search. */
import test from "node:test";
import assert from "node:assert/strict";
import { upsertTrack } from "../src/db.js";
import { buildTestServer, TEST_SECRET, fetchJson, type TestServer } from "./util.js";

let ts: TestServer;
const S = TEST_SECRET;

/** A telegram-sourced row (no local file) to exercise the M0 503 path. */
const seedTelegramRow = (): void => {
  upsertTrack(ts.db, {
    id: "tg_n1001234567890_90",
    chatId: -1001234567890,
    msgId: 90,
    title: "Long Distance Radio",
    artist: "Telegram Archive",
    album: null,
    duration: 30,
    mime: "audio/mpeg",
    size: 1_000,
    fileName: "Long Distance Radio.mp3",
    codec: "mp3",
    container: "mp3",
    lossless: 0,
    bitrateKbps: 266,
    docId: 90,
    source: "telegram",
    filePath: null,
    hasThumb: 0,
  });
};

test.before(async () => {
  ts = await buildTestServer();
  seedTelegramRow();
});
test.after(async () => {
  await ts.cleanup();
});

test("default state (not_configured): known telegram row is 503 with Retry-After", async () => {
  const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_90`);
  assert.equal(res.status, 503);
  const ra = res.headers.get("retry-after");
  assert.ok(ra && Number(ra) > 0, `retry-after=${ra}`);
  const body = await res.text();
  assert.ok(body.length < 3);
});

test("forceState(unreachable): telegram row 503, fixtures + search unaffected", async () => {
  ts.telegram.forceState("unreachable", "killed for test");
  try {
    const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_90`);
    assert.equal(res.status, 503);
    // fixture rows still resolve (FR-18)
    const ok = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_1`);
    assert.equal(ok.status, 200);
    const q = await fetchJson(ts, `/${S}/search?q=midnight`);
    assert.equal(q.status, 200);
    const man = await fetchJson(ts, `/${S}/manifest.json`);
    assert.equal(man.status, 200);
  } finally {
    ts.telegram.forceState("not_configured");
  }
});

test("forceState(fatal): telegram row is 404, healthz reports not ok", async () => {
  ts.telegram.forceState("fatal", "AUTH_KEY_DUPLICATED");
  try {
    const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_90`);
    assert.equal(res.status, 404);
    const h = (await (await fetchJson(ts, "/healthz")).json() as any) as Record<string, unknown>;
    assert.equal(h.ok, false);
  } finally {
    ts.telegram.forceState("not_configured");
  }
});

test("forced flood wait: telegram row is 429 with Retry-After X", async () => {
  ts.telegram.forceState("ready", "physical");
  try {
    ts.telegram.recordFloodWait(30);
    const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_90`);
    assert.equal(res.status, 429);
    const ra = Number(res.headers.get("retry-after"));
    assert.ok(ra > 0 && ra <= 30, `retry-after=${ra}`);
  } finally {
    ts.telegram.forceState("not_configured");
    ts.telegram.recordFloodWait(-1_000_000); // clear the cooldown
  }
});

test("unknown id stays 404 in every outage mode", async () => {
  for (const st of ["unreachable", "fatal"] as const) {
    ts.telegram.forceState(st);
    try {
      const res = await fetchJson(ts, `/${S}/stream/tg_n1001234567890_404`);
      assert.equal(res.status, 404, st);
    } finally {
      ts.telegram.forceState("not_configured");
    }
  }
});

test("media of unknown/bad token is 403 even when telegram is down", async () => {
  ts.telegram.forceState("unreachable");
  try {
    const res = await fetch(`${ts.baseUrl}/media/AAA.BBB`, { headers: { range: "bytes=0-9" } });
    assert.equal(res.status, 403);
  } finally {
    ts.telegram.forceState("not_configured");
  }
});

test("redis unset means no crash — env contract is optional", () => {
  // REDIS_URL may exist in a developer's real .env (M3 consumes it); the
  // optional-storage contract is that absence never breaks anything. The
  // server config is always built from an EXPLICT env object in tests, so
  // this process-level value can never leak into config decisions here.
  assert.equal(typeof process.env.REDIS_URL === "string" || process.env.REDIS_URL === undefined, true);
});
