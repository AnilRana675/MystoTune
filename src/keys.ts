/**
 * FR-29 (M6): derived operational secrets.
 *
 * APP_SEED (base64, 32 bytes) is the only secret a Blueprint-generated deploy
 * needs; every key the app uses is pulled from it with HKDF-SHA256
 * (salt `mystotune/v1`, doc 7.3):
 *
 *   addonSecret    derive("addon-path", 24)      -> base64url, 32 chars
 *   mediaSigningKey derive("media-signing", 32)  -> HMAC key for signed media URLs
 *   configKey      derive("config-store", 32)    -> AES-256-GCM key for the store
 *
 * Rotating APP_SEED changes the addon URL (BitChord must re-add the source),
 * invalidates every signed media token, and makes a stored config unreadable
 * — which simply re-opens setup (FR-28 note).
 *
 * Explicit env vars (`ADDON_SECRET`, `MEDIA_SIGNING_KEY`, `CONFIG_KEY`) always
 * win over derivation (section 7.3 resolution order).
 */
import { hkdfSync, timingSafeEqual } from "node:crypto";

export class KeyDerivationError extends Error {}

export interface DerivedSecrets {
  /** 24 bytes as base64url — exactly 32 URL-safe chars for the route prefix. */
  addonSecret: string;
  /** 32 bytes — HMAC key for signed media URLs. */
  mediaSigningKey: Buffer;
  /** 32 bytes — AES-256-GCM key for the encrypted config store. */
  configKey: Buffer;
}

export const HKDF_SALT = "mystotune/v1";
const HKDF_HASH = "sha256";

/** Decode a base64/base64url APP_SEED and insist on exactly 32 bytes. */
export function decodeAppSeed(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new KeyDerivationError(
      "APP_SEED is empty. Set it to `openssl rand -base64 32` output (or let Render generate it).",
    );
  }
  const seed = Buffer.from(trimmed, "base64");
  if (seed.length !== 32) {
    throw new KeyDerivationError(
      `APP_SEED must decode to exactly 32 bytes (got ${seed.length}); generate with \`openssl rand -base64 32\`.`,
    );
  }
  return seed;
}

/** The three operational secrets from one APP_SEED (doc 7.3, exact scheme). */
export function deriveSecrets(appSeed: string | Buffer): DerivedSecrets {
  const seed = typeof appSeed === "string" ? decodeAppSeed(appSeed) : appSeed;
  const derive = (info: string, length: number): Buffer =>
    Buffer.from(hkdfSync(HKDF_HASH, seed, HKDF_SALT, info, length));
  return {
    addonSecret: derive("addon-path", 24).toString("base64url"),
    mediaSigningKey: derive("media-signing", 32),
    configKey: derive("config-store", 32),
  };
}

/** base64url alphabet + 32-character length (INFOSEC: no `+`, `/`, or `=` in a path). */
export function isUrlSafeSecret(secret: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(secret);
}

/**
 * Legacy fallback (M6.0): pre-APP_SEED .env deployments set ADDON_SECRET and
 * MEDIA_SIGNING_KEY explicitly. Derive the config-store key from those two so
 * such boots stay stable and the store stays readable across restarts without
 * introducing a new required value. Salt/infos match the APP_SEED scheme.
 */
export function deriveConfigKeyFromLegacy(addonSecret: string, mediaSigningKey: Buffer): Buffer {
  const seed = Buffer.concat([Buffer.from(addonSecret, "utf8"), mediaSigningKey]);
  return Buffer.from(hkdfSync(HKDF_HASH, seed, HKDF_SALT, "config-store", 32));
}

/** Constant-time compare for explicit-vs-derived secret logging decisions. */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
