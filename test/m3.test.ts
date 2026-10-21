/**
 * M3 hardening tests (§4.11 optional Redis layer + §4.8/rate-limit surface):
 * rate-limit counters via RESP, q:{hash} search cache with the 500-entry cap,
 * msg:{id} doc metadata (never the file reference), the shared flood:until
 * cooldown, the index:snapshot export/restore round trip, and the Redis-down
 * fallback contract ("search and playback keep working", §7 checklist).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { startFakeRedis, type FakeRedisServer } from "./fake-redis.js";
import { openRedisStore, type RedisStore } from "../src/redis.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  openDb,
  createSchema,
  countTracks,
  setCursor,
  getCursor,
  exportTrackSnapshot,
  type TrackRow,
} from "../src/db.js";
import { TelegramManager } from "../src/telegram.js";
import { restoreSnapshotIfEmpty } from "../src/index-loop.js";
import { seedFixtureDb, CHAT_ID } from "../scripts/seed-fixture.js";
import { buildTestServer, TEST_SECRET, fetchJson, type TestServer } from "./util.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUp(store: RedisStore, deadlineMs = 2500): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (store.status() === "up") return;
    await sleep(25);
  }
  throw new Error("fake redis never became ready");
}

function testCfg(dbPath: string): AppConfig {
  return loadConfig({
    PORT: "1",
    PUBLIC_BASE_URL: "http://127.0.0.1:0",
    ALLOW_INSECURE_BASE_URL: "1",
    ADDON_SECRET: TEST_SECRET,
    MEDIA_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
    DB_PATH: dbPath,
    REDIS_SNAPSHOT: "1",
    TARGET_CHANNEL_IDS: String(CHAT_ID),
  });
}

/* -------------------------------------------------------------- rate limits */

test("redis rate limiter counts per ip+op in rl:{op}:{ip}:{minute} buckets", async () => {
  const fake = await startFakeRedis();
  try {
    const store = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
    await waitUp(store);
    const tc = { limit: 3, now: Date.now() };
    for (let i = 0; i < tc.limit; i++) {
      const out = await store.take(`search:9.9.9.9`, tc.limit, Date.now());
      assert.deepEqual(out, { ok: true, retryAfterSec: 0 });
    }
    const blocked = await store.take(`search:9.9.9.9`, tc.limit, Date.now());
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);

    // §4.11 key naming: rl:{op}:{ip}:{minute}, TTL 60 s
    const minute = Math.floor(Date.now() / 60_000);
    const key = `rl:search:9.9.9.9:${minute}`;
    const entry = fake.data.get(key);
    assert.ok(entry, "redis bucket key missing");
    assert.equal(entry!.value.toString(), String(tc.limit + 1));

    // separate operation => separate bucket (search vs stream limits)
    const stream = await store.take(`stream:9.9.9.9`, 3, Date.now());
    assert.deepEqual(stream, { ok: true, retryAfterSec: 0 });
    store.close();
  } finally {
    await fake.stop();
  }
});

/* ---------------------------------------------- search cache (q:{hash}) */

test("q:{hash} cache: set, hydrated e2e hit, 500-entry FIFO cap", async () => {
  const fake = await startFakeRedis();
  try {
    const store = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
    await waitUp(store);

    assert.deepEqual(await store.getQueryIds(store.queryHash("first")), null);
    store.putQueryIds(store.queryHash("first"), ["tg_1_1", "tg_1_2"]);
    await sleep(80);
    assert.deepEqual(await store.getQueryIds(store.queryHash("first")), ["tg_1_1", "tg_1_2"]);

    // §4.11 rule 2: cap 500 entries — the oldest is DELed
    for (let i = 0; i < 501; i++) store.putQueryIds(`h${String(i).padStart(3, "0")}`, ["x"]);
    await sleep(250);
    assert.equal(store.queryEntryCount(), 500);
    fake.data.delete(store.queryHash("first")); // that key had TTL, drop manually
    const minuteKeys = [...fake.data.keys()].filter((k) => k.startsWith("q:"));
    assert.equal(minuteKeys.includes("q:h000"), false, "oldest q: entry must be evicted");
    assert.equal(minuteKeys.includes("q:h500"), true, "newest q: entry must remain");
    store.close();
  } finally {
    await fake.stop();
  }
});

test("e2e: a repeated search is served with identical rows via the cache", async () => {
  const fake = await startFakeRedis();
  let ts: TestServer | null = null;
  try {
    ts = await buildTestServer({ redisUrl: fake.url });
    if (ts.redis) await waitUp(ts.redis!); // the store must be live before writes
    const url = `${ts.baseUrl}/${TEST_SECRET}/search?q=midnight`;
    const first = await (await fetch(url)).json();
    const second = await (await fetch(url)).json();
    assert.deepEqual(second, first);
    assert.ok(Array.isArray((first as { tracks?: unknown[] }).tracks) && (first as { tracks: unknown[] }).tracks.length >= 1);
    // the cache key exists in the fake redis
    await sleep(120); // fire-and-forget SET finishes (§4.11 putQueryIds)
    assert.ok([...fake.data.keys()].some((k) => k.startsWith("q:")));
  } finally {
    await ts?.cleanup();
    await fake.stop();
  }
});

/* ------------------------------------------ resolved-doc metadata msg:{id} */

test("msg:{id} metadata: round trip, 30 min TTL, file reference never stored", async () => {
  const fake = await startFakeRedis();
  try {
    const store = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
    await waitUp(store);
    const id = "tg_n1001_7";
    store.putDocMeta(id, {
      docId: 424242,
      size: 44_402_097,
      mime: "audio/flac",
      fileName: "song.flac",
      docLongId: "9223372036854775807",
      accessHash: "0xABCDEF",
      dcId: 4,
    });
    await sleep(80);
    const meta = await store.getDocMeta(id);
    assert.ok(meta);
    assert.equal(meta!.size, 44_402_097);
    assert.equal(meta!.docLongId, "9223372036854775807");
    assert.equal(meta!.dcId, 4);
    // raw payload excludes the file reference (§4.14)
    const raw = fake.data.get(`msg:${id}`)!.value.toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.ok(!("fileReference" in parsed));
    // TTL ~1800s (30 min)
    const ttlSec = Math.round((fake.data.get(`msg:${id}`)!.expAt! - Date.now()) / 1000);
    assert.ok(ttlSec > 1500 && ttlSec <= 1800);
    store.close();
  } finally {
    await fake.stop();
  }
});

/* ------------------------------------------------ shared flood cooldown */

test("flood:until is shared across instances and adopted by the manager", async () => {
  const fake = await startFakeRedis();
  try {
    const store = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
    await waitUp(store);
    const nowSec = Math.floor(Date.now() / 1000);
    store.writeFloodUntil(nowSec + 37, 37);
    await sleep(80);
    const read = await store.readFloodUntil();
    assert.ok(Math.abs(read - (nowSec + 37)) <= 3);

    // "another instance" adopts the shared cooldown via refresh
    const cfg = testCfg(mkdtempSync(path.join(os.tmpdir(), "bitchord-m3-")));
    const tm = new TelegramManager(cfg, store);
    tm.state = "ready";
    await tm.refreshRemoteFlood();
    const remaining = tm.floodCooldownRemaining();
    assert.ok(remaining >= 34 && remaining <= 37, `adopted remaining=${remaining}`);
    // and writes its own local floods to the shared key (write-through)
    tm.recordFloodWait(50);
    await sleep(80);
    const stored = Number(fake.data.get("flood:until")!.value.toString());
    assert.ok(stored >= nowSec + 50);
    store.close();
  } finally {
    await fake.stop();
  }
});

/* ------------------------------------------------- index:snapshot (§4.11) */

test("index:snapshot exports gzipped rows+cursors and restores into an empty db", async () => {
  const fake = await startFakeRedis();
  let store: RedisStore | null = null;
  const dirA = mkdtempSync(path.join(os.tmpdir(), "bitchord-snapA-"));
  const dirB = mkdtempSync(path.join(os.tmpdir(), "bitchord-snapB-"));
  try {
    const cfgA = testCfg(path.join(dirA, "a.sqlite"));
    const dbA = openDb(cfgA.dbPath);
    createSchema(dbA);
    seedFixtureDb(dbA, path.join(dirA, "fx"), { quiet: true, includePrngOnly: false });
    setCursor(dbA, CHAT_ID, 1894);
    const expectedIds = new Set(
      (dbA.prepare("SELECT id FROM tracks").all() as Array<{ id: string }>).map((r) => r.id),
    );
    // §4.11 flow: real export → gzip → index:snapshot
    const snap = exportTrackSnapshot(dbA);
    dbA.close();

    store = openRedisStore({ url: fake.url, timeoutMs: 800, snapshot: true })!;
    await waitUp(store);
    const gz = gzipSync(Buffer.from(JSON.stringify(snap), "utf8"), { level: 6 });
    store.writeSnapshot(gz);
    await sleep(150);

    const cfgB = testCfg(path.join(dirB, "b.sqlite"));
    const dbB = openDb(cfgB.dbPath);
    createSchema(dbB);
    try {
      const restored = await restoreSnapshotIfEmpty(dbB, cfgB, store);
      assert.equal(restored, expectedIds.size);
      assert.equal(countTracks(dbB), expectedIds.size);
      assert.equal(getCursor(dbB, CHAT_ID), 1894);
      const got = dbB.prepare("SELECT id FROM tracks").all() as Array<{ id: string }>;
      assert.deepEqual(
        new Set(got.map((r) => r.id)),
        expectedIds,
      );
    } finally {
      dbB.close();
    }
  } finally {
    store?.close();
    await fake.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("snapshot is skipped when the disk already has rows", async () => {
  const fake = await startFakeRedis();
  const dirA = mkdtempSync(path.join(os.tmpdir(), "bitchord-snapC-"));
  try {
    const cfg = testCfg(path.join(dirA, "c.sqlite"));
    const db = openDb(cfg.dbPath);
    createSchema(db);
    seedFixtureDb(db, path.join(dirA, "fx"), { quiet: true, includePrngOnly: false });
    const store = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: true })!;
    await waitUp(store);
    const restored = await restoreSnapshotIfEmpty(db, cfg, store);
    assert.equal(restored, 0); // disk had rows — no restore replay
    store.close();
    db.close();
  } finally {
    await fake.stop();
    rmSync(dirA, { recursive: true, force: true });
  }
});

/* ---------------------------------------- redis-down fallback (§7 checklist) */

test("with Redis stopped, search and playback keep working", async () => {
  // port 1 on loopback is (almost always) closed: instant refusals
  const ts = await buildTestServer({ redisUrl: "redis://127.0.0.1:1" });
  try {
    const t0 = Date.now();
    const search = await fetchJson(ts, `/${TEST_SECRET}/search?q=sunrise`);
    const searchMs = Date.now() - t0;
    assert.equal(search.status, 200);
    assert.ok(searchMs < 1500, `search took ${searchMs}ms with dead redis`);
    const body = (await search.json()) as { tracks: unknown[] };
    assert.deepEqual(body.tracks, []);

    // fixture playback + HEAD both proceed while redis is dead
    const flac = ts.tracks[0]!;
    const stream = await fetchJson(ts, `/${TEST_SECRET}/stream/${flac.id}`);
    assert.equal(stream.status, 200);
    const streamUrl = ((await stream.json()) as { url: string }).url;
    const head = await fetch(streamUrl, { method: "HEAD" });
    assert.equal(head.status, 200);

    // status reports the down store (§4.12 cache visibility; M7.5 secret-gated)
    const health = (await (await fetchJson(ts, `/${TEST_SECRET}/status`)).json()) as {
      cache: { redis: string };
    };
    assert.equal(health.cache.redis, "down");

    const stats = ts.redis?.stats();
    assert.ok(stats && (stats.errors + stats.timeouts) > 0, "dead-redis failures are counted");
  } finally {
    await ts.cleanup();
  }
});

/* -------------------------------------------- rate limiter wiring (§4.8) */

test("the limiter is consulted with {op}:{ip} keys on search and stream", async () => {
  const keys: string[] = [];
  let blocked = false;
  let ts: TestServer | null = null;
  try {
    ts = await buildTestServer({
      rateLimiter: {
        take(key) {
          keys.push(key);
          return blocked ? { ok: false, retryAfterSec: 7 } : { ok: true, retryAfterSec: 0 };
        },
      },
    });
    let res = await fetchJson(ts, `/${TEST_SECRET}/search?q=midnight`);
    assert.equal(res.status, 200);
    blocked = true;
    res = await fetchJson(ts, `/${TEST_SECRET}/search?q=midnight`);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
    const errBody = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(errBody, {});
    blocked = false;
    const flac = ts.tracks[0]!;
    res = await fetchJson(ts, `/${TEST_SECRET}/stream/${flac.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(keys, [`search:${"127.0.0.1"}`, `search:${"127.0.0.1"}`, `stream:${"127.0.0.1"}`]);
  } finally {
    await ts?.cleanup();
  }
});
