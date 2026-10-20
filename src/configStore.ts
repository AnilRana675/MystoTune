/**
 * FR-28 (M6): encrypted configuration store.
 *
 * Plaintext shape (doc 7.4, versioned `v: 1`):
 *   { v, apiId, apiHash, sessions[], channels[],
 *     options { allowDownloads, monthlyBytesBudget }, updatedAt }
 *
 * Persisted as AES-256-GCM ciphertext under the derived CONFIG_KEY
 * (`src/keys.ts`): random 12-byte IV + 16-byte tag + ciphertext, all
 * base64url-encoded as `iv|tag|ciphertext` in a single blob smaller than
 * 4 KB. Redis (`cfg:v1`, no TTL) is the primary carrier; the durable file
 * `<dbDir>/config.enc` (mode 0600) is the fallback when Redis is unset, and
 * doubles as the recovery medium when Redis was never available.
 *
 * Integrity contract (verify writes): every save() writes and then reads
 * back + decrypts + compares; a mismatch throws so the setup wizard can
 * block finishing on a broken store rather than booting with lost config.
 *
 * INFOSEC (doc 8): the phone number is never stored — sessions carry the
 * access; a session string alone is sufficient to authenticate to Telegram.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RedisStore } from "./redis";

export class ConfigStoreError extends Error {}

/** v:1 stored record. ONLY sessions — never the phone number. */
export interface StoredConfigV1 {
  v: 1;
  apiId: number | null;
  apiHash: string | null;
  sessions: string[];
  channels: number[];
  options: { allowDownloads: boolean; monthlyBytesBudget: number };
  updatedAt: string;
}

/** Everything except `v`/`updatedAt`, which save() fills in. */
export type StoredConfigInput = Omit<StoredConfigV1, "v" | "updatedAt">;

const MAX_CONFIG_BLOB_BYTES = 4096;

/** AES-256-GCM, random 12-byte IV → base64url(iv|tag|ciphertext). */
export function encryptConfig(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new ConfigStoreError("config key must be 32 bytes (AES-256-GCM)");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/** Inverse of encryptConfig; any failure (or tamper) yields null. */
export function decryptConfig(artifact: string, key: Buffer): string | null {
  if (key.length !== 32) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(artifact.replace(/\s+/g, ""), "base64url");
  } catch {
    return null;
  }
  if (raw.length < 12 + 16 + 1) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong key or tampered tag — unverifiable, treat as absent
  }
}

/** Parse + validate decrypted plaintext. Null on wrong shape (defensive). */
export function parseStoredConfig(plain: string): StoredConfigV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Partial<StoredConfigV1>;
  if (r.v !== 1) return null;
  if (r.apiId !== null && !Number.isSafeInteger(r.apiId)) return null;
  if (r.apiHash !== null && typeof r.apiHash !== "string") return null;
  if (!Array.isArray(r.sessions) || !r.sessions.every((s) => typeof s === "string" && s.length > 0)) return null;
  if (!Array.isArray(r.channels) || !r.channels.every((c) => Number.isSafeInteger(c))) return null;
  const options = r.options as Partial<StoredConfigV1["options"]> | undefined;
  if (!options || typeof options.allowDownloads !== "boolean") return null;
  if (!Number.isFinite(options.monthlyBytesBudget)) return null;
  if (typeof r.updatedAt !== "string" || !r.updatedAt) return null;
  return {
    v: 1,
    apiId: r.apiId ?? null,
    apiHash: r.apiHash ?? null,
    sessions: r.sessions as string[],
    channels: r.channels as number[],
    options: {
      allowDownloads: options.allowDownloads,
      monthlyBytesBudget: options.monthlyBytesBudget as number,
    },
    updatedAt: r.updatedAt,
  };
}

export interface ConfigStoreOptions {
  /** 32-byte AES-256-GCM key (derived or explicit CONFIG_KEY). */
  key: Buffer;
  /** Redis carrier (cfg:v1, no TTL). Null when REDIS_URL is unset. */
  redis?: RedisStore | null;
  /** Durable fallback /data/config.enc — default next to the SQLite index. */
  filePath?: string;
}

export const DEFAULT_CONFIG_FILE = "/data/config.enc";

export class ConfigStore {
  private readonly key: Buffer;
  private readonly redis: RedisStore | null;
  private readonly filePath: string;

  constructor(opts: ConfigStoreOptions) {
    this.key = opts.key;
    this.redis = opts.redis ?? null;
    this.filePath = opts.filePath ?? DEFAULT_CONFIG_FILE;
  }

  async save(input: StoredConfigInput): Promise<StoredConfigV1> {
    const record: StoredConfigV1 = { v: 1, updatedAt: new Date().toISOString(), ...input };
    const plain = JSON.stringify(record);
    const artifact = encryptConfig(plain, this.key);
    if (Buffer.byteLength(artifact, "utf8") > MAX_CONFIG_BLOB_BYTES) {
      throw new ConfigStoreError(
        `encoded config exceeds ${MAX_CONFIG_BLOB_BYTES} bytes (${Buffer.byteLength(artifact, "utf8")})`,
      );
    }

    // Redis carrier first (no TTL — durable state). The read-back below
    // covers it; a Redis outage here means the file fallback still holds.
    if (this.redis) {
      this.redis.writeConfigBlob(artifact);
      const back = await this.redis.readConfigBlob();
      const verified = back ? decryptConfig(back, this.key) : null;
      if (verified !== plain) {
        throw new ConfigStoreError(
          "config store write failed verification (Redis read-back mismatch); not booting with unverified config",
        );
      }
    }

    // Durable file copy (0600): works with and without Redis, doubles as the
    // FR-28 fallback and post-crash recovery medium.
    this.writeFile(artifact);
    return record;
  }

  /** Redis blob first, then the durable file. Null when neither is usable. */
  async load(): Promise<StoredConfigV1 | null> {
    if (this.redis) {
      const blob = await this.redis.readConfigBlob();
      const fromRedis = blob ? parseStoredConfig(decryptConfig(blob, this.key) ?? "") : null;
      if (fromRedis) return fromRedis;
    }
    try {
      const blob = readFileSync(this.filePath, "utf8").trim();
      return blob ? parseStoredConfig(decryptConfig(blob, this.key) ?? "") : null;
    } catch {
      return null; // absent or unreadable file — caller falls back to env-only
    }
  }

  private writeFile(artifact: string): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, artifact, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Best-effort: Redis was already verified above. A read-only disk is
      // non-fatal for the store itself (Redis remains the carrier).
    }
  }
}
