/**
 * Environment configuration — PRD/TRD v2.2 §4.10 (env vars), §4.11 (storage),
 * §4.12 (resource limits). All parsing/validation lives here.
 *
 * M6 (doc 7.3): resolution order is env > config store > profile > built-ins.
 * APP_SEED alone can boot the whole app — `deriveSecrets` (src/keys.ts) turns
 * it into ADDON_SECRET / MEDIA_SIGNING_KEY / CONFIG_KEY, while explicit env
 * vars always win. `applyStoredConfig` fills the second layer (values saved by
 * the setup wizard) in for anything the env left unset.
 */
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveConfigKeyFromLegacy, deriveSecrets } from "./keys";

dotenv.config({ override: false });

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** SETUP_ENABLED (doc appendix B): auto-on while unconfigured. */
export type SetupEnabled = "auto" | "on" | "off";
/** PROFILE (FR-32): render when RENDER=true, else vps — PROFILE overrides. */
export type DeployProfile = "render" | "vps";

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
  /** 32-byte AES-256-GCM key for the encrypted config store (FR-28). */
  configKey: Buffer;
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
  /** §4.15 Render profile: monthly egress budget in bytes. Default is 0 =
   * unlimited; set MONTHLY_BYTES_BUDGET to opt into a soft cap (404-fallback). */
  monthlyBytesBudget: number;
  /** §4.15 deploy overlap: boot-time retries for AUTH_KEY_DUPLICATED. */
  bootAuthRetries: number;
  /** Wait between boot auth retries (seconds). */
  bootAuthRetryWaitSeconds: number;
  /** FR-22: when the setup site is reachable ("auto" = on while unconfigured). */
  setupEnabled: SetupEnabled;
  /** FR-32 deployment profile steering defaults (§4.15 constants on render). */
  profile: DeployProfile;
  /** FR-31 session lease + FR-22 drain timing (M6 state machine). */
  lease: {
    ttlMs: number;
    renewMs: number;
    pollMs: number;
    drainMs: number;
    sessionSlots: number;
  };
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

function normalizePublicBaseUrl(raw: string, insecureAllowed: boolean): string {
  if (!raw) {
    throw new ConfigError(
      "PUBLIC_BASE_URL is required (§4.10). It must be the https:// domain BitChord calls, or the setup wizard sets it from RENDER_EXTERNAL_URL.",
    );
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL is not a valid URL: "${raw}"`);
  }
  if (u.protocol === "https:") {
    // ok in production (Render's RENDER_EXTERNAL_URL always qualifies)
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

/** SETUP_ENABLED: "auto" (default) means on while unconfigured. */
function parseSetupEnabled(env: NodeJS.ProcessEnv): SetupEnabled {
  const raw = env["SETUP_ENABLED"];
  if (raw === undefined || raw === "") return "auto";
  const t = raw.trim().toLowerCase();
  if (t === "auto") return "auto";
  if (t === "1" || t === "on" || t === "true") return "on";
  if (t === "0" || t === "off" || t === "false") return "off";
  throw new ConfigError(`SETUP_ENABLED must be "auto", "1" (on) or "0" (off), got "${raw}"`);
}

/** PROFILE autodetect (FR-32): RENDER=true means Render; PROFILE overrides. */
function parseDeployProfile(env: NodeJS.ProcessEnv): DeployProfile {
  const raw = env["PROFILE"]?.trim().toLowerCase();
  if (raw === "render" || raw === "vps") return raw;
  if (raw) throw new ConfigError(`PROFILE must be "render" or "vps", got "${raw}"`);
  return env["RENDER"] ? "render" : "vps";
}

/**
 * FR-24 (addon manifest version). Render boots dist/src/server.js, where
 * ".." from __dirname is dist/ — package.json lives TWO levels up — so walk
 * the candidate roots instead of assuming the tsx layout. ADDON_VERSION env
 * still overrides (loadConfig).
 */
export function packageVersion(): string {
  for (const up of ["..", "../.."]) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(__dirname, up, "package.json"), "utf8")) as {
        version?: string;
      };
      return pkg.version ?? "0.0.0";
    } catch {
      /* try the next root */
    }
  }
  return "0.0.0";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  /* FR-29 (doc 7.3): explicit env always wins; APP_SEED fills the rest. */
  const seedRaw = env["APP_SEED"]?.trim() || null;
  const derived = seedRaw ? deriveSecrets(seedRaw) : null;

  const addonSecretRaw = env["ADDON_SECRET"] ?? "";
  const addonSecret: string =
    addonSecretRaw !== ""
      ? addonSecretRaw
      : derived?.addonSecret ?? "";
  if (addonSecret.length < 32) {
    if (addonSecretRaw !== "") {
      throw new ConfigError(
        `ADDON_SECRET must be at least 32 characters (got ${addonSecret.length}). Generate with \`openssl rand -hex 24\` (§4.8, §4.10).`,
      );
    }
    throw new ConfigError(
      "ADDON_SECRET is missing. Set APP_SEED (`openssl rand -base64 32`) and let it derive the secret, or set ADDON_SECRET explicitly (§4.8, FR-29).",
    );
  }

  const mediaSigningKeyRaw = env["MEDIA_SIGNING_KEY"] ?? "";
  const mediaSigningKey: Buffer =
    mediaSigningKeyRaw !== "" ? decodeSigningKey(mediaSigningKeyRaw) : derived !== null ? derived.mediaSigningKey : Buffer.alloc(0);
  if (mediaSigningKey.length < 32) {
    throw new ConfigError(
      "MEDIA_SIGNING_KEY is missing. Set APP_SEED (`openssl rand -base64 32`) and let it derive the key, or set MEDIA_SIGNING_KEY explicitly (§4.8, FR-29).",
    );
  }

  const configKeyRaw = env["CONFIG_KEY"]?.trim() || null;
  const configKey: Buffer =
    configKeyRaw !== null
      ? decodeSigningKey(configKeyRaw)
      : seedRaw
        ? derived!.configKey
        : deriveConfigKeyFromLegacy(addonSecret, mediaSigningKey); // pre-APP_SEED .env boots

  const apiIdRaw = env["TELEGRAM_API_ID"];
  const apiId = apiIdRaw ? intEnv(env, "TELEGRAM_API_ID", 0, 1, Number.MAX_SAFE_INTEGER) : null;
  const apiHash = env["TELEGRAM_API_HASH"]?.trim() || null;
  const session = env["TELEGRAM_SESSION_STRING"]?.trim() || null;
  const channels = parseChannels(env);
  const telegramConfigured = Boolean(apiId && apiHash && session);
  if (session && !(apiId && apiHash)) {
    throw new ConfigError("TELEGRAM_SESSION_STRING is set but TELEGRAM_API_ID/TELEGRAM_API_HASH are missing (§4.10).");
  }

  const mediaUrlTtlSeconds = intEnv(env, "MEDIA_URL_TTL_SECONDS", 21600, 300, 2_592_000);
  const publicBaseRaw = env["PUBLIC_BASE_URL"] ?? env["RENDER_EXTERNAL_URL"] ?? "";

  return {
    port: intEnv(env, "PORT", 8080, 1, 65535),
    publicBaseUrl: normalizePublicBaseUrl(publicBaseRaw, boolEnv(env, "ALLOW_INSECURE_BASE_URL", false)),
    pubinsecureBaseAllowed: boolEnv(env, "ALLOW_INSECURE_BASE_URL", false),
    addonId: env["ADDON_ID"]?.trim() || "dev.mystotune.telegram-addon",
    addonName: env["ADDON_NAME"]?.trim() || "MystoTune",
    addonDescription: env["ADDON_DESCRIPTION"]?.trim() || "MystoTune — your Telegram music library, searchable and streamable in BitChord",
    addonVersion: env["ADDON_VERSION"]?.trim() || packageVersion(),
    addonSecret,
    mediaSigningKey,
    mediaUrlTtlSeconds,
    configKey,
    telegram: { apiId, apiHash, session, channels, configured: telegramConfigured },
    dbPath: env["DB_PATH"]?.trim() || "/data/index.sqlite",
    maxIndexEntries: intEnv(env, "MAX_INDEX_ENTRIES", 50000, 1, 10_000_000),
    syncIntervalMinutes: intEnv(env, "SYNC_INTERVAL_MINUTES", 10, 1, 1440),
    reconcileIntervalHours: intEnv(env, "RECONCILE_INTERVAL_HOURS", 24, 1, 720),
    maxConcurrentStreams: intEnv(env, "MAX_CONCURRENT_STREAMS", 2, 1, 64),
    admissionWaitMs: intEnv(env, "ADMISSION_WAIT_MS", 2000, 100, 60_000),
    allowDownloads: boolEnv(env, "ALLOW_DOWNLOADS", true),
    checkValidLossless: boolEnv(env, "CHECK_VALID_LOSSLESS", false),
    monthlyBytesBudget: intEnv(env, "MONTHLY_BYTES_BUDGET", 0, 0, 1_000_000_000_000),
    bootAuthRetries: intEnv(env, "BOOT_AUTH_RETRIES", 3, 1, 10),
    bootAuthRetryWaitSeconds: intEnv(env, "BOOT_AUTH_RETRY_WAIT_SECONDS", 60, 0, 3_600),
    setupEnabled: parseSetupEnabled(env),
    profile: parseDeployProfile(env),
    lease: {
      ttlMs: intEnv(env, "LEASE_TTL_MS", 45_000, 1_000, 600_000),
      renewMs: intEnv(env, "LEASE_RENEW_MS", 15_000, 1_000, 360_000),
      pollMs: intEnv(env, "LEASE_POLL_MS", 5_000, 250, 60_000),
      drainMs: intEnv(env, "DRAIN_MS", 10_000, 1_000, 60_000),
      sessionSlots: intEnv(env, "SESSION_SLOTS", 1, 1, 8),
    },
    logLevel: LEVELS.includes(env["LOG_LEVEL"] as LogLevel) ? (env["LOG_LEVEL"] as LogLevel) : "warn",
    redis: {
      url: env["REDIS_URL"]?.trim() || "",
      timeoutMs: intEnv(env, "REDIS_TIMEOUT_MS", 200, 10, 10_000),
      snapshot: boolEnv(env, "REDIS_SNAPSHOT", false),
    },
  };
}

/**
 * CONFIG_KEY (FR-28): explicit env wins; derived from APP_SEED otherwise.
 * standalone helper so loadConfig stays flat; throws with the doc's message.
 */
function deriveConfigKey(seedRaw: string | null, configKeyRaw: string | null): Buffer {
  if (configKeyRaw) return decodeSigningKey(configKeyRaw);
  if (seedRaw) return deriveSecrets(seedRaw).configKey;
  throw new ConfigError(
    "CONFIG_KEY is missing. Set APP_SEED (`openssl rand -base64 32`) and let it derive the key, or set CONFIG_KEY explicitly (FR-28).",
  );
}

/** Rate limiting defaults (§4.8). Not env-configurable keeps the contract small. */
export const RATE_LIMITS = {
  searchPerMinute: 60,
  streamPerMinute: 120,
  windowMs: 60_000,
} as const;

/**
 * FR-28 (doc 7.3): merge a stored config record into the resolved config.
 *
 * Explicit env ALWAYS wins — the store only fills values the env left unset
 * (or left at its default). Callers run this once in main() after the store
 * is opened, BEFORE the Telegram client is constructed (FR-22).
 *
 * Returns the merged copy; the input `cfg` is not mutated.
 */
export function applyStoredConfig(
  cfg: AppConfig,
  stored: Partial<Pick<
    StoredConfigLike["record"],
    "apiId" | "apiHash" | "sessions" | "channels" | "options"
  >> | null,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  if (!stored) return cfg;

  const envApiId = env["TELEGRAM_API_ID"];
  const envApiHash = env["TELEGRAM_API_HASH"]?.trim();
  const envSession = env["TELEGRAM_SESSION_STRING"]?.trim();
  const envChannelsRaw = env["TARGET_CHANNEL_IDS"]?.trim() ?? "";
  const envDownloads = env["ALLOW_DOWNLOADS"];
  const envBudget = env["MONTHLY_BYTES_BUDGET"];

  const apiId = cfg.telegram.apiId ?? stored.apiId ?? null;
  const apiHash = cfg.telegram.apiHash ?? stored.apiHash ?? null;
  // Latest session wins (FR-35 stores multiple; the newest auth is freshest).
  const storedSession = stored.sessions && stored.sessions.length > 0 ? stored.sessions[stored.sessions.length - 1] : null;
  const session = envSession ?? storedSession ?? null;
  const channels = envChannelsRaw ? cfg.telegram.channels : stored.channels?.length ? stored.channels : cfg.telegram.channels;

  const allowDownloads = envDownloads !== undefined && envDownloads !== "" ? cfg.allowDownloads : stored.options?.allowDownloads ?? cfg.allowDownloads;
  const monthlyBytesBudget = envBudget !== undefined && envBudget !== "" ? cfg.monthlyBytesBudget : stored.options?.monthlyBytesBudget ?? cfg.monthlyBytesBudget;

  const merged: AppConfig = {
    ...cfg,
    monthlyBytesBudget,
    allowDownloads,
    telegram: {
      apiId,
      apiHash,
      session,
      channels,
      configured: Boolean(apiId && apiHash && session),
    },
  };

  // Re-check the §4.10 invariant for the combined picture (a store-provided
  // apiId with an env-only session is legitimate; a session with no creds is not).
  if (merged.telegram.session && !(merged.telegram.apiId && merged.telegram.apiHash)) {
    throw new ConfigError("a Telegram session is set but API ID/HASH are missing after merging stored config (§4.10).");
  }
  return merged;
}

/** Minimal shape of the stored record (avoids a configStore import cycle). */
interface StoredConfigLike {
  record: {
    apiId: number | null;
    apiHash: string | null;
    sessions: string[];
    channels: number[];
    options: { allowDownloads: boolean; monthlyBytesBudget: number };
  };
}
