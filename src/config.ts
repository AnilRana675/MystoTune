/**
 * Environment configuration — PRD/TRD v2.2 §4.10 (env vars), §4.11 (storage),
 * §4.12 (resource limits). All parsing/validation lives here.
 */
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";

dotenv.config({ override: false });

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface AppConfig {
  port: number;
  /** No trailing slash. `https://` required in production. */
  publicBaseUrl: string;
  /** Dev-only flag: allows http://localhost base URL (fixture testing). */
  pubinsecureBaseAllowed: boolean;
  /** Manifest identity (FR-1): stable id, non-empty. */
  addonId: string;
  addonName: string;
  addonDescription: string;
  addonVersion: string;
  /** Secret path prefix for all protocol routes (§4.8). */
  addonSecret: string;
  /** HMAC key for signed media URLs. Never leave process. */
  mediaSigningKey: Buffer;
  /** Default 21600 (6 h), must be >= 300 (§4.3). */
  mediaUrlTtlSeconds: number;
  telegram: {
    apiId: number | null;
    apiHash: string | null;
    session: string | null;
    channels: number[];
    configured: boolean;
  };
  dbPath: string;
  maxIndexEntries: number;
  syncIntervalMinutes: number;
  reconcileIntervalHours: number;
  maxConcurrentStreams: number;
  admissionWaitMs: number;
  allowDownloads: boolean;
  checkValidLossless: boolean;
  logLevel: LogLevel;
  redis: { url: string; timeoutMs: number; snapshot: boolean };
}

export class ConfigError extends Error {}

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === null) return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ConfigError(`${name} must be "0" or "1", got "${raw}"`);
}

/** Decode MEDIA_SIGNING_KEY: 32+ bytes as hex or (strict) base64. §4.8 */
export function decodeSigningKey(raw: string): Buffer {
  const b64 = Buffer.from(raw, "base64");
  const reencoded = b64.toString("base64");
  if (b64.length >= 32 && reencoded === raw) return b64; // exact base64 round-trip
  const hex = Buffer.from(raw, "hex");
  const hexOk = /^[0-9a-f]*$/i.test(raw) && raw.length % 2 === 0 && hex.toString("hex").toLowerCase() === raw.toLowerCase();
  if (hexOk && hex.length >= 32) return hex;
  throw new ConfigError(
    "MEDIA_SIGNING_KEY must be 32+ random bytes. Generate with `openssl rand -base64 32` (§4.10).",
  );
}

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizePublicBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env["PUBLIC_BASE_URL"];
  if (!raw) throw new ConfigError("PUBLIC_BASE_URL is required (§4.10). It must be the https:// domain BitChord calls.");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL is not a valid URL: "${raw}"`);
  }
  const insecureAllowed = boolEnv(env, "ALLOW_INSECURE_BASE_URL", false);
  if (u.protocol === "https:") {
    // ok in production
  } else if (u.protocol === "http:" && insecureAllowed && DEV_HOSTS.has(u.hostname.toLowerCase())) {
    // ok for local fixture testing only
  } else {
    throw new ConfigError("PUBLIC_BASE_URL must be https:// (BitChord requires HTTPS). DEV override: http://127.0.0.1 with ALLOW_INSECURE_BASE_URL=1 (§4.10)");
  }
  return u.origin + (u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "");
}

function parseChannels(env: NodeJS.ProcessEnv): number[] {
  const raw = env["TARGET_CHANNEL_IDS"] ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (!/^-?\d+(,-?\d+)*$/.test(trimmed.replace(/\s+/g, ""))) {
    throw new ConfigError(`TARGET_CHANNEL_IDS must be comma separated integers like -1001234567890,-100987654321, got "${raw}"`);
  }
  return trimmed.split(",").map((s) => Number(s.trim()));
}

function packageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const addonSecret = env["ADDON_SECRET"] ?? "";
  if (addonSecret.length < 32) {
    throw new ConfigError(
      `ADDON_SECRET must be at least 32 characters (got ${addonSecret.length}). Generate with \`openssl rand -hex 24\` (§4.8, §4.10).`,
    );
  }

  const apiIdRaw = env["TELEGRAM_API_ID"];
  const apiId = apiIdRaw ? intEnv(env, "TELEGRAM_API_ID", 0, 1, Number.MAX_SAFE_INTEGER) : null;
  const apiHash = env["TELEGRAM_API_HASH"]?.trim() || null;
  const session = env["TELEGRAM_SESSION_STRING"]?.trim() || null;
  const channels = parseChannels(env);
  const telegramConfigured = Boolean(apiId && apiHash && session);
  if (session && !(apiId && apiHash)) {
    throw new ConfigError("TELEGRAM_SESSION_STRING is set but TELEGRAM_API_ID/TELEGRAM_API_HASH are missing (§4.10).");
  }

  const mediaSigningKey = decodeSigningKey(env["MEDIA_SIGNING_KEY"] ?? "");
  const mediaUrlTtlSeconds = intEnv(env, "MEDIA_URL_TTL_SECONDS", 21600, 300, 2_592_000);

  return {
    port: intEnv(env, "PORT", 8080, 1, 65535),
    publicBaseUrl: normalizePublicBaseUrl(env),
    pubinsecureBaseAllowed: boolEnv(env, "ALLOW_INSECURE_BASE_URL", false),
    addonId: env["ADDON_ID"]?.trim() || "dev.mystotune.telegram-addon",
    addonName: env["ADDON_NAME"]?.trim() || "Telegram Library",
    addonDescription: env["ADDON_DESCRIPTION"]?.trim() || "Streams music from your own Telegram channels",
    addonVersion: env["ADDON_VERSION"]?.trim() || packageVersion(),
    addonSecret,
    mediaSigningKey,
    mediaUrlTtlSeconds,
    telegram: { apiId, apiHash, session, channels, configured: telegramConfigured },
    dbPath: env["DB_PATH"]?.trim() || "/data/index.sqlite",
    maxIndexEntries: intEnv(env, "MAX_INDEX_ENTRIES", 50000, 1, 10_000_000),
    syncIntervalMinutes: intEnv(env, "SYNC_INTERVAL_MINUTES", 10, 1, 1440),
    reconcileIntervalHours: intEnv(env, "RECONCILE_INTERVAL_HOURS", 24, 1, 720),
    maxConcurrentStreams: intEnv(env, "MAX_CONCURRENT_STREAMS", 2, 1, 64),
    admissionWaitMs: intEnv(env, "ADMISSION_WAIT_MS", 2000, 100, 60_000),
    allowDownloads: boolEnv(env, "ALLOW_DOWNLOADS", true),
    checkValidLossless: boolEnv(env, "CHECK_VALID_LOSSLESS", false),
    logLevel: LEVELS.includes(env["LOG_LEVEL"] as LogLevel) ? (env["LOG_LEVEL"] as LogLevel) : "warn",
    redis: {
      url: env["REDIS_URL"]?.trim() || "",
      timeoutMs: intEnv(env, "REDIS_TIMEOUT_MS", 200, 10, 10_000),
      snapshot: boolEnv(env, "REDIS_SNAPSHOT", false),
    },
  };
}

/** Rate limiting defaults (§4.8). Not env-configurable keeps the contract small. */
export const RATE_LIMITS = {
  searchPerMinute: 60,
  streamPerMinute: 120,
  windowMs: 60_000,
} as const;
