/**
 * Fastify entry — protocol routes (§4.2, §4.3): /{secret}/manifest.json,
 * /{secret}/search, /{secret}/stream/{id}, plus the signed media proxy
 * /media/{token} (no secret prefix per §4.8) and /healthz (§4.12).
 *
 * M0 wiring: fixture-source tracks stream from local files; telegram-source
 * rows resolve via TelegramManager (503 until the GramJS iterator lands in
 * M2), manifest/search/healthz work with Telegram down or unconfigured (FR-18).
 */
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";

import { RATE_LIMITS, applyStoredConfig, loadConfig, type AppConfig } from "./config";
import { ConfigStore, DEFAULT_CONFIG_FILE } from "./configStore";
import { deriveInstanceId, SessionLease } from "./lease";
import {
  countTracks,
  createSchema,
  getTrack,
  openDb,
  searchTracks,
  upsertTrack,
  type TrackRow,
  type UpsertTrack,
} from "./db";
import {
  AdmissionCancelledError,
  AdmissionTimeoutError,
  Admissions,
  MonthlyBudget,
  localFileSource,
  parseRange,
  type ByteSource,
} from "./media";
import { createArtToken, createMediaToken, etagFor, verifyArtToken, verifyMediaToken } from "./sign";
import { Lru, TelegramManager, TelegramSourceError, type ArtSource } from "./telegram";
import { audioDescriptor, audioQuality, cleanName, formatOf, parseTrackId, qualityLabel } from "./indexer";
import { probeFirstBytes } from "./probe";
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

/** M6.1 service mode (doc 7.2): setup | standby | active | draining | failed. */
export type AddonMode = "setup" | "standby" | "active" | "draining" | "failed";
/** Mutable mode cell: the lease/main loop mutates `mode`, withServer reads it. */
export interface AddonModeBox {
  mode: AddonMode;
}

export interface BuildOptions {
  config: AppConfig;
  db: ReturnType<typeof openDb>;
  telegram: TelegramManager;
  indexer?: IndexIndexer;
  metrics?: Metrics;
  rateLimiter?: RateLimiter;
  /** Original Redis layer (§4.11) — search cache + health cache sizes. */
  redis?: RedisStore | null;
  logLevel?: AppConfig["logLevel"];
  /** M6.1 state machine cell (defaults to active for boots/tests without a lease). */
  modeBox?: AddonModeBox;
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
  // §4.15 Render profile: monthly streamed-bytes budget (404 on exceed).
  const budget = new MonthlyBudget(cfg.monthlyBytesBudget, redisStore);
  // M6.1 (doc 7.2): service state-machine mode cell (setup during the wizard,
  // standby before the lease, draining on SIGTERM). Tests default to active.
  const modeBox: AddonModeBox = opts.modeBox ?? { mode: "active" };

  const app = Fastify({
    logger: { level: opts.logLevel ?? cfg.logLevel },
    trustProxy: true,
    // fastify 5.6 replacement for the deprecated top-level `disableRequestLogging`:
    // built-in request logs stay off; our own onRequest/onResponse redaction hooks keep working.
    logController: new LogController({ disableRequestLogging: true }),
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

    // M6.1 (doc 7.2): SETUP serves a valid but empty index — the wizard runs
    // while the addon is already discoverable by BitChord.
    if (modeBox.mode === "setup") {
      return jsonify(reply, { tracks: [] });
    }

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
    return jsonify(reply, { tracks: rows.map((r) => toProtocolTrack(r, artCtx(cfg))) });
  });

  /* --------------------------------------------------------------- stream */

  app.get("/:secret/stream/:id", async (req, reply) => {
    if (!secretOk((req.params as { secret?: string }).secret)) return reply.code(404).send({});
    // M6.1 (doc 7.2): STANDBY (lease not yet held) and DRAINING (SIGTERM in
    // flight) refuse new streams so the twin instance serves Telegram instead.
    if (modeBox.mode === "standby" || modeBox.mode === "draining") {
      return reply.code(503).header("retry-after", "5").send({});
    }
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

    // §4.15: monthly egress budget exceeded ⇒ plain 404 so BitChord falls
    // back to a lower tier instead of an error (Render never suspends us).
    if (await budget.exceeded()) {
      metrics.stream404 += 1;
      return reply.code(404).send({});
    }

    // Fixtures are local; telegram rows resolve through the connector first —
    // unreachable/404/429 surface here via TelegramSourceError (§4.4).
    if (row.source === "fixture") {
      if (!row.filePath) {
        metrics.stream404 += 1;
        return reply.code(404).send({});
      }
    } else {
      // §4.15 cold start: Fastify serves first; give the Telegram session up
      // to 10 s to come online before surfacing a 503/Retry-After.
      if (telegram.state === "connecting" && !(await telegram.waitForReady(10_000))) {
        return reply.code(503).header("retry-after", "5").send({});
      }
      await telegram.resolveDocument(row);
      // FR-13 (M4): fire-and-forget deep probe — fills album/duration, detects
      // ALAC; never blocks or fails the stream response (§4.13).
      void enrichRow(db, telegram, row);
    }

    const token = createMediaToken(row.id, cfg.mediaSigningKey, cfg.mediaUrlTtlSeconds);
    const d = audioDescriptor(row.mime, row.fileName, row.size, row.duration, row.codec);
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
    // M6.1 (doc 7.2): refused while STANDBY or DRAINING (see /stream).
    if (modeBox.mode === "standby" || modeBox.mode === "draining") {
      return reply.code(503).header("retry-after", "5").send({});
    }
    const token = (req.params as { token?: string }).token ?? "";
    const hit = verifyMediaToken(token, cfg.mediaSigningKey);
    if (!hit) return reply.code(403).send({}); // never disclose which check failed (§4.3)

    const row = getTrack(db, hit.id);
    if (!row || row.size === null) return reply.code(404).send({});
    // §4.15: budget exceeded ⇒ 404 (BitChord treats it as a miss and falls back).
    if (await budget.exceeded()) return reply.code(404).send({});
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
      // §4.15 cold start: media tokens may outlive a fresh deploy; only wait
      // while a connect attempt is genuinely still in flight.
      if (telegram.state === "connecting" && !(await telegram.waitForReady(10_000))) {
        return reply.code(503).header("retry-after", "5").send({});
      }
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
          budget.add(chunk.length); // §4.15 monthly egress budget
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

  /* ------------------------------------------------------------- /art/:token */

  /** FR-12 (M4): serve a Telegram audio thumbnail. Art tokens are kind-tagged
   * ("art") so they cannot be replayed against /media and vice versa; artwork is
   * immutable per document, so responses carry ETag + long private caching. */
  const withArt = async (req: FastifyRequest, reply: FastifyReply, method: "GET" | "HEAD") => {
    const token = (req.params as { token?: string }).token ?? "";
    const hit = verifyArtToken(token, cfg.mediaSigningKey);
    if (!hit) return reply.code(403).send({}); // never disclose which check failed
    const row = getTrack(db, hit.id);
    if (!row || row.source !== "telegram" || row.hasThumb !== 1) {
      return reply.code(404).send({}); // unknown id or thumbless document
    }

    let src: ArtSource | null = null;
    try {
      src = await telegram.artSource(row);
    } catch (err) {
      if (err instanceof TelegramSourceError) {
        if (err.kind === "flood") {
          metrics.floodWaits += 1;
          return reply.code(429).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
        }
        if (err.kind === "fatal" || err.kind === "not_found") return reply.code(404).send({});
        metrics.telegram503 += 1;
        return reply.code(503).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
      }
      metrics.telegram503 += 1;
      return reply.code(502).send({});
    }
    if (!src || src.size <= 0) return reply.code(404).send({});

    const cacheHeaders = {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=86400",
      etag: src.etag,
    };
    const withCacheHeaders = (r: FastifyReply): FastifyReply => {
      r.header("content-type", cacheHeaders["content-type"])
        .header("cache-control", cacheHeaders["cache-control"])
        .header("etag", cacheHeaders.etag);
      return r;
    };
    /** HEAD and 304 replies carry no payload; fastify refuses to serialize a
     * body onto a 304, so both go through the raw response directly. */
    const rawNoBody = (code: number, contentLength: string | null): FastifyReply => {
      reply.hijack();
      reply.raw.statusCode = code;
      reply.raw.setHeader("content-type", cacheHeaders["content-type"]);
      reply.raw.setHeader("cache-control", cacheHeaders["cache-control"]);
      reply.raw.setHeader("etag", cacheHeaders.etag);
      if (contentLength !== null) reply.raw.setHeader("content-length", contentLength);
      reply.raw.end();
      return reply;
    };
    if (method === "HEAD") {
      return rawNoBody(200, String(src.size));
    }
    if (ifNoneMatchHit(req.headers, src.etag)) {
      return rawNoBody(304, null);
    }

    try {
      if (src.bytes) {
        return withCacheHeaders(reply.code(200)).header("content-length", String(src.bytes.length)).send(src.bytes);
      }
      const ac = new AbortController();
      const socket = req.raw.socket ?? null;
      const onConnClose = () => ac.abort();
      const swallow = () => undefined; // client aborts mid-fetch must not crash
      if (socket) {
        socket.once("close", onConnClose);
        socket.once("error", swallow);
      }
      const parts: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of src.stream!(0, src.size - 1, ac.signal)) {
          parts.push(Buffer.from(chunk));
          total += chunk.length;
          if (total >= src.size) break;
        }
      } finally {
        if (socket) {
          socket.off("close", onConnClose);
          socket.off("error", swallow);
        }
      }
      if (total === 0) return reply.code(404).send({}); // rendition vanished
      return withCacheHeaders(reply.code(200)).header("content-length", String(total)).send(Buffer.concat(parts));
    } catch (err) {
      if (err instanceof TelegramSourceError) {
        if (err.kind === "flood") {
          metrics.floodWaits += 1;
          return reply.code(429).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
        }
        if (err.kind === "fatal" || err.kind === "not_found") return reply.code(404).send({});
        return reply.code(503).header("retry-after", String(err.retryAfterSeconds ?? 30)).send({});
      }
      return reply.code(502).send({});
    }
  };

  app.get("/art/:token", (req, reply) => withArt(req, reply, "GET"));
  app.head("/art/:token", (req, reply) => withArt(req, reply, "HEAD"));

  /* -------------------------------------------------------------- healthz */

  app.get("/healthz", (_req, reply) => {
    const mem = process.memoryUsage();
    return jsonify(reply, {
      ok: telegram.state !== "fatal",
      mode: modeBox.mode, // M6.1 (doc 7.2): setup | standby | active | draining | failed
      uptimeSec: Math.round((Date.now() - metrics.since) / 1000),
      rss: kb(mem.rss),
      heapUsed: kb(mem.heapUsed),
      heapTotal: kb(mem.heapTotal),
      external: kb(mem.external),
      arrayBuffers: kb(mem.arrayBuffers),
      activeStreams: admissions.activeCount,
      queuedStreams: admissions.waitingCount,
      budgetBytes: budget.usedLocal, // §4.15 (process-local; bytes:month is the shared truth)
      monthlyBytesBudget: cfg.monthlyBytesBudget,
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

/** Artwork context (FR-12): absolute artworkURL on rows that carry a thumb. */
export interface ArtUrlContext {
  publicBaseUrl: string;
  signingKey: Buffer;
  urlTtlSeconds: number;
  nowMs: number;
}

/* protocol row (§4.3): required non-empty id+title; other fields only when known */
export function toProtocolTrack(r: TrackRow, art?: ArtUrlContext): Record<string, unknown> {
  const d = audioDescriptor(r.mime, r.fileName, r.size, r.duration, r.codec);
  const out: Record<string, unknown> = { id: r.id, title: r.title };
  if (r.artist) out["artist"] = r.artist;
  if (r.album) out["album"] = r.album;
  if (r.duration !== null) out["duration"] = r.duration;
  const format = formatOf(d, r.fileName, r.mime);
  if (format) out["format"] = format;
  out["audioQuality"] = audioQuality(d);
  if (art && r.hasThumb === 1) {
    out["artworkURL"] = `${art.publicBaseUrl}/art/${createArtToken(r.id, art.signingKey, art.urlTtlSeconds, art.nowMs)}`;
  }
  return out;
}

/** Per-request artwork token context; urls expire with media url TTL (§4.8). */
function artCtx(cfg: AppConfig): ArtUrlContext {
  return {
    publicBaseUrl: cfg.publicBaseUrl,
    signingKey: cfg.mediaSigningKey,
    urlTtlSeconds: cfg.mediaUrlTtlSeconds,
    nowMs: Date.now(),
  };
}

/** If-None-Match hit check for /art 304s. */
function ifNoneMatchHit(headers: unknown, etag: string): boolean {
  const raw = (headers as Record<string, unknown> | null)?.["if-none-match"];
  if (typeof raw !== "string") return false;
  const strip = (v: string) => v.replace(/^W\//, "").replace(/"/g, "").trim();
  return raw.split(",").some((c) => strip(c) === strip(etag) || c.trim() === "*");
}

/* --------------------------------------------------- FR-13 deep probe (M4) */

/** One probe-scan per row per process (§4.13 flood-safety). */
const probedRows = new Lru<true>(1000, 24 * 3600_000);

/** Rows whose first 64 KB can still change something on the row (M4). */
export function probeNeeded(row: TrackRow): boolean {
  if (row.source !== "telegram" || row.mime === null) return false;
  if (row.mime === "audio/mpeg") return !row.album || !row.artist; // ID3 (c)
  if (row.mime === "audio/mp4" || row.mime === "audio/x-m4a") return row.codec !== "alac";
  if (row.mime === "audio/flac" || row.mime === "audio/x-flac") return row.duration === null;
  return false;
}

/**
 * Lazy FR-13 enrichment: a track's first stream reads its first 64 KB once and
 * upgrades the row in place — ID3 fills (album/artist only: §4.6.2 keeps
 * attributes/filename above ID3), FLAC duration from STREAMINFO, and m4a ALAC
 * detection (§4.5 truthfulness). Best-effort: exceptions are swallowed and the
 * indexed labels stay.
 */
export async function enrichRow(db: ReturnType<typeof openDb>, telegram: TelegramManager, row: TrackRow): Promise<void> {
  if (probedRows.get(row.id) || !probeNeeded(row)) return;
  probedRows.set(row.id, true); // before any await: failures never repeat scans
  const ac = new AbortController();
  try {
    const head = await telegram.firstBytes(row, 65536, ac.signal);
    const probe = head ? probeFirstBytes(head, row.mime) : null;
    if (!probe) return;
    const patch: UpsertTrack = {
      id: row.id,
      chatId: row.chatId,
      msgId: row.msgId,
      title: row.title,
      artist: row.artist,
      album: row.album,
      duration: row.duration,
      mime: row.mime,
      size: row.size,
      fileName: row.fileName,
      codec: row.codec,
      container: row.container,
      lossless: row.lossless,
      bitrateKbps: row.bitrateKbps,
      docId: row.docId,
      source: row.source,
      filePath: row.filePath,
      hasThumb: row.hasThumb,
      addedAt: row.addedAt, // enrichment must not bump the sync timestamp
    };
    if (probe.id3) {
      if (!patch.album && probe.id3.album) patch.album = (cleanName(probe.id3.album) ?? probe.id3.album.trim()) || null;
      if (!patch.artist && probe.id3.artist) patch.artist = (cleanName(probe.id3.artist) ?? probe.id3.artist.trim()) || null;
    }
    if (probe.flac && patch.duration === null && probe.flac.durationSec) patch.duration = probe.flac.durationSec;
    if (probe.mp4?.alac) {
      patch.codec = "alac";
      patch.lossless = 1;
      patch.bitrateKbps = null;
    }
    upsertTrack(db, patch);
  } catch {
    void 0; // enrichment never fails nor blocks the stream (§4.13)
  } finally {
    ac.abort();
  }
}

/* ----------------------------------------------------------------- entry */

/* ------------------------------------------------------------------ boot */

/** Small promise sleep used by the §4.15 boot-retry loop. */
const delayMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * §4.15/FR-20 deploy overlap: while a Render twin still holds the session,
 * AUTH_KEY_DUPLICATED at boot is retried (BOOT_AUTH_RETRIES × wait) before
 * declaring the session fatal. Returns when the client is up (or fatal).
 */
export async function bootTelegram(
  telegram: Pick<TelegramManager, "start" | "stop" | "state" | "detail">,
  cfg: { bootAuthRetries: number; bootAuthRetryWaitSeconds: number },
  log: { warn: (msg: string) => void },
): Promise<"ready" | "fatal" | "neutral"> {
  for (let attempts = Math.max(1, cfg.bootAuthRetries); attempts > 0; attempts -= 1) {
    await telegram.start();
    if (telegram.state !== "fatal") break;
    const overlap = telegram.detail?.includes("AUTH_KEY_DUPLICATED") ?? false;
    if (!overlap || attempts === 1) break;
    log.warn(`session overlap (${telegram.detail}); retrying boot connect in ${cfg.bootAuthRetryWaitSeconds}s`);
    await delayMs(cfg.bootAuthRetryWaitSeconds * 1000);
  }
  return telegram.state === "fatal" ? "fatal" : telegram.state === "ready" ? "ready" : "neutral";
}

export async function main(): Promise<void> {
  let cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  createSchema(db);
  const redis = openRedisStore({ url: cfg.redis.url, timeoutMs: cfg.redis.timeoutMs, snapshot: cfg.redis.snapshot });

  // M6.0 (doc 7.3): second layer of "env > store > profile". The encrypted
  // store fills only what explicit env left unset; a tampered/unreadable
  // store (e.g. rotated APP_SEED) simply falls back to env-only boot.
  const configStore = new ConfigStore({ key: cfg.configKey, redis, filePath: DEFAULT_CONFIG_FILE });
  const storedRecord = await configStore.load().catch(() => null);
  cfg = applyStoredConfig(cfg, storedRecord);

  const telegram = new TelegramManager(cfg, redis);
  const indexer = new IndexIndexer(db, telegram, cfg, undefined, redis);

  // M6.1 (doc 7.2): BOOT picks SETUP (no session configured) or STANDBY
  // (waiting for the lease). The server reads the same mutable cell, so all
  // routes reflect the mode from the first request.
  const modeBox: AddonModeBox = { mode: cfg.telegram.configured ? "standby" : "setup" };
  let lease: SessionLease | null = null; // set below when Redis + session exist
  let clearAcquire: () => void = () => {}; // stops the STANDBY poll on drain
  const app = buildServer({ config: cfg, db, telegram, indexer, redis, modeBox });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(`BitChord addon serving on :${cfg.port} (v${cfg.addonVersion})`);

  // §4.15: Fastify is already serving. Restore a Redis snapshot into an empty
  // disk index BEFORE the Telegram client connects, so the boot sync reads
  // cursors (§4.11 rule 5) and only fetches newer messages.
  try {
    const restored = await restoreSnapshotIfEmpty(db, cfg, redis);
    if (restored > 0) app.log.info(`redis index snapshot restored ${restored} tracks`);
  } catch (e) {
    void e; // a down Redis must never block boot (§4.11 rule 3)
  }

  let draining = false;
  // Re-read the mode cell through a call so TS narrowing can't assume it is
  // stable across awaits (the lease loop and the drain handler mutate it).
  const modeIs = (m: AddonMode): boolean => modeBox.mode === m;

  /** STANDBY → ACTIVE: connect Telegram (overlap-retry), then start indexing. */
  const goActive = async (): Promise<void> => {
    if (modeIs("draining")) return;
    const bootState = await bootTelegram(telegram, cfg, app.log);
    if (modeIs("draining")) return; // SIGTERM raced the connect
    if (bootState === "fatal" || telegram.state === "fatal") {
      modeBox.mode = "failed";
      app.log.error(`${telegram.detail} — run npm run session to re-provision; exiting`);
      await app.close();
      redis?.close();
      process.exit(1);
    }
    indexer.start();
    modeBox.mode = "active";
    app.log.info("lease held — addon is active");
  };

  if (modeBox.mode === "setup") {
    // M6.1 SETUP: valid manifest/empty search already served; the wizard (M6.2)
    // transitions to STANDBY/ACTIVE once finish() persists the config.
    app.log.warn("telegram session not configured — setup mode (no indexer)");
  } else if (redis && cfg.telegram.configured) {
    // M6.1 lease (doc 7.11): STANDBY polls tryAcquire; SELF-FENCE on lost lease.
    lease = new SessionLease({
      redis,
      lease: cfg.lease,
      instanceId: deriveInstanceId(process.env),
      slot: 0,
      onFenced: () => {
        app.log.warn("redis lease lost (renewal misses) — self-fencing: telegram I/O stopped, STANDBY");
        modeBox.mode = "standby";
        indexer.stop();
        void telegram.stop();
      },
    });
    let acquireTimer: NodeJS.Timeout | null = null;
    const leaseCb = lease;
    acquireTimer = setInterval(() => {
      if (draining) return;
      void leaseCb.tryAcquire().then((held) => {
        if (!held) return;
        if (acquireTimer) clearInterval(acquireTimer);
        acquireTimer = null;
        void goActive();
      });
    }, cfg.lease.pollMs);
    acquireTimer.unref();
    clearAcquire = () => {
      if (acquireTimer) clearInterval(acquireTimer);
      acquireTimer = null;
    };
  } else {
    // No Redis: M5 behaviour — no lease to arbitrate, connect immediately.
    void goActive();
  }

  // M6.1 (doc 7.11): SIGTERM = DRAINING ≤ drainMs → release → exit.
  const stop = async () => {
    if (draining) return;
    draining = true;
    modeBox.mode = "draining";
    clearAcquire();
    indexer.stop();
    const deadline = Date.now() + cfg.lease.drainMs;
    const activeStreams = () => {
      const a = (app as unknown as { admissions?: { activeCount: number } }).admissions;
      return a?.activeCount ?? 0;
    };
    while (activeStreams() > 0 && Date.now() < deadline) await delayMs(100);
    await telegram.stop();
    if (lease) await lease.release(); // compare-and-delete only our own slot
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
