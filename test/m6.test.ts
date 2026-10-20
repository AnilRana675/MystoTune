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
import {
  ConfigStore,
  ConfigStoreError,
  decryptConfig,
  encryptConfig,
  parseStoredConfig,
  type StoredConfigV1,
} from "../src/configStore.js";
import { applyStoredConfig, ConfigError, loadConfig } from "../src/config.js";
import type { RedisStore } from "../src/redis.js";

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
