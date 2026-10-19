/**
 * Fastify entry — protocol routes (§4.2, §4.3): /{secret}/manifest.json,
 * /{secret}/search, /{secret}/stream/{id}, plus the signed media proxy
 * /media/{token} (no secret prefix per §4.8) and /healthz (§4.12).
 *
 * M0 wiring: fixture-source tracks stream from local files; telegram-source
 * rows resolve via TelegramManager (503 until the GramJS iterator lands in
 * M2), manifest/search/healthz work with Telegram down or unconfigured (FR-18).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";

import { RATE_LIMITS, loadConfig, type AppConfig } from "./config";
import { countTracks, createSchema, getTrack, openDb, searchTracks, type TrackRow } from "./db";
import {
  AdmissionCancelledError,
  AdmissionTimeoutError,
  Admissions,
  localFileSource,
  parseRange,
  type ByteSource,
} from "./media";
import { createMediaToken, etagFor, verifyMediaToken } from "./sign";
import { TelegramManager, TelegramSourceError } from "./telegram";
import { audioDescriptor, audioQuality, formatOf, parseTrackId, qualityLabel } from "./indexer";
import { IndexIndexer, restoreSnapshotIfEmpty } from "./index-loop";
import { openRedisStore, type RedisStore } from "./redis";

const RANGE_PROBE_LIMIT = 4096; // HEAD and <=4 KiB range probes are free (FR-19)

/* ----------------------------------------------------------------- metrics */

export interface Metrics {
  since: number;
  searches: number;
  streamResolves: number;
  stream404: number;
  mediaStreams: number;
  admissionTimeout503: number;
  bytesOut: number;
  rateLimited: number;
  floodWaits: number;
  telegram503: number;
}

export function createMetrics(): Metrics {
  return {
    since: Date.now(),
    searches: 0,
    streamResolves: 0,
    stream404: 0,
    mediaStreams: 0,
    admissionTimeout503: 0,
    bytesOut: 0,
    rateLimited: 0,
    floodWaits: 0,
    telegram503: 0,
  };
}

/* ------------------------------------------------------------ rate limiting */

interface RateWindow {
  resetAt: number;
  count: number;
}

export interface RateLimitOutcome {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * Redis-backed limiters (§4.11) answer asynchronously; the in-process one is
 * sync — callers `await` the result either way.
 */
export interface RateLimiter {
  take(key: string, limit: number, now: number): RateLimitOutcome | Promise<RateLimitOutcome>;
}

export function createRateLimiter(): RateLimiter {
  const windows = new Map<string, RateWindow>();
  return {
    take(key, limit, now) {
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { resetAt: now + RATE_LIMITS.windowMs, count: 0 };
        windows.set(key, w);
      }
      if (w.count >= limit) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
      }
      w.count += 1;
      if (windows.size > 10_000) {
        for (const [k, win] of windows) if (win.resetAt <= now) windows.delete(k);
      }
      return { ok: true, retryAfterSec: 0 };
    },
  };
}

/* ------------------------------------------------------------------ server */

export interface BuildOptions {
  config: AppConfig;
  db: ReturnType<typeof openDb>;
  telegram: TelegramManager;
  indexer?: IndexIndexer;
  metrics?: Metrics;
  rateLimiter?: RateLimiter;
  /** Optional Redis layer (§4.11) — search cache + health cache sizes. */
  redis?: RedisStore | null;
  logLevel?: AppConfig["logLevel"];
}

function constantTimeEqual(a: string, b: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  const ha = hash(a);
  const hb = hash(b);
  return timingSafeEqual(ha, hb);
}

export function buildServer(opts: BuildOptions): FastifyInstance {
  const { config: cfg, db } = opts;
  const telegram = opts.telegram;
  const indexer = opts.indexer ?? null;
  const metrics = opts.metrics ?? createMetrics();
  const redisStore = opts.redis ?? null;
  // §4.11: with a Redis store, its take() (INCR/EXPIRE + local fallback) IS the
  // limiter; otherwise the in-process windows. Tests may inject their own.
  const limiter = opts.rateLimiter ?? (redisStore as RateLimiter | null) ?? createRateLimiter();
  const admissions = new Admissions(cfg.maxConcurrentStreams, cfg.admissionWaitMs);

  const app = Fastify({
    logger: { level: opts.logLevel ?? cfg.logLevel },
    trustProxy: true,
    disableRequestLogging: true, // FSTDEP023 deprecation is fine for node5-era; M3 moves to logController
    exposeHeadRoutes: false,
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 512 }, // signed media tokens exceed the 100-char default
  });

  /* structured access log with the secret and signed tokens redacted (§4.8) */
  const redactPath = (raw: string | undefined | null): string => {
    if (!raw) return "-";
    let p = raw;
    const sIdx = p.indexOf(`/${cfg.addonSecret}`);
    if (sIdx >= 0) p = p.slice(0, sIdx + 1) + "<secret>" + p.slice(sIdx + cfg.addonSecret.length + 1);
    return p.replace(/\/media\/([^.]+)\.?([^./]*)/, "/media/<token>");
  };
  let reqSeq = 0;
  app.addHook("onRequest", async (req) => {
    (req as unknown as { _rcSeq?: number })._rcSeq = ++reqSeq;
    const log = app.log as unknown as { isLevelEnabled(level: string): boolean };
    if (log.isLevelEnabled("info")) {
      app.log.info(
        { reqId: reqSeq, req: { method: req.method, url: redactPath(req.raw.url), remote: req.ip } },
        "req",
      );
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    const log = app.log as unknown as { isLevelEnabled(level: string): boolean };
    if (log.isLevelEnabled("info")) {
      app.log.info(
        {
          reqId: (req as unknown as { _rcSeq?: number })._rcSeq ?? 0,
          res: { statusCode: reply.statusCode },
          ms: Math.round(reply.elapsedTime),
        },
        "res",
      );
    }
  });

  /* JSON responses are no-store (§4.3) */
  app.addHook("onSend", async (_req, reply, payload) => {
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.includes("application/json")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  /* generic 404, no information leak (§4.4) */
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({});
  });

  /* status-code contract (§4.4) */
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AdmissionTimeoutError) {
      return reply.code(503).header("retry-after", String(err.retryAfterSeconds)).send({});
    }
    if (err instanceof AdmissionCancelledError) {
      return reply.code(408).send({});
    }
    if (err instanceof TelegramSourceError) {
      if (err.kind === "flood") {
        metrics.floodWaits += 1;
        return reply.code(429).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
      }
      if (err.kind === "fatal") return reply.code(404).send({});
      if (err.kind === "not_found") return reply.code(404).send({}); // deleted message (§4.3)
      metrics.telegram503 += 1;
      return reply.code(503).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
    }
    if ((err as { code?: string })?.code === "FST_ERR_REQ_ABORTED") {
      return reply.code(408).send({});
    }
    app.log.error({ err: (err as Error)?.message }, "handler error");
    return reply.code(500).send({});
  });

  const secretOk = (candidate: unknown): boolean =>
    typeof candidate === "string" && constantTimeEqual(candidate, cfg.addonSecret);

  const jsonify = (reply: FastifyReply, body: unknown, code = 200): FastifyReply =>
    reply.code(code).type("application/json").send(body);

  /* ------------------------------------------------------------- manifest */

  app.get("/:secret/manifest.json", (req, reply) => {
    if (!secretOk((req.params as { secret?: string }).secret)) return reply.code(404).send({});
    return jsonify(reply, {
      id: cfg.addonId,
      name: cfg.addonName,
      version: cfg.addonVersion,
      description: cfg.addonDescription,
      resources: ["search", "stream"],
      allowDownloads: cfg.allowDownloads ? 1 : 0,
      checkValidLossless: cfg.checkValidLossless ? 1 : 0,
    });
  });

  /* -------------------------------------------------------------- search */

  app.get("/:secret/search", async (req, reply) => {
    if (!secretOk((req.params as { secret?: string }).secret)) return reply.code(404).send({});
    const guard = await limiter.take(`search:${req.ip}`, RATE_LIMITS.searchPerMinute, Date.now());
    if (!guard.ok) {
      metrics.rateLimited += 1;
      return reply.code(429).header("retry-after", String(guard.retryAfterSec)).send({});
    }
    const query = (req.query ?? {}) as { q?: string; quality?: string; atmos?: string };
    void query.quality; // §4.5: single-rendition store; never 404 on a tier miss
    void query.atmos; // FR-10: accept & ignore (stereo)
    const q = (query.q ?? "").slice(0, 300);
    metrics.searches += 1;

    // §4.11: q:{hash} cache (10 min TTL, capped 500) — hydrated by track id so
    // deleted rows simply drop out until the next miss refreshes the cache.
    let rows: TrackRow[] | null = null;
    if (redisStore) {
      const hash = redisStore.queryHash(q);
      const ids = await redisStore.getQueryIds(hash);
      if (ids) {
        rows = ids
          .map((id) => getTrack(db, id))
          .filter((r): r is TrackRow => r !== null)
          .slice(0, 25);
      } else {
        const found = searchTracks(db, q);
        redisStore.putQueryIds(hash, found.map((r) => r.id));
        rows = found;
      }
    } else {
      rows = searchTracks(db, q);
    }
    return jsonify(reply, { tracks: rows.map(toProtocolTrack) });
  });

  /* --------------------------------------------------------------- stream */

  app.get("/:secret/stream/:id", async (req, reply) => {
    if (!secretOk((req.params as { secret?: string }).secret)) return reply.code(404).send({});
    const guard = await limiter.take(`stream:${req.ip}`, RATE_LIMITS.streamPerMinute, Date.now());
    if (!guard.ok) {
      metrics.rateLimited += 1;
      return reply.code(429).header("retry-after", String(guard.retryAfterSec)).send({});
    }
    const id = ((req.params as { id?: string }).id ?? "").slice(0, 128);
    const parsed = parseTrackId(id);
    const row = parsed ? getTrack(db, id) : null;
    if (!row) {
      metrics.stream404 += 1;
      return reply.code(404).send({}); // true miss, empty body (§4.4)
    }
    metrics.streamResolves += 1;

    // Fixtures are local; telegram rows resolve through the connector first —
    // unreachable/404/429 surface here via TelegramSourceError (§4.4).
    if (row.source === "fixture") {
      if (!row.filePath) {
        metrics.stream404 += 1;
        return reply.code(404).send({});
      }
    } else {
      await telegram.resolveDocument(row);
    }

    const token = createMediaToken(row.id, cfg.mediaSigningKey, cfg.mediaUrlTtlSeconds);
    const d = audioDescriptor(row.mime, row.fileName, row.size, row.duration);
    return jsonify(reply, {
      url: `${cfg.publicBaseUrl}/media/${token}`,
      format: formatOf(d, row.fileName, row.mime) ?? undefined,
      quality: qualityLabel(d),
      codec: d.codec ?? undefined,
      container: d.container ?? undefined,
      manifest: "none",
      encrypted: false,
    });
  });

  /* -------------------------------------------------------- /media/:token */

  const withMedia = async (req: FastifyRequest, reply: FastifyReply, method: "GET" | "HEAD") => {
    const token = (req.params as { token?: string }).token ?? "";
    const hit = verifyMediaToken(token, cfg.mediaSigningKey);
    if (!hit) return reply.code(403).send({}); // never disclose which check failed (§4.3)

    const row = getTrack(db, hit.id);
    if (!row || row.size === null) return reply.code(404).send({});
    let size = row.size;
    let etag = etagFor(row.docId, size);
    const contentType = row.mime ?? "application/octet-stream";
    const isHead = method === "HEAD";

    /* Build the byte source BEFORE Range parsing: for telegram inputs the live
     * document may override size/ETag from the index snapshot (HEAD stays on
     * the snapshot — no connector calls are made for HEAD). */
    let source: ByteSource | null = null;
    if (row.source === "fixture") {
      if (!row.filePath) return reply.code(404).send({});
      if (!isHead) source = localFileSource(row.filePath);
    } else {
      const live = await telegram.resolveDocument(row); // 404/503/429 per §4.4 (pre-hijack)
      if (live && (live.size !== size || live.docId !== row.docId)) {
        size = live.size;
        etag = etagFor(live.docId, size);
      }
      if (!isHead) source = telegram.docSource(row); // M2 byte bridge (§4.7)
    }

    const range = parseRange(req.headers.range, size);
    if (range.kind === "unsatisfiable") {
      return reply
        .code(416)
        .type("application/json")
        .header("accept-ranges", "bytes")
        .header("content-range", `bytes */${size}`)
        .send({});
    }

    const slice = range.kind === "slice" ? { start: range.start!, end: range.end! } : null;
    const probe = isHead || (slice !== null && slice.end - slice.start + 1 <= RANGE_PROBE_LIMIT);

    let grant: Awaited<ReturnType<Admissions["acquire"]>> | null = null;
    let hijacked = false;

    /* Disconnect watch — registered on the real socket so it covers the
     * pre-header lead fetch and the hijacked stream alike (§4.7.5). */
    const ac = new AbortController();
    const socket = req.raw.socket ?? null;
    const onConnClose = () => ac.abort();
    const swallowSocketError = () => undefined; // reset-style storms must not crash (§4.7)
    if (socket) {
      socket.once("close", onConnClose);
      socket.once("error", swallowSocketError);
    }
    const closeOwner = { leaveClientClose: () => undefined as void };
    const clientClose = new Promise<void>((resolve) => {
      const onClosed = () => resolve();
      closeOwner.leaveClientClose = () => {
        socket?.off("close", onClosed);
      };
      socket?.once("close", onClosed);
    });

    try {
      if (!probe) grant = await admissions.acquire(token, { probe: false });

      const ifRangeAllowed = allowsIfRange(req.headers, etag);
      const start = slice && ifRangeAllowed ? slice.start : 0;
      const end = slice && ifRangeAllowed ? slice.end : size - 1;
      const status = slice && ifRangeAllowed ? 206 : 200;

      /* §4.7: pull the FIRST chunk before committing headers so common
       * Telegram-side failures surface as real status codes (503/429/404)
       * instead of a connect-then-truncate; local files pull instantly. */
      let lead: Buffer | null = null;
      const it = source && !isHead ? source.stream(start, end, ac.signal)[Symbol.asyncIterator]() : null;
      if (it) {
        try {
          const leadNext = await it.next();
          if (ac.signal.aborted) throw new AdmissionCancelledError();
          if (leadNext.done) {
            throw new TelegramSourceError("unreachable", "byte source ended before the first chunk", 5);
          }
          lead = leadNext.value;
        } catch (e) {
          try {
            await it.return?.(undefined as never);
          } catch {
            /* closing a failed iterator must not mask the original error */
          }
          throw e;
        }
      }

      reply.hijack();
      hijacked = true;
      const raw = reply.raw;
      raw.once("error", () => undefined); // EPIPE etc. after client aborts (§4.7)

      raw.writeHead(status, {
        "accept-ranges": "bytes",
        "content-type": contentType,
        "cache-control": "private, max-age=300",
        etag,
        "content-length": String(end - start + 1),
        ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (isHead) {
        raw.end();
        return;
      }

      metrics.mediaStreams += 1;
      let chunk: Buffer | null = lead;
      try {
        for (;;) {
          if (chunk === null) {
            if (!it || ac.signal.aborted) break;
            const next = await it.next();
            if (next.done || ac.signal.aborted) break;
            chunk = next.value;
          }
          if (!raw.write(chunk)) {
            await Promise.race([once(raw, "drain"), clientClose]); // §4.7.4 backpressure
            if (ac.signal.aborted) break;
          }
          metrics.bytesOut += chunk.length; // only actively streamed bytes count
          chunk = null;
        }
      } finally {
        if (it?.return) await it.return(undefined as never);
        socket?.off("close", onConnClose);
      }
      if (!ac.signal.aborted && !raw.writableEnded) {
        raw.end();
      } else {
        raw.destroy(); // client aborted mid-file: drop the socket cleanly
      }
    } catch (err) {
      if (err instanceof AdmissionCancelledError || ac.signal.aborted) {
        if (hijacked) {
          reply.raw.destroy();
          return;
        }
        return reply.code(408).send({});
      }
      if (err instanceof AdmissionTimeoutError) {
        metrics.admissionTimeout503 += 1;
        return reply.code(503).header("retry-after", String(err.retryAfterSeconds)).send({});
      }
      if (err instanceof TelegramSourceError) {
        if (hijacked) {
          reply.raw.destroy(); // headers already sent: truncate, don't fake a status
          return;
        }
        if (err.kind === "flood") {
          metrics.floodWaits += 1;
          return reply.code(429).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
        }
        if (err.kind === "fatal") return reply.code(404).send({});
        if (err.kind === "not_found") return reply.code(404).send({}); // deleted message (§4.3)
        metrics.telegram503 += 1;
        return reply.code(503).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
      }
      // unknown failure after hijack must be answered on the raw response
      if (hijacked) {
        const raw2 = reply.raw;
        if (raw2.headersSent) {
          raw2.destroy();
          return;
        }
        raw2.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        raw2.end("{}");
        return;
      }
      throw err;
    } finally {
      if (grant) admissions.release(grant);
      if (socket) {
        socket.off("close", onConnClose);
        socket.off("error", swallowSocketError);
      }
      closeOwner?.leaveClientClose();
      void clientClose; // promise-shaped; resolves on its own
    }
  };

  app.get("/media/:token", (req, reply) => withMedia(req, reply, "GET"));
  app.head("/media/:token", (req, reply) => withMedia(req, reply, "HEAD"));

  /* -------------------------------------------------------------- healthz */

  app.get("/healthz", (_req, reply) => {
    const mem = process.memoryUsage();
    return jsonify(reply, {
      ok: telegram.state !== "fatal",
      uptimeSec: Math.round((Date.now() - metrics.since) / 1000),
      rss: kb(mem.rss),
      heapUsed: kb(mem.heapUsed),
      heapTotal: kb(mem.heapTotal),
      external: kb(mem.external),
      arrayBuffers: kb(mem.arrayBuffers),
      activeStreams: admissions.activeCount,
      queuedStreams: admissions.waitingCount,
      indexCount: countTracks(db),
      indexing: Boolean(indexer?.active),
      lastSyncAt: indexer?.lastSyncAt ?? 0,
      telegram: telegram.state,
      telegramDetail: telegram.detail,
      cache: {
        redis: redisStore ? redisStore.status() : "off",
        redisStats: redisStore ? redisStore.stats() : null,
        docEntries: telegram.resolvedDocs.size,
        queryEntries: redisStore ? redisStore.queryEntryCount() : 0,
      },
      counters: {
        searches: metrics.searches,
        streams: metrics.streamResolves,
        media: metrics.mediaStreams,
        bytes: metrics.bytesOut,
        rateLimited: metrics.rateLimited,
        floodWaits: metrics.floodWaits,
        telegram503: metrics.telegram503,
      },
    });
  });

  /* expose internals for tests/soak */
  const augmented = app as unknown as FastifyInstance & { metrics: Metrics; admissions: Admissions };
  augmented.metrics = metrics;
  augmented.admissions = admissions;
  return app;
}

function kb(n: number): number {
  return Math.round(n / 1024);
}

/**
 * If-Range must match the strong ETag (§4.14); on mismatch the player gets the
 * full representation (RFC 9110 §13.1.6).
 */
function allowsIfRange(headers: unknown, etag: string): boolean {
  const ir = (headers as Record<string, unknown> | null)?.["if-range"];
  if (typeof ir !== "string" || ir === "") return true;
  const strip = (v: string) => v.replace(/^W\//, "").replace(/"/g, "").trim();
  return strip(ir) === strip(etag);
}

/* protocol row (§4.3): required non-empty id+title; other fields only when known */
export function toProtocolTrack(r: TrackRow): Record<string, unknown> {
  const d = audioDescriptor(r.mime, r.fileName, r.size, r.duration);
  const out: Record<string, unknown> = { id: r.id, title: r.title };
  if (r.artist) out["artist"] = r.artist;
  if (r.album) out["album"] = r.album;
  if (r.duration !== null) out["duration"] = r.duration;
  const format = formatOf(d, r.fileName, r.mime);
  if (format) out["format"] = format;
  out["audioQuality"] = audioQuality(d);
  return out;
}

/* ----------------------------------------------------------------- entry */

export async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  createSchema(db);
  const redis = openRedisStore({ url: cfg.redis.url, timeoutMs: cfg.redis.timeoutMs, snapshot: cfg.redis.snapshot });
  const telegram = new TelegramManager(cfg, redis);
  const indexer = new IndexIndexer(db, telegram, cfg, undefined, redis);
  const app = buildServer({ config: cfg, db, telegram, indexer, redis });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(`BitChord addon serving on :${cfg.port} (v${cfg.addonVersion})`);

  // §4.13: connect first; a fatal session must never keep the process alive
  await telegram.start();
  if (telegram.state === "fatal") {
    app.log.error(`${telegram.detail} — run npm run session to re-provision; exiting`);
    await app.close();
    redis?.close();
    process.exit(1);
  }
  // §4.11 ephemeral-disk hosts (REDIS_SNAPSHOT=1): replay the Redis snapshot
  // when the disk index is empty so the boot sync only fetches newer messages.
  try {
    const restored = await restoreSnapshotIfEmpty(db, cfg, redis);
    if (restored > 0) app.log.info(`redis index snapshot restored ${restored} tracks`);
  } catch (e) {
    void e; // a down Redis must never block boot (§4.11 rule 3)
  }
  indexer.start();

  const stop = async () => {
    indexer.stop();
    await telegram.stop();
    await app.close();
    redis?.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
