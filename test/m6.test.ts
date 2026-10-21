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
import { buildTestServer, TEST_SECRET, type TestServer } from "./util.js";
import {
  createSchema,
  exportTrackSnapshot,
  listCursors,
  openDb,
  restoreTrackSnapshot,
  setCursor,
  upsertTrack,
} from "../src/db.js";
import { restoreSnapshotIfEmpty } from "../src/index-loop.js";
import { createMediaToken } from "../src/sign.js";
import { SetupAccess, type LoginCallbacks, type LoginFactory, type SetupChannel, type SetupLogin } from "../src/setup.js";
import {
  ConfigStore,
  ConfigStoreError,
  decryptConfig,
  encryptConfig,
  parseStoredConfig,
  type StoredConfigV1,
} from "../src/configStore.js";
import { applyStoredConfig, ConfigError, loadConfig, packageVersion } from "../src/config.js";

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

test("config: packageVersion walks to the real manifest (dist boots, no 0.0.0)", () => {
  const v = packageVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
  assert.notEqual(v, "0.0.0", "version capture must not fall back under either layout");
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

/* ===================== M6.2 guided setup (doc 7.5-7.9, §8) ===================== */

const CRED_API_HASH = "a".repeat(32);

type StatusPayload = {
  closed: boolean;
  creds: boolean;
  loginPhase: string | null;
  sentCodeTo: string | null;
  loginError: { code: string; message: string; next: string } | null;
  user: { id: number; name: string } | null;
  channels: number[];
  options: { allowDownloads: boolean; monthlyBytesBudget: number };
  verify: { rows: Array<{ id: string; ok: boolean; severity: string; detail: string }>; finishAllowed: boolean } | null;
  publicUrl: string | null;
  backupReady: boolean;
};

async function statusOf(ts: TestServer): Promise<StatusPayload> {
  const res = await fetch(`${ts.baseUrl}/${TEST_SECRET}/status`);
  assert.equal(res.status, 200);
  return (await res.json()) as StatusPayload;
}

/** Poll /status until `check` holds (2 s cap) — the login advances async. */
async function untilStatus(ts: TestServer, check: (s: StatusPayload) => boolean): Promise<StatusPayload> {
  const end = Date.now() + 2000;
  for (;;) {
    const s = await statusOf(ts);
    if (check(s)) return s;
    if (Date.now() > end) throw new Error("status precondition never reached");
    await sleep(5);
  }
}

/** Exchange the deploy-log token for the wizard session (doc 7.5). */
async function unlockWizard(ts: TestServer): Promise<{ auth: { cookie: string; "x-setup-csrf": string }; csrf: string }> {
  const res = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ts.setupAccess!.token }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; csrf: string };
  assert.equal(body.ok, true);
  assert.ok(body.csrf.length > 0, "csrf token minted");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { auth: { cookie, "x-setup-csrf": body.csrf }, csrf: body.csrf };
}

async function setupPost(ts: TestServer, auth: Record<string, string>, subpath: string, body: unknown): Promise<Response> {
  return fetch(`${ts.baseUrl}/${TEST_SECRET}/setup${subpath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
}

/**
 * Telegram seam mock (doc 7.6/§10): every client.start() attempt behaves like
 * a 2FA account with the doc's GramJS error names surfacing through wrong
 * code/password submissions.
 */
class ScriptedLogin implements SetupLogin {
  loginAttempts = 0;
  /** tests flip this before verify() to make the channels check fail */
  readable = true;
  closeCount = 0;

  start(cb: LoginCallbacks): Promise<{ id: number; name: string }> {
    this.loginAttempts += 1;
    return cb.phone().then(() =>
      cb.code().then((code) => {
        if (code === "0000") {
          throw new Error("RPCError PHONE_CODE_INVALID: the code is invalid");
        }
        return cb.password().then((pw) => {
          if (pw === "nope") {
            throw new Error("RPCError PASSWORD_HASH_INVALID: the password is invalid");
          }
          return { id: 7, name: "Test User" };
        });
      }),
    );
  }

  whoAmI(): Promise<{ id: number; name: string }> {
    return Promise.resolve({ id: 7, name: "Test User" });
  }

  dialogs(): Promise<SetupChannel[]> {
    return Promise.resolve([{ id: -100123, title: "Music" }]);
  }

  audioCount(): Promise<{ count: number; total: number }> {
    return Promise.resolve({ count: 12, total: 99 });
  }

  channelReadable(): Promise<boolean> {
    return Promise.resolve(this.readable);
  }

  exportSession(): string {
    return "SESSION_STRING_TEST";
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

function scriptedFactory(): { logins: ScriptedLogin[]; factory: LoginFactory } {
  const logins: ScriptedLogin[] = [];
  const factory: LoginFactory = () => {
    const login = new ScriptedLogin();
    logins.push(login);
    return login;
  };
  return { logins, factory };
}

test("setup access: five wrong tokens lock the ip; the global cap is hourly", () => {
  const access = new SetupAccess(30 * 60_000, false);
  // 4 wrong → invalid with a shrinking remaining counter
  for (const remaining of [4, 3, 2, 1]) {
    const r = access.attemptUnlock("10.0.0.1", "wrong-token");
    assert.deepEqual(r, { ok: false, code: "invalid", retryAfterSec: 0, remaining });
  }
  // the 5th wrong token locks the ip for ~15 min
  const lock = access.attemptUnlock("10.0.0.1", "wrong-token");
  assert.deepEqual({ ok: lock.ok, code: (lock as { code: string }).code }, { ok: false, code: "locked" });
  assert.ok((lock as { retryAfterSec: number }).retryAfterSec >= 880, "lock ≈ 15 min");
  // even the correct token cannot unlock a locked ip
  const underLock = access.attemptUnlock("10.0.0.1", access.token);
  assert.deepEqual({ ok: underLock.ok, code: (underLock as { code: string }).code }, { ok: false, code: "locked" });

  // 6 attempts burned above; 14 more from distinct ips reaches the hourly cap
  for (let i = 1; i < 15; i++) {
    const r = access.attemptUnlock(`10.0.0.${i + 1}`, "wrong-token");
    assert.deepEqual(r, { ok: false, code: "invalid", retryAfterSec: 0, remaining: 4 });
  }
  const capped = access.attemptUnlock("10.99.99.99", "wrong-token");
  assert.deepEqual(
    { ok: capped.ok, code: (capped as { code: string }).code, hasBackoff: (capped as { retryAfterSec: number }).retryAfterSec > 0 },
    { ok: false, code: "rate_limited", hasBackoff: true },
  );
});

test("setup page: nonce-CSP html under the secret; 404 for wrong secret/standby/env off", async () => {
  const { factory } = scriptedFactory();
  const ts = await buildTestServer({ modeBox: { mode: "setup" }, setup: { loginFactory: factory } });
  try {
    const page = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html; charset=utf-8/);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]{20,}'/);
    assert.ok(csp.includes("frame-ancestors 'none'"), "no framing (doc §8 XSS row)");
    const html = await page.text();
    assert.ok(html.includes("Welcome") && html.includes("Telegram login"));
    assert.equal((await fetch(`${ts.baseUrl}/no-such-secret/setup`)).status, 404);
  } finally {
    await ts.cleanup();
  }

  // STANDBY instance: the setup routes vanish (doc 7.2)
  const ts2 = await buildTestServer({ modeBox: { mode: "standby" }, setup: { loginFactory: factory } });
  try {
    assert.equal((await fetch(`${ts2.baseUrl}/${TEST_SECRET}/setup`)).status, 404);
  } finally {
    await ts2.cleanup();
  }

  const ts3 = await buildTestServer({
    modeBox: { mode: "setup" },
    setup: { loginFactory: factory },
    extraEnv: { SETUP_ENABLED: "off" },
  });
  try {
    assert.equal((await fetch(`${ts3.baseUrl}/${TEST_SECRET}/setup`)).status, 404);
  } finally {
    await ts3.cleanup();
  }
});

test("setup unlock: correct token mints the HttpOnly strict cookie; wrong ones count down", async () => {
  const { factory } = scriptedFactory();
  const ts = await buildTestServer({ modeBox: { mode: "setup" }, setup: { loginFactory: factory } });
  try {
    const res = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ts.setupAccess!.token }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; csrf: string; maxAgeSec: number };
    assert.equal(body.maxAgeSec, 1800, "30-minute session");
    const sc = res.headers.get("set-cookie") ?? "";
    assert.ok(sc.startsWith("setup="), sc);
    for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=1800"]) assert.ok(sc.includes(part), part);
    // a wrong token from the same ip starts the countdown at 4
    const wrong = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await wrong.json(), { ok: false, code: "invalid", message: "Wrong setup token — use the link from the deploy log", remaining: 4 });
  } finally {
    await ts.cleanup();
  }
});

test("setup csrf: cookie+header pair required; wrong origin browsers 403", async () => {
  const { factory } = scriptedFactory();
  const ts = await buildTestServer({ modeBox: { mode: "setup" }, setup: { loginFactory: factory } });
  try {
    const { auth, csrf } = await unlockWizard(ts);
    const credsBody = { apiId: 12345, apiHash: CRED_API_HASH };
    // no cookie / no csrf header / wrong csrf → 403 for every setup route
    const bare = await setupPost(ts, {}, "/api/creds", credsBody);
    assert.equal(bare.status, 403);
    assert.deepEqual(await bare.json(), { ok: false, code: "forbidden" });
    const noCsrf = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/creds`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie },
      body: JSON.stringify(credsBody),
    });
    assert.equal(noCsrf.status, 403);
    const badCsrf = await setupPost(ts, { cookie: auth.cookie, "x-setup-csrf": "guessing" }, "/api/creds", credsBody);
    assert.equal(badCsrf.status, 403);
    // a valid pair gets past the gate → validation made it inside (bad hash → 400 api_id_invalid)
    const badHash = await setupPost(ts, auth, "/api/creds", { apiId: 12345, apiHash: "zz" });
    assert.equal(badHash.status, 400);
    const badHashBody = (await badHash.json()) as { code: string; message: string };
    assert.equal(badHashBody.code, "api_id_invalid");
    assert.ok(badHashBody.message.includes("32 hex"));
    // cross-origin browser requests are refused even with a valid pair
    const evil = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/creds`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth, origin: "http://evil.example" },
      body: JSON.stringify(credsBody),
    });
    assert.equal(evil.status, 403);
    // same-origin + valid pair persists the credentials
    const good = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/creds`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth, origin: ts.baseUrl },
      body: JSON.stringify(credsBody),
    });
    assert.equal(good.status, 200);
    assert.equal((await statusOf(ts)).creds, true);
  } finally {
    await ts.cleanup();
  }
});

test("setup wizard end to end: login, channels, failing then passing verify, finish, closure", async () => {
  const { logins, factory } = scriptedFactory();
  const ts = await buildTestServer({ modeBox: { mode: "setup" }, setup: { loginFactory: factory } });
  try {
    const { auth, csrf } = await unlockWizard(ts);
    // login needs credentials first (doc 7.6 row 2)
    const noCreds = await setupPost(ts, auth, "/api/login/phone", { phone: "+977981234567" });
    assert.equal(noCreds.status, 409);
    assert.equal(((await noCreds.json()) as { code: string }).code, "creds_required");

    assert.equal((await setupPost(ts, auth, "/api/creds", { apiId: 12345, apiHash: CRED_API_HASH })).status, 200);

    // phone → the scripted client asks for a code
    assert.equal((await setupPost(ts, auth, "/api/login/phone", { phone: "+977981234567" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "code");
    assert.equal((await statusOf(ts)).sentCodeTo, "+977981234567");
    // wrong code → mapped 400, status shows the mapped error, client discarded
    const bad = await setupPost(ts, auth, "/api/login/code", { code: "0000" });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { ok: boolean; code: string; message: string; next: string };
    assert.equal(badBody.ok, false);
    assert.equal(badBody.code, "phone_code_invalid");
    assert.equal(badBody.message, "The code is wrong or expired");
    assert.equal(badBody.next, "Request a new code");
    await untilStatus(ts, (s) => s.loginError?.code === "phone_code_invalid");
    assert.equal(logins[0]!.closeCount, 1, "failed login discarded (§8 remnants)");

    // restart works: phone again, right code answers password_needed (2FA is on)
    assert.equal((await setupPost(ts, auth, "/api/login/phone", { phone: "+9779812345675" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "code");
    const pwAsk = await setupPost(ts, auth, "/api/login/code", { code: "12345" });
    assert.equal(pwAsk.status, 400);
    assert.equal(((await pwAsk.json()) as { code: string }).code, "password_needed");
    await untilStatus(ts, (s) => s.loginPhase === "password");
    // wrong 2FA password → password_invalid, no lockout
    const badPw = await setupPost(ts, auth, "/api/login/password", { password: "nope" });
    assert.equal(badPw.status, 400);
    const badPwBody = (await badPw.json()) as { ok: boolean; code: string; message: string; next: string };
    assert.equal(badPwBody.ok, false);
    assert.equal(badPwBody.code, "password_invalid");
    assert.equal(badPwBody.message, "Wrong password");
    assert.equal(badPwBody.next, "Try again — no lockout on our side");

    // restart once more and complete the login
    assert.equal((await setupPost(ts, auth, "/api/login/phone", { phone: "+977981234565" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "code");
    const pwAsk2 = await setupPost(ts, auth, "/api/login/code", { code: "12345" });
    assert.equal(pwAsk2.status, 400); // 2FA: park on the password valve
    await untilStatus(ts, (s) => s.loginPhase === "password");
    assert.equal((await setupPost(ts, auth, "/api/login/password", { password: "s3cret" })).status, 200);
    const done = await untilStatus(ts, (s) => s.loginPhase === "done");
    assert.deepEqual(done.user, { id: 7, name: "Test User" });

    // channels + audio counts straight from the dialogs
    const chans = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/channels`, {
      headers: { cookie: auth.cookie, "x-setup-csrf": csrf },
    });
    assert.equal(chans.status, 200);
    assert.deepEqual(await chans.json(), [{ id: -100123, title: "Music" }]);
    const count = await setupPost(ts, auth, "/api/channels/count", { id: -100123 });
    assert.equal(count.status, 200);
    assert.deepEqual(await count.json(), { id: -100123, count: 12, total: 99 });
    const badId = await setupPost(ts, auth, "/api/channels/count", { id: 5 });
    assert.equal(badId.status, 400);
    assert.equal(((await badId.json()) as { code: string }).code, "bad_channel");

    // options (null=false) persist
    assert.equal(
      (await setupPost(ts, auth, "/api/options", { allowDownloads: false, monthlyBytesBudget: 4500000000, channels: [-100123] })).status,
      200,
    );
    const badOpt = await setupPost(ts, auth, "/api/options", { monthlyBytesBudget: -1 });
    assert.equal(badOpt.status, 400);
    assert.equal(((await badOpt.json()) as { code: string }).code, "bad_options");
    assert.deepEqual((await statusOf(ts)).options, { allowDownloads: false, monthlyBytesBudget: 4500000000 });

    // verify #1 — the wizard refuses finish while rows fail
    ts.setupSelfFetch.current = () => Promise.resolve(null); // manifest unreachable
    logins[logins.length - 1]!.readable = false; // channel joined with the account?
    ts.setupProbe.held = false; // another instance owns the session lease
    ts.setupProbe.detail = "another instance holds the lease";
    const neg = await setupPost(ts, auth, "/api/verify", {});
    assert.equal(neg.status, 200);
    const negRep = (await neg.json()) as StatusPayload["verify"];
    assert.equal(negRep!.finishAllowed, false);
    const row = (id: string) => negRep!.rows.find((r) => r.id === id)!;
    assert.equal(row("telegram").ok, true);
    assert.equal(row("channels").ok, false, `channel unreadable: ${JSON.stringify(negRep!.rows)}`);
    assert.equal(row("public_url").severity, "fail");
    assert.equal(row("lease").severity, "fail");
    assert.equal(row("audio").detail.includes("12 audio"), true);
    assert.equal(negRep!.rows.some((r) => r.id === "redis"), false, "no Redis configured → no redis row");
    const finBad = await setupPost(ts, auth, "/api/finish", {});
    assert.equal(finBad.status, 409);
    const finBadBody = (await finBad.json()) as { ok: boolean; code: string; message: string; next: string };
    assert.equal(finBadBody.code, "verify_required");
    assert.equal(finBadBody.message, "Run the checks again");
    assert.equal(finBadBody.next, "Press verify — every red row has to clear");
    assert.equal(ts.savedRecord.current, null);
    assert.equal(ts.modeBox.mode, "setup");

    // verify #2 — all checks clear
    ts.setupSelfFetch.current = (url) =>
      Promise.resolve(url.endsWith(`${TEST_SECRET}/manifest.json`) ? JSON.stringify({ id: ts.cfg.addonId }) : null);
    logins[logins.length - 1]!.readable = true;
    ts.setupProbe.held = true;
    ts.setupProbe.detail = "lease held by this instance";
    const ok = await setupPost(ts, auth, "/api/verify", {});
    const okRep = (await ok.json()) as StatusPayload["verify"];
    assert.equal(okRep!.finishAllowed, true);
    const okRow = (id: string) => okRep!.rows.find((r) => r.id === id)!;
    assert.equal(okRow("telegram").detail, "Test User");
    assert.equal(okRow("channels").detail, "channel -100123 readable");
    assert.equal(okRow("lease").detail, "lease held by this instance");
    assert.equal(okRow("public_url").detail, ts.cfg.publicBaseUrl);

    // finish: persist → swap → close
    const fin = await setupPost(ts, auth, "/api/finish", {});
    assert.equal(fin.status, 200);
    assert.deepEqual(await fin.json(), { ok: true, publicUrl: `${ts.baseUrl}/${TEST_SECRET}` });
    assert.equal(ts.modeBox.mode, "active", "bringUp landed the service in ACTIVE");
    const rec = ts.savedRecord.current!;
    assert.deepEqual(rec.sessions, ["SESSION_STRING_TEST"]);
    assert.deepEqual(rec.channels, [-100123]);
    assert.equal(rec.apiId, 12345);
    assert.equal(rec.apiHash, CRED_API_HASH);
    assert.deepEqual(rec.options, { allowDownloads: false, monthlyBytesBudget: 4500000000 });
    // the encrypted store round-trips through the same record (FR-28)
    const blob = readFileSync(path.join(ts.dir, "config.enc"), "utf8");
    const plain = decryptConfig(blob, ts.cfg.configKey);
    assert.ok(plain, "config blob decrypts");
    const round = parseStoredConfig(plain);
    assert.ok(round, "parsed v1 record");
    assert.deepEqual(round.sessions, rec.sessions);
    assert.deepEqual(round.channels, rec.channels);
    assert.deepEqual(round.options, rec.options);

    // closure: the site 404s, status keeps answering, remnants cleared
    assert.equal((await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup`)).status, 404);
    const afterCreds = await setupPost(ts, auth, "/api/creds", { apiId: 1, apiHash: CRED_API_HASH });
    assert.equal(afterCreds.status, 404);
    const sAfter = await statusOf(ts);
    assert.equal(sAfter.closed, true);
    assert.equal(sAfter.publicUrl, `${ts.baseUrl}/${TEST_SECRET}`);
    assert.equal(sAfter.user, null);
    assert.ok(logins.every((l) => l.closeCount >= 1), "every discarded login was closed");

    // session backup (doc §7.4): the deploy-log token reveals it once
    assert.equal((await statusOf(ts)).backupReady, true);
    const backupA = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/session`, {
      headers: { "x-setup-token": ts.setupAccess!.token },
    });
    assert.equal(backupA.status, 200);
    const backupBody = (await backupA.json()) as { ok: boolean; session: string };
    assert.equal(backupBody.ok, true);
    assert.equal(backupBody.session, "SESSION_STRING_TEST");
    assert.equal((await statusOf(ts)).backupReady, false, "the string never shows twice");
    const backupAgain = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/session`, {
      headers: { "x-setup-token": ts.setupAccess!.token },
    });
    assert.equal(backupAgain.status, 404, "second reveal is gone");
    const backupBad = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/session`, {
      headers: { "x-setup-token": "nope" },
    });
    assert.equal(backupBad.status, 403, "a wrong link cannot brute-force the backup");
    await backupBad.json(); // drain the body
    assert.equal((await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/session`)).status, 403, "no header → forbidden");
  } finally {
    await ts.cleanup();
  }
});

test("setup finish: a failed bring-up answers startup_pending 503; a retry can pass", async () => {
  const { factory } = scriptedFactory();
  let bringUpCalls = 0;
  const ts = await buildTestServer({
    modeBox: { mode: "setup" },
    setup: {
      loginFactory: factory,
      async bringUp() {
        bringUpCalls += 1;
        // doc 7.9.3: the swap may not land yet — surface it, keep the wizard open
        return bringUpCalls === 1 ? { ok: false, message: "flaky swap" } : { ok: true };
      },
    },
  });
  try {
    const { auth } = await unlockWizard(ts);
    assert.equal((await setupPost(ts, auth, "/api/creds", { apiId: 12345, apiHash: CRED_API_HASH })).status, 200);
    assert.equal((await setupPost(ts, auth, "/api/login/phone", { phone: "+977981234567" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "code");
    assert.equal((await setupPost(ts, auth, "/api/login/code", { code: "12345" })).status, 400); // 2FA park
    await untilStatus(ts, (s) => s.loginPhase === "password");
    assert.equal((await setupPost(ts, auth, "/api/login/password", { password: "s3cret" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "done");
    assert.equal(
      (await setupPost(ts, auth, "/api/options", { allowDownloads: true, monthlyBytesBudget: 4500000000, channels: [-100123] })).status,
      200,
    );
    ts.setupSelfFetch.current = (url) =>
      Promise.resolve(url.endsWith(`${TEST_SECRET}/manifest.json`) ? JSON.stringify({ id: ts.cfg.addonId }) : null);
    const rep = (await (await setupPost(ts, auth, "/api/verify", {})).json()) as StatusPayload["verify"];
    assert.equal(rep!.finishAllowed, true);

    const first = await setupPost(ts, auth, "/api/finish", {});
    assert.equal(first.status, 503);
    const firstBody = (await first.json()) as { code: string; message: string };
    assert.equal(firstBody.code, "startup_pending");
    assert.equal(firstBody.message, "flaky swap");
    assert.equal((await statusOf(ts)).closed, false, "the wizard stays open for a retry");

    const retry = await setupPost(ts, auth, "/api/finish", {});
    assert.equal(retry.status, 200);
    assert.equal(bringUpCalls, 2);
    assert.equal((await statusOf(ts)).closed, true);
  } finally {
    await ts.cleanup();
  }
});

test("setup idle: inactivity discards the login and surfaces login_idle (doc 7.6)", async () => {
  const { logins, factory } = scriptedFactory();
  const ts = await buildTestServer({ modeBox: { mode: "setup" }, setup: { loginFactory: factory, idleMs: 300 } });
  try {
    const { auth, csrf } = await unlockWizard(ts);
    assert.equal((await setupPost(ts, auth, "/api/creds", { apiId: 12345, apiHash: CRED_API_HASH })).status, 200);
    assert.equal((await setupPost(ts, auth, "/api/login/phone", { phone: "+977981234567" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "code");
    assert.equal((await setupPost(ts, auth, "/api/login/code", { code: "12345" })).status, 400); // 2FA park
    await untilStatus(ts, (s) => s.loginPhase === "password");
    assert.equal((await setupPost(ts, auth, "/api/login/password", { password: "s3cret" })).status, 200);
    await untilStatus(ts, (s) => s.loginPhase === "done");
    await sleep(500);

    const s = await statusOf(ts);
    assert.equal(s.loginPhase, null);
    assert.equal(s.loginError?.code, "login_idle");
    assert.equal(s.user, null, "login state is not kept alive");
    // the discarded login cannot be reused for channels
    const chans = await fetch(`${ts.baseUrl}/${TEST_SECRET}/setup/api/channels`, {
      headers: { cookie: auth.cookie, "x-setup-csrf": csrf },
    });
    assert.equal(chans.status, 409);
    assert.equal(((await chans.json()) as { code: string }).code, "login_required");
    assert.ok(logins.every((l) => l.closeCount >= 1), "idle discard closed the seam");
  } finally {
    await ts.cleanup();
  }
});

/* ===================== M6.12 snapshot restore visibility ===================== */

test("index snapshot round-trips tracks + cursors so a restored boot crawls nothing", async () => {
  const fake = await startFakeRedis();
  const store = openRedisStore({ url: fake.url, timeoutMs: 400, snapshot: true })!;
  await waitUp(store);
  const dir = mkdtempSync(path.join(os.tmpdir(), "m6-snap-"));
  try {
    const cfg = loadConfig({
      PORT: "1",
      PUBLIC_BASE_URL: "http://127.0.0.1:9",
      ALLOW_INSECURE_BASE_URL: "1",
      ADDON_SECRET: TEST_SECRET,
      MEDIA_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
      DB_PATH: dir,
      REDIS_URL: fake.url,
      REDIS_TIMEOUT_MS: "400",
      REDIS_SNAPSHOT: "1",
    });
    assert.equal(cfg.redis.snapshot, true, "REDIS_SNAPSHOT=1 parses on");

    // source index: two tracks + a real sync cursor
    const db1 = openDb(path.join(dir, "a.sqlite"));
    createSchema(db1);
    upsertTrack(db1, {
      id: "tg_n-100123_1",
      chatId: -100123,
      msgId: 1,
      title: "Song One",
      artist: "A",
      album: null,
      duration: 100,
      mime: "audio/mpeg",
      size: 1000,
      fileName: "a.mp3",
      codec: null,
      container: "mp3",
      lossless: 0,
      bitrateKbps: null,
      docId: 1,
      source: "telegram",
      filePath: null,
      hasThumb: 0,
      addedAt: 1,
    });
    upsertTrack(db1, {
      id: "tg_n-100123_2",
      chatId: -100123,
      msgId: 2,
      title: "Song Two",
      artist: "B",
      album: null,
      duration: 200,
      mime: "audio/mpeg",
      size: 2000,
      fileName: "b.flac",
      codec: null,
      container: "flac",
      lossless: 1,
      bitrateKbps: null,
      docId: 2,
      source: "telegram",
      filePath: null,
      hasThumb: 0,
      addedAt: 2,
    });
    setCursor(db1, -100123, 1234);
    const snap = exportTrackSnapshot(db1);
    assert.deepEqual(snap.cursors, [{ chatId: -100123, cursor: 1234 }]);

    // store it exactly like the sync pass does (gzip -> writeSnapshot)
    const { gzip: gzipCb } = await import("node:zlib");
    const gz = await new Promise<Buffer>((resolve, reject) =>
      gzipCb(Buffer.from(JSON.stringify(snap), "utf8"), (e, o) => (e ? reject(e) : resolve(o as Buffer))),
    );
    store.writeSnapshot(gz);
    for (let i = 0; i < 40 && !fake.data.get("index:snapshot"); i++) await sleep(50);
    assert.ok(fake.data.get("index:snapshot"), "snapshot landed in redis");

    // fresh free-plan disk: restore, then a re-crawl would only see the cursor
    const db2 = openDb(path.join(dir, "b.sqlite"));
    createSchema(db2);
    const restored = await restoreSnapshotIfEmpty(db2, cfg, store);
    assert.equal(restored, 2, "snapshot restored both tracks");
    assert.deepEqual(listCursors(db2), [{ chatId: -100123, cursor: 1234 }]);

    // a fresh empty disk without redis never restores
    const db3 = openDb(path.join(dir, "c.sqlite"));
    createSchema(db3);
    assert.equal(await restoreSnapshotIfEmpty(db3, cfg, null), 0, "no redis = no restore");
  } finally {
    store.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
