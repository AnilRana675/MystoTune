/**
 * Test harness: spins up the real Fastify app on an ephemeral port backed by a
 * seeded fixture DB in a throwaway directory, plus tiny fetch helpers.
 */
import net from "node:net";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDb, createSchema, countTracks, type TrackRow } from "../src/db.js";
import { TelegramManager } from "../src/telegram.js";
import { buildServer, type AddonModeBox, type RateLimiter } from "../src/server.js";
import type { Admissions } from "../src/media.js";
import type { Metrics } from "../src/server.js";
import { openRedisStore, type RedisStore } from "../src/redis.js";
import { seedFixtureDb, CHAT_ID } from "../scripts/seed-fixture.js";
import { ConfigStore, type StoredConfigV1 } from "../src/configStore.js";
import { SetupAccess, SetupManager, type LoginFactory, type SetupDeps } from "../src/setup.js";

export { CHAT_ID };

export const TEST_SECRET = "0123456789abcdef0123456789abcdef0123abcd";

export interface AugmentedApp extends FastifyInstance {
  metrics: Metrics;
  admissions: Admissions;
}

export interface TestServer {
  app: AugmentedApp;
  baseUrl: string;
  db: Database.Database;
  cfg: AppConfig;
  telegram: TelegramManager;
  dir: string;
  tracks: TrackRow[];
  /** present when the tests inject a Redis-backed limiter/cache (§4.11) */
  redis: RedisStore | null;
   cleanup(): Promise<void>;
  /** M6.2: wizard surfaces (present when overrides.setup was given). */
  setupAccess?: SetupAccess;
  setupManager?: SetupManager;
  /** record captured by the default scripted bringUp (null until finish()). */
  savedRecord: { current: StoredConfigV1 | null };
  /** live mode cell (tests assert SETUP->STANDBY->ACTIVE after finish). */
  modeBox: AddonModeBox;
  /** mutable knobs tests flip between verify runs. */
  setupProbe: { held: boolean; detail: string };
  setupSelfFetch: { current: ((url: string) => Promise<string | null>) | null };
}

/** Grab a free TCP port atomically-ish (bind 0, read it, close). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
      } else reject(new Error("no address"));
    });
  });
}

export async function buildTestServer(
  overrides: Partial<Pick<AppConfig, "maxConcurrentStreams" | "admissionWaitMs" | "logLevel">> & {
    useFfmpeg?: boolean;
    /** nonexistent URLs exercise the Redis-down fallback path (§4.11 rule 3) */
    redisUrl?: string | null;
    rateLimiter?: RateLimiter;
    /** attach the store to the TelegramManager as main() does (M3 flood/doc) */
    telegramRedis?: boolean;
    /** M6.1: inject a service-mode cell (standby/setup/draining route tests). */
    modeBox?: AddonModeBox;
    /** M6.2: scripted wizard deps (the harness builds redis-less SetupDeps). */
    setup?: {
      idleMs?: number;
      loginFactory: LoginFactory;
      selfFetcher?: (url: string) => Promise<string | null>;
      leaseProbe?: { held: boolean; detail: string };
      bringUp?: (record: StoredConfigV1) => Promise<{ ok: boolean; message?: string }>;
    };
    /** passthrough env overrides (M5: MONTHLY_BYTES_BUDGET, BOOT_AUTH_*...) */
    extraEnv?: Record<string, string | undefined>;
  } = {},
): Promise<TestServer> {
  const port = await freePort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "bitchord-test-"));
  const env: NodeJS.ProcessEnv = {
    PORT: String(port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    ALLOW_INSECURE_BASE_URL: "1",
    ADDON_SECRET: TEST_SECRET,
    // fixed 32-byte key, deterministic signing in tests
    MEDIA_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64"),
    MEDIA_URL_TTL_SECONDS: "21600",
    DB_PATH: path.join(dir, "index.sqlite"),
    MAX_CONCURRENT_STREAMS: String(overrides.maxConcurrentStreams ?? 2),
    ADMISSION_WAIT_MS: String(overrides.admissionWaitMs ?? 2000),
    LOG_LEVEL: overrides.logLevel ?? "error",
    TARGET_CHANNEL_IDS: String(CHAT_ID),
    ...overrides.extraEnv,
  };
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  createSchema(db);
  seedFixtureDb(db, path.join(dir, "fixtures"), {
    quiet: true,
    useFfmpeg: overrides.useFfmpeg ?? false,
    includePrngOnly: true,
  });
  const redis = overrides.redisUrl ? openRedisStore({ url: overrides.redisUrl, timeoutMs: 200, snapshot: false }) : null;
  const telegram = new TelegramManager(cfg, overrides.telegramRedis ? redis : null);
  const modeBox: AddonModeBox = overrides.modeBox ?? { mode: "active" };
  const savedRecord: { current: StoredConfigV1 | null } = { current: null };
  const setupProbe = {
    held: overrides.setup?.leaseProbe?.held ?? true,
    detail: overrides.setup?.leaseProbe?.detail ?? "lease available (test)",
  };
  const setupSelfFetch: { current: ((url: string) => Promise<string | null>) | null } = {
    current: overrides.setup?.selfFetcher ?? null,
  };
  let setupDeps: SetupDeps | undefined;
  if (overrides.setup) {
    const s = overrides.setup;
    setupDeps = {
      cfg,
      configStore: new ConfigStore({ key: cfg.configKey, filePath: path.join(dir, "config.enc") }),
      redis: null,
      loginFactory: s.loginFactory,
      // default scripted bringUp: capture the record and flip SETUP->STANDBY->ACTIVE
      bringUp:
        s.bringUp ??
        (async (record) => {
          savedRecord.current = record;
          modeBox.mode = "standby";
          await new Promise((r) => setTimeout(r, 5));
          modeBox.mode = "active";
          return { ok: true };
        }),
      leaseProbe: async () => ({ ...setupProbe }),
      selfFetcher: (url) =>
        setupSelfFetch.current
          ? setupSelfFetch.current(url)
          : fetch(url)
              .then((r) => (r.ok ? r.text() : null))
              .catch(() => null),
      idleMs: s.idleMs,
    };
  }
  const app = buildServer({
    config: cfg,
    db,
    telegram,
    redis,
    rateLimiter: overrides.rateLimiter,
    modeBox,
    setup: setupDeps,
  }) as AugmentedApp & { setup?: { access: SetupAccess; manager: SetupManager } };
  await app.listen({ port, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${port}`;
  const tracks: TrackRow[] = [];
  for (let msgId = 1; msgId <= countTracks(db); msgId++) {
    const row = db
      .prepare("SELECT rowid AS rowid, * FROM tracks WHERE chatId = ? AND msgId = ?")
      .get(CHAT_ID, msgId) as TrackRow | undefined;
    if (row) tracks.push(row);
  }
  const cleanup = async (): Promise<void> => {
    await app.close();
    // Undici keep-alive sockets (incl. cancelled streams) would otherwise keep
    // the event loop ticking and crash node:test with "aborted by client".
    (app.server as { closeAllConnections?: () => void }).closeAllConnections?.();
    redis?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    app,
    baseUrl,
    db,
    cfg,
    telegram,
    dir,
    tracks,
    redis,
    cleanup,
    modeBox,
    savedRecord,
    setupProbe,
    setupSelfFetch,
    setupAccess: app.setup?.access,
    setupManager: app.setup?.manager,
  };
}

/** GET a JSON payload under the test secret. */
export async function fetchJson(ts: TestServer, pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ts.baseUrl}${pathname}`, init);
}
