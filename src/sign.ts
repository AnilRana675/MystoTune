/**
 * Signed media URLs — §4.3 (4th endpoint), §4.8.
 * Token = base64url(payload).base64url(HMAC-SHA256(payload, MEDIA_SIGNING_KEY))
 * payload = { id, exp }. Verified with constant-time compare; expiry enforced.
 * Failure returns 403 and never reveals which check failed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

const ID_PATTERN = /^tg_n?\d+_\d+$/;

export interface MediaToken {
  id: string;
  exp: number;
}

export function createMediaToken(id: string, key: Buffer, ttlSeconds: number, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + Math.floor(ttlSeconds);
  const payload = b64url(Buffer.from(JSON.stringify({ id, exp }), "utf8"));
  const sig = b64url(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Returns the parsed token or null. Caller maps null -> 403. */
export function verifyMediaToken(token: string | undefined, key: Buffer, nowMs: number = Date.now()): MediaToken | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null; // exactly one dot
  const [payload, sig] = [token.slice(0, dot), token.slice(dot + 1)];
  if (!payload || !sig) return null;
  let payloadBytes: Buffer;
  try {
    payloadBytes = Buffer.from(payload, "base64url");
  } catch {
    return null;
  }
  if (payloadBytes.length === 0 || payloadBytes.length > 512) return null;

  // constant-time signature check over the exact payload bytes
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  // A forged/truncated signature must never reach timingSafeEqual with a
  // length-padded buffer (pre-M7.6 bug: equal exemplars let it pass).
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { id, exp, k } = parsed as { id?: unknown; exp?: unknown; k?: unknown };
  // FR-12 (M4): kind-tagged tokens are single-purpose — an art token is never
  // a media token (they are both HMAC tokens over the same key).
  if (k !== undefined) return null;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (exp <= nowSec) return null; // expired
  return { id, exp };
}

/* ------------------------------------------------------------------ FR-12 art */

export interface ArtToken {
  id: string;
  exp: number;
}

/** Art tokens carry k:"art" so the same key cannot cross endpoints. */
export function createArtToken(id: string, key: Buffer, ttlSeconds: number, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + Math.floor(ttlSeconds);
  const payload = b64url(Buffer.from(JSON.stringify({ id, exp, k: "art" }), "utf8"));
  const sig = b64url(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Returns the parsed token or null. Caller maps null -> 403. */
export function verifyArtToken(token: string | undefined, key: Buffer, nowMs: number = Date.now()): ArtToken | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const [payload, sig] = [token.slice(0, dot), token.slice(dot + 1)];
  if (!payload || !sig) return null;
  let payloadBytes: Buffer;
  try {
    payloadBytes = Buffer.from(payload, "base64url");
  } catch {
    return null;
  }
  if (payloadBytes.length === 0 || payloadBytes.length > 512) return null;
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  // A forged/truncated signature must never reach timingSafeEqual with a
  // length-padded buffer (pre-M7.6 bug: equal exemplars let it pass).
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(expected, given)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { id, exp, k } = parsed as { id?: unknown; exp?: unknown; k?: unknown };
  if (k !== "art") return null; // art tokens only
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (exp <= nowSec) return null;
  return { id, exp };
}

/** Build an ETag of the mandated shape: "{docId}-{size}" (§4.14). */
export function etagFor(docId: number, size: number): string {
  return `"${docId}-${size}"`;
}
