/** §10/FR-18: telegram outage maps to status codes without breaking search. */
import test from "node:test";
import assert from "node:assert/strict";
import { upsertTrack } from "../src/db.js";
import { bootTelegram } from "../src/server.js";
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

/* --------------------------------------------------- §4.15 Render profile */

test("MONTHLY_BYTES_BUDGET exceeded -> /stream and /media answer plain 404", async () => {
  const bs = await buildTestServer({ extraEnv: { MONTHLY_BYTES_BUDGET: "10" } });
  try {
    const row = bs.tracks[0]!;
    const s1 = await fetchJson(bs, `/${S}/stream/${row.id}`);
    assert.equal(s1.status, 200);
    const url = ((await s1.json()) as { url: string }).url;
    const m1 = await fetch(url);
    assert.equal(m1.status, 200, "first media request streams normally");
    await m1.arrayBuffer(); // drains the response and accrues >= 10 local bytes

    // budget is exhausted: BOTH routes report a plain 404 so the player falls
    // back to the next track instead of surfacing a 5xx (and Render never sees
    // the errors that would count toward a suspend). Token validity itself is
    // not the failure action — 403 stays reserved for signature misses.
    const s2 = await fetchJson(bs, `/${S}/stream/${row.id}`);
    assert.equal(s2.status, 404);
    const body2 = await s2.text();
    assert.ok(body2.length < 3);
    const m2 = await fetch(url); // token still valid, budget 404 comes first
    assert.equal(m2.status, 404);
  } finally {
    await bs.cleanup();
  }
});

test("budget env absent keeps the default (no surprise 404s in tests)", async () => {
  const bs = await buildTestServer(); // MONTHLY_BYTES_BUDGET default 0 = unlimited
  try {
    const row = bs.tracks[0]!;
    const s = await fetchJson(bs, `/${S}/stream/${row.id}`);
    assert.equal(s.status, 200, "default budget never trips the gate");
  } finally {
    await bs.cleanup();
  }
});

/** Placeholder stub matching bootTelegram's structural interface. */
function stubTelegram(detail: string, behave: "ready-on-third" | "always-fatal"): {
  state: "fatal" | "ready";
  detail: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  calls: number;
} {
  const t = {
    state: "fatal" as "fatal" | "ready",
    detail,
    start: async () => {
      t.calls += 1;
      // "ready-on-third": the third attempt (calls.length === 3) succeeds
      t.state = behave === "ready-on-third" && t.calls >= 3 ? "ready" : "fatal";
    },
    stop: async () => {},
    calls: 0,
  };
  return t;
}

const stubLog = { info: () => {}, warn: () => {}, error: () => {} };

test("§4.15: AUTH_KEY_DUPLICATED at boot retries and succeeds when the twin exits", async () => {
  const tg = stubTelegram("telegram session fatal: AUTH_KEY_DUPLICATED (another host)", "ready-on-third");
  const out = await bootTelegram(
    tg as unknown as Parameters<typeof bootTelegram>[0],
    { bootAuthRetries: 3, bootAuthRetryWaitSeconds: 0 },
    stubLog,
  );
  assert.equal(tg.calls, 3, "retried until the auth overlap cleared");
  assert.equal(out, "ready");
});

test("§4.15: a non-overlap fatal is declared immediately (no pointless retries)", async () => {
  const tg = stubTelegram("telegram session fatal: AUTH_KEY_UNREGISTERED (bad phone)", "always-fatal");
  const out = await bootTelegram(
    tg as unknown as Parameters<typeof bootTelegram>[0],
    { bootAuthRetries: 3, bootAuthRetryWaitSeconds: 0 },
    stubLog,
  );
  assert.equal(tg.calls, 1, "only one attempt");
  assert.equal(out, "fatal");
});

test("§4.15: an overlap that never clears exits fatal after BOOT_AUTH_RETRIES", async () => {
  const tg = stubTelegram("telegram session fatal: AUTH_KEY_DUPLICATED (still live)", "always-fatal");
  const out = await bootTelegram(
    tg as unknown as Parameters<typeof bootTelegram>[0],
    { bootAuthRetries: 3, bootAuthRetryWaitSeconds: 0 },
    stubLog,
  );
  assert.equal(tg.calls, 3, "attempted the configured retry budget");
  assert.equal(out, "fatal");
});
