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
import { buildServer, type RateLimiter } from "../src/server.js";
import type { Admissions } from "../src/media.js";
import type { Metrics } from "../src/server.js";
import { openRedisStore, type RedisStore } from "../src/redis.js";
import { seedFixtureDb, CHAT_ID } from "../scripts/seed-fixture.js";

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
  const app = buildServer({
    config: cfg,
    db,
    telegram,
    redis,
    rateLimiter: overrides.rateLimiter,
  }) as AugmentedApp;
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
  return { app, baseUrl, db, cfg, telegram, dir, tracks, redis, cleanup };
}

/** GET a JSON payload under the test secret. */
export async function fetchJson(ts: TestServer, pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ts.baseUrl}${pathname}`, init);
}
