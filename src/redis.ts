/**
 * Optional Redis small-cache layer (§4.11, FR-15).
 *
 * Only used when REDIS_URL is set. Every command races a 200 ms timeout
 * (REDIS_TIMEOUT_MS) and every failure falls back to local state, so Redis
 * never blocks playback:
 *
 *   flood:until     epoch seconds of a shared FloodWait cooldown, TTL = wait
 *   rl:{op}:{ip}:{minute}   per-IP per-operation rate-limit counter, TTL 60 s
 *   msg:{id}        resolved-doc metadata (size/MIME/DC — WITHOUT the file
 *                   reference, which stays out of SQLite AND Redis, §4.14)
 *   q:{hash}        track ids for a recent search, TTL 10 min, capped at 500
 *   index:snapshot  gzip-compressed index snapshot (REDIS_SNAPSHOT=1), no TTL
 *
 * Rules enforced here: one connection, command timeout, in-process fallback,
 * cursors never stored here, session/signing key/audio never stored here.
 */
import IoRedis from "ioredis";
import { createHash } from "node:crypto";

const QUERY_TTL_SEC = 600; // q:{hash} — 10 minutes (§4.11)
const QUERY_CAP = 500; // hard cap so the cache cannot grow unbounded (§4.11)
const DOC_TTL_SEC = 1800; // msg:{id} — 30 minutes (§4.11)
const RATE_TTL_SEC = 60; // rl:{..} — 60 s bucket (§4.11)
const SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024; // free-tier safe guard
const FLOOD_KEY = "flood:until";
const SNAPSHOT_KEY = "index:snapshot";
/**
 * Boot-time reads (snapshot + config store) can race the Redis handshake on
 * slow/free plans; a too-tight REDIS_TIMEOUT_MS then silently wins boot and
 * the service re-crawls Telegram forever. These reads get a generous floor:
 * they run once per boot, so latency here never matters on the hot path.
 */
const BOOT_READ_MS = 2_500;
/** §4.15 Render profile: monthly streamed-bytes counter (UTC month TTL). */
const BYTES_MONTH_KEY = "bytes:month";
/** M6 config store (doc 7.4): encrypted configuration blob. No TTL — this is
 * durable state, unlike every other key in this module. */
const CONFIG_STORE_KEY = "cfg:v1";

/** Seconds until the end of the current UTC month (min 60 so a month-end
 * write still lands briefly). The counter self-resets at the month roll. */
function monthEndTtlSec(now = new Date()): number {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(60, Math.ceil((end - now.getTime()) / 1000));
}

/** Minimal doc metadata cache payload (§4.4 table: ~200 B; no fileReference). */
export interface ResolvedDocMeta {
  docId: number;
  size: number;
  mime: string | null;
  fileName: string | null;
  docLongId: string;
  accessHash: string;
  dcId: number | null;
}

export interface RedisStats {
  cmds: number;
  timeouts: number;
  errors: number;
  queryEntries: number;
}

export type RedisStatus = "up" | "down";

export interface RedisStore {
  /** Health surface (§4.12): redis string + cache sizes in /healthz. */
  status(): "off" | RedisStatus;
  stats(): RedisStats;

  /* rate limiting — mirrors RateLimiter.take(key, limit, now) with `key` =
   * "{op}:{ip}" so buckets stay rl:{op}:{ip}:{minute} (§4.11 naming). */
  take(key: string, limit: number, nowMs: number): Promise<{ ok: boolean; retryAfterSec: number }>;

  /** Shared FloodWait cooldown (§4.11): master set with TTL = wait. */
  writeFloodUntil(untilSec: number, waitSec: number): void;
  /** Reads the shared cooldown; 0 on any failure/time-out (non-blocking). */
  readFloodUntil(): Promise<number>;

  /* resolved doc metadata — no fileReference ever (§4.14) */
  getDocMeta(id: string): Promise<ResolvedDocMeta | null>;
  putDocMeta(id: string, meta: ResolvedDocMeta): void;

  /* search-result cache (§4.11): track ids, TTL 10 min, cap 500 */
  getQueryIds(hash: string): Promise<string[] | null>;
  putQueryIds(hash: string, ids: string[]): void;
  queryEntryCount(): number;

  /* q-hash helper for callers */
  queryHash(q: string): string;

  /* index snapshot (§4.11, ephemeral-disk hosts, REDIS_SNAPSHOT=1) */
  readSnapshot(): Promise<Buffer | null>;
  writeSnapshot(bytes: Buffer): void;

  /* monthly egress budget (§4.15): streamed bytes this UTC month */
  addBytesMonth(n: number): void;
  /** Reads the counter; 0 on any failure/time-out (never blocks streaming). */
  readBytesMonth(): Promise<number>;

  /* M6 config store (doc 7.4): encrypted config blob, cfg:v1, no TTL */
  /** Reads the blob; null on miss, failure, or time-out (caller falls back). */
  readConfigBlob(): Promise<string | null>;
  /** Fire-safe write of the blob; failures are swallowed (verify happens in
   * configStore.save() via read-back). */
  writeConfigBlob(blob: string): void;

  /* M6 session lease (doc 7.11): NX acquire + Lua compare-and-extend/-delete */
  /** SET key value PX ttl NX — true only when the key was fresh acquired. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** EVAL a Lua script (Appendix A renew/release); 0 on miss, -1 on failure. */
  evalLua(script: string, keys: string[], args: string[]): Promise<number>;

  close(): void;
}

class CmdTimeoutError extends Error {
  code = "REDIS_CMD_TIMEOUT";
}

/** Race every command against the configured timeout (FR-15: 200 ms). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CmdTimeoutError(`redis command timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function queryHashFor(q: string): string {
  return createHash("sha256").update(q).digest("hex").slice(0, 24);
}

function isMeta(v: unknown): v is ResolvedDocMeta {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["docId"] === "number" &&
    typeof m["size"] === "number" &&
    typeof m["docLongId"] === "string" &&
    m["docLongId"].length > 0 &&
    typeof m["accessHash"] === "string"
  );
}

/** In-process fallback limiter used whenever Redis is down or slow (§4.11.3). */
class LocalRateLimiter {
  private windows = new Map<string, { resetAt: number; count: number }>();
  /** A fresh ms-level sliding window, shared only as the failure fallback. */
  take(key: string, limit: number, now: number): { ok: boolean; retryAfterSec: number } {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { resetAt: now + 60_000, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
    w.count += 1;
    if (this.windows.size > 10_000) {
      for (const [k, win] of this.windows) if (win.resetAt <= now) this.windows.delete(k);
    }
    return { ok: true, retryAfterSec: 0 };
  }
}

export interface RedisOpenOptions {
  /** raw REDIS_URL value (redis://… or rediss://…) */
  url: string;
  /** per-command timeout in ms (FR-15: 200 ms) */
  timeoutMs: number;
  /** §4.11: index:snapshot winding (ephemeral-disk hosts) */
  snapshot: boolean;
}

/** The configured Redis store, or null when REDIS_URL is unset. */
export function openRedisStore(opts: RedisOpenOptions): RedisStore | null {
  if (!opts.url) return null;
  const timeoutMs = Math.max(10, opts.timeoutMs);

  const client = new IoRedis(opts.url, {
    connectTimeout: Math.min(Math.max(timeoutMs * 6, 2000), 5000),
    enableOfflineQueue: false, // commands during disconnect reject instantly → fallback
    maxRetriesPerRequest: 0,
    lazyConnect: true, // do not block boot on a slow Redis
    retryStrategy: (times: number) => Math.min(times * 1000, 5000), // quiet auto-reconnect
  });
  client.on("error", () => undefined); // driver noise stays silent; stats show it (§4.11)
  void client.connect().catch(() => undefined);

  const stats: { cmds: number; timeouts: number; errors: number } = { cmds: 0, timeouts: 0, errors: 0 };
  /** every round-trip is counted so /healthz `cmds` is honest (was a dead 0) */
  const tick = <T>(p: Promise<T>, ms: number): Promise<T> => {
    stats.cmds += 1;
    return withTimeout(p, ms);
  };
  const local = new LocalRateLimiter();

  /* q:{hash} cap registry: FIFO eviction, 500 entries max (§4.11 rule 2) */
  const queryLive = new Set<string>();
  const queryOrder: string[] = [];
  let queryEntries = 0;

  const keyFor = (op: string, ip: string, nowMs: number): string =>
    `rl:${op}:${ip}:${Math.floor(nowMs / 60_000)}`;

  const store: RedisStore = {
    status() {
      return client.status === "ready" ? "up" : "down";
    },
    stats() {
      return { ...stats, queryEntries };
    },

    async take(key, limit, nowMs) {
      const sep = key.indexOf(":");
      const op = sep > 0 ? key.slice(0, sep) : key;
      const ip = sep > 0 ? key.slice(sep + 1) : "";
      const minute = Math.floor(nowMs / 60_000);
      const k = keyFor(op, ip, nowMs);
      try {
        // one round-trip: INCR + EXPIRE together so the bucket always has a TTL
        const pipe = client.pipeline();
        pipe.incr(k).expire(k, RATE_TTL_SEC);
        const replies = await tick(pipe.exec(), timeoutMs);
        if (!replies) throw new CmdTimeoutError("redis pipeline returned no replies");
        const count = replies[0]?.[1];
        if (typeof count !== "number") throw new CmdTimeoutError("redis INCR returned a non-number");
        if (count > limit) {
          return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((minute + 1) * 60_000 - nowMs) / 1000)) };
        }
        return { ok: true, retryAfterSec: 0 };
      } catch (e) {
        if ((e as { code?: string })?.code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        return local.take(key, limit, nowMs); // §4.11 rule 3: fall back to local counters
      }
    },

    writeFloodUntil(untilSec, waitSec) {
      if (waitSec <= 0) return;
      void tick(client.set(FLOOD_KEY, String(untilSec), "EX", Math.ceil(waitSec)), timeoutMs).catch(
        () => undefined,
      );
    },

    async readFloodUntil() {
      try {
        const v = await tick(client.get(FLOOD_KEY), timeoutMs);
        if (!v) return 0;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      } catch (e) {
        if ((e as { code?: string })?.code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        return 0; // §4.11 rule 3: no Redis → local flood state keeps working
      }
    },

    addBytesMonth(n) {
      if (!Number.isFinite(n) || n <= 0) return;
      void tick(
        (async () => {
          const pipe = client.pipeline();
          pipe.incrby(BYTES_MONTH_KEY, Math.floor(n)).expire(BYTES_MONTH_KEY, monthEndTtlSec());
          await pipe.exec();
        })(),
        timeoutMs,
      ).catch(() => undefined); // accounting only — never blocks playback (FR-15)
    },

    async readBytesMonth() {
      try {
        const v = await tick(client.get(BYTES_MONTH_KEY), timeoutMs);
        const n = Number(v ?? 0);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      } catch (e) {
        if ((e as { code?: string })?.code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        return 0;
      }
    },

    async readConfigBlob() {
      try {
        // boot-time read: shelter it from a tight user-tuned timeout
        const v = await tick(client.get(CONFIG_STORE_KEY), Math.max(timeoutMs, BOOT_READ_MS));
        return v || null;
      } catch (e) {
        if ((e as { code?: string })?.code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        console.warn(
          `redis: config store read failed (${(e as { code?: string; message?: string }).message ?? "error"}) — booting env-only`,
        );
        return null; // caller falls back to the durable file store
      }
    },

    writeConfigBlob(blob) {
      if (typeof blob !== "string" || blob.length === 0) return;
      void tick(client.set(CONFIG_STORE_KEY, blob), Math.max(timeoutMs, BOOT_READ_MS)).catch(
        () => undefined,
      );
    },

    /** M6 lease acquire (doc 7.11): SET NX PX — true only when freshly held. */
    async setIfAbsent(key, value, ttlMs) {
      try {
        const res = await tick(client.set(key, value, "PX", Math.floor(ttlMs), "NX"), timeoutMs);
        return res === "OK";
      } catch (e) {
        if ((e as { code?: string })?.code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        return false; // never act as if the lease was taken on a failed probe
      }
    },

    /** M6 lease renew/release (doc 7.11 + Appendix A). 0 on miss, -1 on error. */
    async evalLua(script, keys, args) {
      try {
        const v = await tick(client.eval(script, keys.length, ...keys, ...args), timeoutMs);
        const n = Number(v ?? 0);
        return Number.isFinite(n) ? n : 0;
      } catch (e) {
        if ((e as { code?: string })?.code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        return -1; // "unknown" — the caller's miss-streak logic self-fences
      }
    },

    async getDocMeta(id) {
      try {
        const v = await tick(client.get(`msg:${id}`), timeoutMs);
        if (!v) return null;
        const parsed: unknown = JSON.parse(v);
        return isMeta(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    putDocMeta(id, meta) {
      const payload = JSON.stringify({
        docId: meta.docId,
        size: meta.size,
        mime: meta.mime,
        fileName: meta.fileName,
        docLongId: meta.docLongId,
        accessHash: meta.accessHash,
        dcId: meta.dcId,
      });
      void tick(client.set(`msg:${id}`, payload, "EX", DOC_TTL_SEC), timeoutMs).catch(() => undefined);
    },

    queryHash(q) {
      return queryHashFor(q);
    },

    async getQueryIds(hash) {
      try {
        const v = await tick(client.get(`q:${hash}`), timeoutMs);
        if (!v) return null;
        const parsed: unknown = JSON.parse(v);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((x): x is string => typeof x === "string").slice(0, 25);
      } catch {
        return null;
      }
    },

    putQueryIds(hash, ids) {
      const payload = JSON.stringify(ids.slice(0, 25));
      void tick(client.set(`q:${hash}`, payload, "EX", QUERY_TTL_SEC), timeoutMs)
        .then(() => {
          if (!queryLive.has(hash)) {
            queryLive.add(hash);
            queryOrder.push(hash);
            queryEntries = Math.min(queryLive.size, QUERY_CAP);
            while (queryOrder.length > QUERY_CAP) {
              const evict = queryOrder.shift();
              if (evict && queryLive.delete(evict)) {
                void client.del(`q:${evict}`).catch(() => undefined);
              }
              queryEntries = queryLive.size;
            }
          }
        })
        .catch(() => undefined);
    },

    queryEntryCount() {
      return queryEntries;
    },

    async readSnapshot() {
      try {
        // boot-time read: the floor also covers the handshake race on cold connections
        const v = await tick(client.getBuffer(SNAPSHOT_KEY), Math.max(timeoutMs, BOOT_READ_MS));
        return v && v.length > 0 ? v : null;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "REDIS_CMD_TIMEOUT") stats.timeouts += 1;
        else stats.errors += 1;
        console.warn(
          `redis: index snapshot read failed (${(e as { message?: string }).message ?? "error"}) — an empty disk will re-crawl`,
        );
        return null;
      }
    },

    writeSnapshot(bytes) {
      if (!(opts.snapshot && bytes.length > 0)) return;
      if (bytes.length > SNAPSHOT_MAX_BYTES) {
        // §4.11: the snapshot is optional; never let it crowd the 30 MB tier
        console.warn(`redis: snapshot too large (${Math.round(bytes.length / 1024)} KiB); skipping`);
        return;
      }
      void tick(client.set(SNAPSHOT_KEY, bytes), Math.max(timeoutMs, 10_000)).catch(() => undefined);
    },

    close() {
      void client.quit().catch(() => undefined);
      client.disconnect(); // also clears pending reconnect timers immediately
    },
  };
  return store;
}
