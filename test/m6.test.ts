/**
 * M6.0 acceptance tests (doc sections 7.3/7.4/11):
 * - key derivation (FR-29): deterministic, 32-char URL-safe addon secret,
 *   rotation changes every derived secret, APP_SEED-only boot resolves.
 * - legacy fallback: pre-APP_SEED .env boots derive the config key from the
 *   explicit legacy secrets (keeps every M0-M5 setup booting unchanged).
 * - config store (FR-28): AES-GCM roundtrip through Redis blob or durable
 *   file, tamper rejection, read-back verification blocking finish.
 * - config resolution (7.3): env > store > profile > built-ins.
 * Everything here is pure logic — no network, no server boot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeAppSeed,
  deriveConfigKeyFromLegacy,
  deriveSecrets,
  HKDF_SALT,
  isUrlSafeSecret,
  KeyDerivationError,
} from "../src/keys.js";
import { RELEASE_LUA, RENEW_LUA, deriveInstanceId, SessionLease } from "../src/lease.js";
import { openRedisStore, type RedisStore } from "../src/redis.js";
import { startFakeRedis } from "./fake-redis.js";
import { buildTestServer, TEST_SECRET } from "./util.js";
import { createMediaToken } from "../src/sign.js";
import {
  ConfigStore,
  ConfigStoreError,
  decryptConfig,
  encryptConfig,
  parseStoredConfig,
  type StoredConfigV1,
} from "../src/configStore.js";
import { applyStoredConfig, ConfigError, loadConfig } from "../src/config.js";

const SEED_A = Buffer.alloc(32, 0x11);
const SEED_B = Buffer.alloc(32, 0x22);
const STORE_KEY = Buffer.alloc(32, 7);

/** Test env: APP_SEED-driven boot with an insecure local base URL. */
function seedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_SEED: SEED_A.toString("base64"),
    PUBLIC_BASE_URL: "http://127.0.0.1:8080",
    ALLOW_INSECURE_BASE_URL: "1",
    REDIS_URL: "redis://127.0.0.1:6379", // never dialed by these tests
    ...overrides,
  };
}

function mkStored(over: Partial<StoredConfigV1> = {}): StoredConfigV1 {
  return {
    v: 1,
    apiId: 777,
    apiHash: "store-hash",
    sessions: ["stored-session-old", "stored-session-new"],
    channels: [-2002],
    options: { allowDownloads: false, monthlyBytesBudget: 1000 },
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/* --------------------------------------------------------------- FR-29 keys */

test("keys: derivation is deterministic and yields URL-safe 32-byte secrets", () => {
  const a1 = deriveSecrets(SEED_A);
  const a2 = deriveSecrets(Buffer.from(SEED_A));
  assert.equal(a1.addonSecret, a2.addonSecret);
  assert.ok(a1.mediaSigningKey.equals(a2.mediaSigningKey));
  assert.ok(a1.configKey.equals(a2.configKey));
  assert.ok(isUrlSafeSecret(a1.addonSecret)); // exactly 32 path-safe chars
  assert.equal(a1.mediaSigningKey.length, 32);
  assert.equal(a1.configKey.length, 32);
  assert.equal(HKDF_SALT, "mystotune/v1");
});

test("keys: rotating APP_SEED invalidates all three derived secrets", () => {
  const a = deriveSecrets(SEED_A);
  const b = deriveSecrets(SEED_B);
  assert.notEqual(a.addonSecret, b.addonSecret);
  assert.ok(!a.mediaSigningKey.equals(b.mediaSigningKey));
  assert.ok(!a.configKey.equals(b.configKey));
});

test("keys: decodeAppSeed rejects empty and wrong-size seeds", () => {
  assert.throws(() => decodeAppSeed("   "), KeyDerivationError);
  assert.throws(() => decodeAppSeed(Buffer.alloc(16, 3).toString("base64")), KeyDerivationError);
  assert.throws(() => decodeAppSeed(Buffer.alloc(31, 3).toString("base64")), KeyDerivationError);
  assert.ok(decodeAppSeed(SEED_A.toString("base64")).equals(SEED_A));
});

test("keys: legacy fallback config key is deterministic from the explicit secrets", () => {
  const k = deriveConfigKeyFromLegacy("dev.mystotune.telegram-addon", Buffer.alloc(32, 5));
  assert.equal(k.length, 32);
  assert.ok(k.equals(deriveConfigKeyFromLegacy("dev.mystotune.telegram-addon", Buffer.alloc(32, 5))));
  assert.ok(!k.equals(deriveConfigKeyFromLegacy("other-secret", Buffer.alloc(32, 5))));
  assert.ok(!k.equals(deriveConfigKeyFromLegacy("dev.mystotune.telegram-addon", Buffer.alloc(32, 6))));
});

/* -------------------------------------------------------------- FR-28 store */

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "bitchord-m6-"));
}

test("store: AES-GCM save/load roundtrip through the durable file (0600)", async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, "config.enc");
    const store = new ConfigStore({ key: STORE_KEY, redis: null, filePath });
    const saved = await store.save({
      apiId: 123456,
      apiHash: "hash",
      sessions: ["1AAAA-session"],
      channels: [-1001],
      options: { allowDownloads: false, monthlyBytesBudget: 4_500_000_000 },
    });
    assert.ok(saved.updatedAt.length > 0);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.deepEqual(loaded, saved);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: helper layer — encrypt/decrypt roundtrip, tamper ⇒ null, parse rejects", () => {
  const record = mkStored(); // once: save() stamps updatedAt at call time
  const plain = JSON.stringify(record);
  const artifact = encryptConfig(plain, STORE_KEY);
  assert.equal(decryptConfig(artifact, STORE_KEY), plain);
  assert.equal(decryptConfig(artifact, Buffer.alloc(32, 8)), null); // wrong key
  // Flip one ciphertext byte: decrypt must yield null (GCM tag catches it).
  const raw = Buffer.from(artifact, "base64url");
  const last = raw.length - 1;
  raw[last] = (raw[last] ?? 0) ^ 0xff;
  assert.equal(decryptConfig(Buffer.from(raw).toString("base64url"), STORE_KEY), null);
  assert.equal(decryptConfig("garbage", STORE_KEY), null);
  assert.equal(parseStoredConfig("not json"), null);
  assert.equal(parseStoredConfig(JSON.stringify({ v: 2 })), null);
  assert.equal(parseStoredConfig(JSON.stringify({ v: 1, apiId: "nope" })), null);
  const parsed = parseStoredConfig(plain);
  assert.ok(parsed);
  assert.deepEqual(parsed, record);
});

test("store: read-back verification failure blocks finish (FR-27/28)", async () => {
  const dir = tmpDir();
  try {
    const filePath = path.join(dir, "config.enc");
    // Redis stub that swallows writes: read-back sees nothing ⇒ mismatch.
    const opaque = {
      status: () => "ready",
      stats: () => ({ hits: 0, misses: 0, errors: 0, timeouts: 0 }),
      writeConfigBlob: () => undefined,
      readConfigBlob: async () => null,
    } as unknown as RedisStore;
    const store = new ConfigStore({ key: STORE_KEY, redis: opaque, filePath });
    await assert.rejects(
      () =>
        store.save({
          apiId: 1,
          apiHash: "h",
          sessions: ["s"],
          channels: [],
          options: { allowDownloads: true, monthlyBytesBudget: 0 },
        }),
      ConfigStoreError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ----------------------------------------------- 7.3 resolution env > store */

test("config: APP_SEED-only boot resolves every secret", () => {
  const cfg = loadConfig(seedEnv());
  assert.ok(isUrlSafeSecret(cfg.addonSecret));
  assert.equal(cfg.mediaSigningKey.length, 32);
  assert.equal(cfg.configKey.length, 32);
  assert.equal(cfg.publicBaseUrl, "http://127.0.0.1:8080");
  assert.equal(cfg.profile, "vps"); // RENDER unset ⇒ vps
});

test("config: legacy explicit-secret boot keeps working without APP_SEED", () => {
  const env = {
    ADDON_SECRET: "A".repeat(32),
    MEDIA_SIGNING_KEY: Buffer.alloc(32, 9).toString("base64"),
    PUBLIC_BASE_URL: "http://127.0.0.1:8080",
    ALLOW_INSECURE_BASE_URL: "1",
  };
  const cfg = loadConfig(env);
  assert.equal(cfg.addonSecret, "A".repeat(32));
  assert.equal(cfg.configKey.length, 32);
  // The legacy derivation is a pure function of the two explicit secrets,
  // so two boots with the same .env produce the same store key.
  const again = loadConfig(env);
  assert.ok(cfg.configKey.equals(again.configKey));
});

test("config: store fills what env left silent; env wins where it speaks", () => {
  const cfg = loadConfig(seedEnv()); // no telegram envs at all
  const stored = mkStored();

  // Store layer fills the silent fields.
  const merged = applyStoredConfig(cfg, stored, seedEnv());
  assert.equal(merged.telegram.apiId, 777);
  assert.equal(merged.telegram.apiHash, "store-hash");
  assert.equal(merged.telegram.session, "stored-session-new"); // latest session wins
  assert.deepEqual(merged.telegram.channels, [-2002]);
  assert.equal(merged.telegram.configured, true);
  assert.equal(merged.allowDownloads, false);
  assert.equal(merged.monthlyBytesBudget, 1000);

  // Env overrides beat the store: the winning env is parsed into the base
  // config, and applyStoredConfig keeps env-provided values over stored ones.
  const envWin = seedEnv({
    TARGET_CHANNEL_IDS: "-3003",
    ALLOW_DOWNLOADS: "1",
    MONTHLY_BYTES_BUDGET: "999",
    TELEGRAM_API_ID: "42",
    TELEGRAM_API_HASH: "env-hash",
    TELEGRAM_SESSION_STRING: "env-session",
  });
  const mergedEnv = applyStoredConfig(loadConfig(envWin), stored, envWin);
  assert.deepEqual(mergedEnv.telegram.channels, [-3003]);
  assert.equal(mergedEnv.allowDownloads, true);
  assert.equal(mergedEnv.monthlyBytesBudget, 999);
  assert.equal(mergedEnv.telegram.apiId, 42);
  assert.equal(mergedEnv.telegram.apiHash, "env-hash");
  assert.equal(mergedEnv.telegram.session, "env-session");

  // A stored session without any creds is rejected after the merge.
  assert.throws(
    () => applyStoredConfig(cfg, mkStored({ apiId: null, apiHash: null }), seedEnv()),
    ConfigError,
  );
});

test("config: profile / setup / lease parsing", () => {
  assert.equal(loadConfig(seedEnv({ PROFILE: "render" })).profile, "render");
  assert.equal(loadConfig(seedEnv({ RENDER: "1" })).profile, "render");
  assert.equal(loadConfig(seedEnv()).profile, "vps");
  assert.throws(() => loadConfig(seedEnv({ PROFILE: "banana" })), ConfigError);

  assert.equal(loadConfig(seedEnv()).setupEnabled, "auto");
  assert.equal(loadConfig(seedEnv({ SETUP_ENABLED: "1" })).setupEnabled, "on");
  assert.equal(loadConfig(seedEnv({ SETUP_ENABLED: "0" })).setupEnabled, "off");
  assert.throws(() => loadConfig(seedEnv({ SETUP_ENABLED: "maybe" })), ConfigError);

  const lease = loadConfig(seedEnv()).lease;
  assert.equal(lease.ttlMs, 45_000);
  assert.equal(lease.renewMs, 15_000);
  assert.equal(lease.pollMs, 5_000);
  assert.equal(lease.drainMs, 10_000);
  assert.equal(lease.sessionSlots, 1);
});

test("config: RENDER_EXTERNAL_URL fills the public base URL", () => {
  const cfg = loadConfig({
    APP_SEED: SEED_A.toString("base64"),
    RENDER_EXTERNAL_URL: "https://mystotune.onrender.com",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.publicBaseUrl, "https://mystotune.onrender.com");
  // An explicit PUBLIC_BASE_URL always wins over the Render-provided URL.
  const explicit = loadConfig({
    APP_SEED: SEED_A.toString("base64"),
    RENDER_EXTERNAL_URL: "https://mystotune.onrender.com",
    PUBLIC_BASE_URL: "https://custom.example.com",
  } as NodeJS.ProcessEnv);
  assert.equal(explicit.publicBaseUrl, "https://custom.example.com");
});

/* ===================== M6.1 session lease (doc 7.11/Appendix A) ===================== */

const LEASE_INTERVALS = { ttlMs: 60_000, renewMs: 15_000, pollMs: 5_000 } as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUp(store: RedisStore, deadlineMs = 2500): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (store.status() === "up") return;
    await sleep(25);
  }
  throw new Error("fake redis never became ready");
}

test("lease: acquire is exclusive (SET NX PX); owner release frees the slot", async () => {
  const fake = await startFakeRedis();
  const redis = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
  await waitUp(redis);
  await waitUp(redis);
  try {
    const a = new SessionLease({ redis, lease: LEASE_INTERVALS, instanceId: "inst-a", slot: 0 });
    const b = new SessionLease({ redis, lease: LEASE_INTERVALS, instanceId: "inst-b", slot: 0 });
    assert.equal(await a.tryAcquire(), true);
    assert.equal(await b.tryAcquire(), false, "second instance must lose the race");
    assert.equal(await a.release(), true, "owner release is compare-and-delete");
    assert.equal(await a.release(), false, "already released — nothing to delete");
    assert.equal(await b.tryAcquire(), true, "freed slot acquirable");
    assert.equal(await b.release(), true);
  } finally {
    redis.close();
    await fake.stop();
  }
});

test("lease: Appendix A renew/release Lua compare the holder exactly", async () => {
  const fake = await startFakeRedis();
  const redis = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
  await waitUp(redis);
  try {
    const lease = new SessionLease({ redis, lease: LEASE_INTERVALS, instanceId: "inst-a", slot: 0 });
    assert.equal(await lease.tryAcquire(), true);
    // foreign renew must not extend the lease (still counts as a miss inside the class)
    assert.equal(await redis.evalLua(RENEW_LUA, [lease.key], ["inst-b", "123456"]), 0);
    assert.equal(await redis.evalLua(RENEW_LUA, [lease.key], ["inst-a", "123456"]), 1);
    // foreign release must be a no-op
    assert.equal(await redis.evalLua(RELEASE_LUA, [lease.key], ["inst-b"]), 0);
    assert.equal(await redis.evalLua(RELEASE_LUA, [lease.key], ["inst-a"]), 1);
  } finally {
    redis.close();
    await fake.stop();
  }
});

test("lease: self-fences after sustained renewal misses and fires onFenced", async () => {
  const fake = await startFakeRedis();
  const redis = openRedisStore({ url: fake.url, timeoutMs: 500, snapshot: false })!;
  await waitUp(redis);
  try {
    let fencedCalls = 0;
    const lease = new SessionLease({
      redis,
      lease: LEASE_INTERVALS,
      instanceId: "inst-a",
      slot: 0,
      // allowed misses = ceil(30_000 / 15_000) = 2
      onFenced: () => {
        fencedCalls += 1;
      },
    });
    assert.equal(await lease.tryAcquire(), true);
    // the twin force-deletes our lease (simulating loss without our release)
    assert.equal(await redis.evalLua(RELEASE_LUA, [lease.key], ["inst-a"]), 1);
    await lease.renewBeat(); // miss 1/2 — still held
    assert.equal(lease.isFenced, false);
    await lease.renewBeat(); // miss 2/2 — self-fence fires
    assert.equal(lease.isFenced, true);
    assert.equal(lease.isHeld, false);
    assert.equal(fencedCalls, 1);
    assert.equal(await lease.tryAcquire(), false, "fenced lease never re-acquires");
  } finally {
    redis.close();
    await fake.stop();
  }
});

test("lease: instance id is RENDER_INSTANCE_ID or a unique host fallback", () => {
  assert.equal(deriveInstanceId({ RENDER_INSTANCE_ID: "rend-xyz" }), "rend-xyz");
  assert.equal(deriveInstanceId({ RENDER_INSTANCE_ID: "  rend-xyz  " }), "rend-xyz");
  const a = deriveInstanceId({});
  const b = deriveInstanceId({});
  assert.ok(/^[a-z0-9-]+-[0-9a-f]{4}$/.test(a), `host fallback shaped: ${a}`);
  assert.notEqual(a, b, "fallback ids must not collide across boots");
});

/* ===================== M6.1 mode gates (doc 7.2) ===================== */

test("standby: /stream + /media 503 retry-after 5; /search still serves the index", async () => {
  const ts = await buildTestServer({ modeBox: { mode: "standby" } });
  try {
    const stream = await fetch(`${ts.baseUrl}/${TEST_SECRET}/stream/1`);
    assert.equal(stream.status, 503);
    assert.equal(stream.headers.get("retry-after"), "5");
    const mediaToken = createMediaToken(String(ts.tracks[0]!.id), ts.cfg.mediaSigningKey, 600);
    const media = await fetch(`${ts.baseUrl}/media/${mediaToken}`);
    assert.equal(media.status, 503);
    assert.equal(media.headers.get("retry-after"), "5");
    const search = await fetch(`${ts.baseUrl}/${TEST_SECRET}/search?q=midnight`);
    assert.equal(search.status, 200);
    const body = (await search.json()) as { tracks: unknown[] };
    assert.ok(body.tracks.length > 0, "standby serves the snapshot index");
    const healthz = (await (await fetch(`${ts.baseUrl}/healthz`)).json()) as { mode: string; ok: boolean };
    assert.equal(healthz.mode, "standby");
    assert.equal(healthz.ok, true, "STANDBY /healthz MUST stay 200-ok (Render gate)");
  } finally {
    await ts.cleanup();
  }
});

test("setup: /search is valid but empty; healthz reports mode setup", async () => {
  const ts = await buildTestServer({ modeBox: { mode: "setup" } });
  try {
    const search = await fetch(`${ts.baseUrl}/${TEST_SECRET}/search?q=midnight`);
    assert.equal(search.status, 200);
    const body = (await search.json()) as { tracks: unknown[] };
    assert.deepEqual(body.tracks, []);
    const manifest = await fetch(`${ts.baseUrl}/${TEST_SECRET}/manifest.json`);
    assert.equal(manifest.status, 200, "SETUP manifest stays valid for discovery");
    const healthz = (await (await fetch(`${ts.baseUrl}/healthz`)).json()) as { mode: string; indexing: boolean };
    assert.equal(healthz.mode, "setup");
  } finally {
    await ts.cleanup();
  }
});

test("draining: /stream 503 retry-after 5 (SIGTERM window)", async () => {
  const ts = await buildTestServer({ modeBox: { mode: "draining" } });
  try {
    const res = await fetch(`${ts.baseUrl}/${TEST_SECRET}/stream/1`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    const healthz = (await (await fetch(`${ts.baseUrl}/healthz`)).json()) as { mode: string };
    assert.equal(healthz.mode, "draining");
  } finally {
    await ts.cleanup();
  }
});
