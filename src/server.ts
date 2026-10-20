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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";

import { RATE_LIMITS, applyStoredConfig, loadConfig, type AppConfig } from "./config";
import type { StoredConfigV1 } from "./configStore";
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
import { renderSetupPage, SetupAccess, SetupError, SetupManager, type LoginFactory, type SetupChannel, type SetupDeps, type SetupLogin } from "./setup";
import bigInt from "big-integer"; // gramJS BigInteger for the setup login adapter

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
  /** M6.2: mutable runtime the SETUP finish flow swaps into. Keep passing the
   * same object so route handlers see swapped telegram/indexer/config. */
  runtime?: BuildRuntime;
  /** M6.2 wizard deps (main()/tests wire persistence + leased bring-up). */
  setup?: SetupDeps | null;
}

/** Mutable runtime cell behind the routes (M6.2 finish swap). */
export interface BuildRuntime {
  cfg: AppConfig;
  telegram: TelegramManager;
  indexer: IndexIndexer | null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  const ha = hash(a);
  const hb = hash(b);
  return timingSafeEqual(ha, hb);
}

export function buildServer(opts: BuildOptions): FastifyInstance {
  const { config: cfg, db } = opts;
  // M6.2: routes read through the runtime cell so the wizard's finish flow can
  // swap in a fresh TelegramManager/IndexIndexer once the config is persisted.
  const runtime: BuildRuntime = opts.runtime ?? { cfg, telegram: opts.telegram, indexer: opts.indexer ?? null };
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
    if (err instanceof SetupError) { // M6.2 wizard errors (doc 7.6 body shape)
      if (err.retryAfterSec) reply.header("retry-after", String(err.retryAfterSec));
      return reply
        .code(err.httpStatus)
        .send({ ok: false, code: err.code, message: err.message, next: err.next, remaining: 0 });
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
      if (runtime.telegram.state === "connecting" && !(await runtime.telegram.waitForReady(10_000))) {
        return reply.code(503).header("retry-after", "5").send({});
      }
      await runtime.telegram.resolveDocument(row);
      // FR-13 (M4): fire-and-forget deep probe — fills album/duration, detects
      // ALAC; never blocks or fails the stream response (§4.13).
      void enrichRow(db, runtime.telegram, row);
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
      if (runtime.telegram.state === "connecting" && !(await runtime.telegram.waitForReady(10_000))) {
        return reply.code(503).header("retry-after", "5").send({});
      }
      const live = await runtime.telegram.resolveDocument(row); // 404/503/429 per §4.4 (pre-hijack)
      if (live && (live.size !== size || live.docId !== row.docId)) {
        size = live.size;
        etag = etagFor(live.docId, size);
      }
      if (!isHead) source = runtime.telegram.docSource(row); // M2 byte bridge (§4.7)
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
      src = await runtime.telegram.artSource(row);
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
      ok: runtime.telegram.state !== "fatal",
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
      indexing: Boolean(runtime.indexer?.active),
      lastSyncAt: runtime.indexer?.lastSyncAt ?? 0,
      telegram: runtime.telegram.state,
      telegramDetail: runtime.telegram.detail,
      cache: {
        redis: redisStore ? redisStore.status() : "off",
        redisStats: redisStore ? redisStore.stats() : null,
        docEntries: runtime.telegram.resolvedDocs.size,
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

  /* ----------------------------------------------------- M6.2 setup wizard */

  // Doc 7.5: the wizard only exists while the addon is in SETUP mode; after
  // finishing (or SETUP_ENABLED=off) every /setup/* route answers 404.
  const setupAccess = opts.setup ? new SetupAccess(30 * 60_000, cfg.publicBaseUrl.startsWith("https://")) : null;
  const setupMgr = opts.setup ? new SetupManager(opts.setup) : null;
  const setupOpen = (): boolean =>
    Boolean(setupMgr && setupAccess && !setupMgr.closed && modeBox.mode === "setup" && cfg.setupEnabled !== "off");

  /** CSRF + Origin guard for everything under /setup/api (§8). */
  const setupOpenCheck = (req: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
    if (!secretOk((req.params as { secret?: string }).secret) || !setupOpen()) return reply.code(404).send({});
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "") {
      try {
        if (new URL(origin).host !== new URL(cfg.publicBaseUrl).host) {
          return jsonify(reply, { ok: false, code: "forbidden" }, 403);
        }
      } catch {
        return jsonify(reply, { ok: false, code: "forbidden" }, 403);
      }
    }
    return null;
  };

  /** Session-bearing guard: everything that needs an unlocked wizard. */
  const setupGate = (req: FastifyRequest, reply: FastifyReply): FastifyReply | null => {
    const deny = setupOpenCheck(req, reply);
    if (deny) return deny;
    if (!setupAccess!.authorized(req)) return jsonify(reply, { ok: false, code: "forbidden" }, 403);
    return null;
  };

  const secretOnly = (req: FastifyRequest, reply: FastifyReply): FastifyReply | null =>
    secretOk((req.params as { secret?: string }).secret) ? null : reply.code(404).send({});

  app.get("/:secret/setup", (req, reply) => {
    // the page is served BEFORE any session exists — unlock happens client-side
    const deny = setupOpenCheck(req, reply);
    if (deny) return deny;
    const nonce = randomBytes(16).toString("base64url");
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header(
        "content-security-policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
      )
      .send(renderSetupPage(nonce));
  });

  // Doc 7.5: the 144-bit boot token (from URL fragment) → 30-min cookie.
  app.post("/:secret/setup/api/unlock", (req, reply) => {
    const deny = setupOpenCheck(req, reply); // unlock must work with no session yet
    if (deny) return deny;
    const res = setupAccess!.attemptUnlock(req.ip, (req.body as { token?: unknown } | undefined)?.token);
    if (res.ok) {
      reply.header("set-cookie", setupAccess!.cookieHeader(res));
      return jsonify(reply, { ok: true, csrf: res.csrf, maxAgeSec: res.maxAgeSec });
    }
    if (res.retryAfterSec > 0) reply.header("retry-after", String(res.retryAfterSec));
    const message =
      res.code === "invalid"
        ? "Wrong setup token — use the link from the deploy log"
        : res.code === "locked"
          ? "Too many wrong attempts — try again later"
          : "Too many unlock attempts — try again later";
    return jsonify(
      reply,
      { ok: false, code: res.code, message, remaining: "remaining" in res ? res.remaining : 0 },
      res.code === "invalid" ? 400 : 429,
    );
  });

  app.post("/:secret/setup/api/creds", (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    const body = (req.body ?? {}) as { apiId?: unknown; apiHash?: unknown };
    setupMgr!.saveCreds(body);
    return jsonify(reply, { ok: true });
  });

  app.post("/:secret/setup/api/login/phone", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    await setupMgr!.requestLoginCode((req.body as { phone?: unknown } | undefined)?.phone);
    return jsonify(reply, { ok: true });
  });

  app.post("/:secret/setup/api/login/code", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    await setupMgr!.submitCode((req.body as { code?: unknown } | undefined)?.code);
    return jsonify(reply, { ok: true });
  });

  app.post("/:secret/setup/api/login/password", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    await setupMgr!.submitPassword((req.body as { password?: unknown } | undefined)?.password);
    return jsonify(reply, { ok: true });
  });

  app.get("/:secret/setup/api/channels", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    return jsonify(reply, await setupMgr!.listChannels());
  });

  app.post("/:secret/setup/api/channels/count", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    return jsonify(reply, await setupMgr!.audioCount((req.body as { id?: unknown } | undefined)?.id));
  });

  app.post("/:secret/setup/api/options", (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    setupMgr!.saveOptions((req.body ?? {}) as Parameters<SetupManager["saveOptions"]>[0]);
    return jsonify(reply, { ok: true });
  });

  app.post("/:secret/setup/api/verify", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    return jsonify(reply, await setupMgr!.verify());
  });

  app.post("/:secret/setup/api/finish", async (req, reply) => {
    const deny = setupGate(req, reply);
    if (deny) return deny;
    const out = await setupMgr!.finish();
    return jsonify(reply, { ok: true, ...out });
  });

  // Session backup (doc §7.4): the deploy-log token reveals the finished
  // session string once, guarding against a free Redis plan losing the
  // config. Token arrives in the x-setup-token header — the #t fragment
  // never travels server-side, so the page rebuilds it from the link it
  // opened. No CSRF: a cross-origin caller cannot know the 144-bit token.
  app.get("/:secret/setup/api/session", (req, reply) => {
    if (!secretOk((req.params as { secret?: string }).secret) || !setupMgr || !setupAccess) {
      return reply.code(404).send({});
    }
    if (!setupMgr.closed) return reply.code(404).send({});
    if (!setupAccess.tokenOk((req.headers["x-setup-token"] as unknown) ?? null)) {
      return jsonify(reply, { ok: false, code: "forbidden", message: "Use the link from the deploy logs — it carries the token" }, 403);
    }
    return jsonify(reply, { ok: true, ...setupMgr.revealBackup() });
  });

  // Minimal status page (FR-33 starter; full json lands in M6.4). Stays up
  // after the wizard closes so the owner can confirm the addon went live.
  app.get("/:secret/status", (req, reply) => {
    const deny = secretOnly(req, reply);
    if (deny) return deny;
    return jsonify(reply, setupMgr ? setupMgr.getStatus() : { closed: true, reason: "not built" });
  });

  /* expose internals for tests/soak */
  const augmented = app as unknown as FastifyInstance & {
    metrics: Metrics;
    admissions: Admissions;
    setup?: { access: SetupAccess; manager: SetupManager };
  };
  augmented.metrics = metrics;
  augmented.admissions = admissions;
  if (setupAccess && setupMgr) augmented.setup = { access: setupAccess, manager: setupMgr };
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

/**
 * M6.2 (doc 7.6): the real Telegram login adapter behind the SetupLogin seam.
 * One client with an empty StringSession; client.start()'s callbacks are the
 * SetupManager's resolver valves. Session export only after a completed
 * login. Kept small deliberately — the live check happens on Render (M6.3).
 */
async function makeGramJSLoginFactory(): Promise<LoginFactory> {
  const mod = await import("telegram");
  const ApiNs = mod.Api;
  const StringSession = mod.sessions.StringSession;
  const { Logger, LogLevel } = (await import("telegram/extensions/Logger.js")) as unknown as {
    Logger: { new (level?: string): never };
    LogLevel: { ERROR: string };
  };
  const log = new Logger(LogLevel.ERROR);
  const userOf = (u: unknown): { id: number; name: string } => {
    const user = (u ?? {}) as { id?: { toString(): string }; firstName?: string; lastName?: string; username?: string };
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || String(user.username ?? "telegram user");
    return { id: Number(user.id?.toString() ?? 0), name };
  };
  return (creds: { apiId: number; apiHash: string }): SetupLogin => {
    const client = new mod.TelegramClient(
      new StringSession(""),
      creds.apiId,
      creds.apiHash,
      { connectionRetries: 3, retryDelay: 2000, autoReconnect: false, floodSleepThreshold: 0, baseLogger: log },
    );
    client.setLogLevel("error" as unknown as Parameters<typeof client.setLogLevel>[0]);
    const peers = new Map<number, { channelId: string; accessHash: string }>();
    const peerOf = (id: number): { channelId: string; accessHash: string } | null => peers.get(id) ?? null;
    return {
      start: (cb) =>
        client
          .start({
            phoneNumber: cb.phone,
            phoneCode: cb.code,
            password: cb.password,
            onError: () => undefined, // gramJS requires the hook; errors surface via the pending callback promises
          })
          // gramJS 2.26.22 resolves start() as undefined on every path
          // (client/auth.js L41-53: the already-authorized branch returns
          // bare, and the post-flow result is never propagated). start
          // resolving IS the "authorized" signal — getMe() is valid there.
          .then(() => client.getMe())
          .then(userOf),
      whoAmI: async () => userOf(await client.getMe()),
      dialogs: async () => {
        const list = await client.getDialogs({ limit: 200 });
        const out: SetupChannel[] = [];
        for (const d of list) {
          const e = d.entity as { className?: string; id?: { toString(): string }; title?: string; broadcast?: boolean; megagroup?: boolean; accessHash?: { toString(): string } };
          if (e.className === "Channel" && (e.broadcast || e.megagroup)) {
            const key = Number(`-100${e.id?.toString() ?? 0}`);
            out.push({ id: key, title: String(e.title ?? "channel") });
            peers.set(key, { channelId: String(e.id?.toString() ?? ""), accessHash: String(e.accessHash?.toString() ?? "") });
          }
        }
        return out;
      },
      audioCount: async (id: number) => {
        const peer = peerOf(id);
        if (!peer) return { count: 0, total: 0 };
        const found = (await client.invoke(
          new ApiNs.messages.Search({
            peer: new ApiNs.InputPeerChannel({ channelId: bigInt(peer.channelId), accessHash: bigInt(peer.accessHash) }),
            filter: new ApiNs.InputMessagesFilterMusic(),
            limit: 1,
            hash: bigInt(0),
          }),
        )) as unknown as { count?: unknown; className?: string };
        const total = Number(found.count ?? 0);
        return { count: found.className === "messages_Found" || total > 0 ? total : 0, total };
      },
      channelReadable: async (id: number) => {
        const peer = peerOf(id);
        if (!peer) return false;
        const msgs = await client.getMessages(
          new ApiNs.InputPeerChannel({ channelId: bigInt(peer.channelId), accessHash: bigInt(peer.accessHash) }),
          { limit: 1 },
        );
        return Array.isArray(msgs) && msgs.length > 0;
      },
      exportSession: () => (client.session as unknown as { save(): string }).save(),
      close: async () => {
        try {
          await client.disconnect();
        } catch {
          void 0;
        }
      },
    };
  };
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
  // M6.2: routes read through this cell; the wizard's finish swaps Telegram
  // and the indexer after the config store saves a verified record.
  const runtime: BuildRuntime = { cfg, telegram, indexer };

  // Re-read the mode cell through a call so TS narrowing can't assume it is
  // stable across awaits (the lease loop, bringUp and drain mutate it).
  const modeIs = (m: AddonMode): boolean => modeBox.mode === m;

  /** SETUP finish (doc 7.9): swap runtime, SETUP -> STANDBY -> ACTIVE. */
  const bringUp = async (record: StoredConfigV1): Promise<{ ok: boolean; message?: string }> => {
    const cfg2 = applyStoredConfig(runtime.cfg, record);
    await telegram.stop().catch(() => undefined); // the SETUP-mode placeholder manager
    const t2 = new TelegramManager(cfg2, redis);
    runtime.telegram = t2;
    runtime.cfg = cfg2;
    runtime.indexer = new IndexIndexer(db, t2, cfg2, undefined, redis);
    modeBox.mode = "standby"; // doc 7.9.2
    try {
      await restoreSnapshotIfEmpty(db, cfg2, redis); // doc 7.9.3 snapshot first
    } catch {
      void 0; // a down Redis must never block finishing
    }
    if (redis) {
      lease = new SessionLease({
        redis,
        lease: cfg2.lease,
        instanceId: deriveInstanceId(process.env),
        slot: 0,
        onFenced: () => {
          modeBox.mode = "standby";
          runtime.indexer?.stop();
          void t2.stop();
        },
      });
      const leaseCb = lease;
      const deadline = Date.now() + 60_000;
      let held = false;
      while (Date.now() < deadline) {
        if (await leaseCb.tryAcquire()) {
          held = true;
          break;
        }
        await delayMs(cfg2.lease.pollMs);
        if (!modeIs("standby")) return { ok: false, message: "the service drained while waiting for the lease" };
      }
      if (!held) return { ok: false, message: "another instance holds the session lease" };
    }
    await goActive();
    return { ok: modeIs("active") };
  };

  /** SETUP wizard deps: verified write inline, ACTIVE transitions via main. */
  const setupDeps: SetupDeps | undefined = modeBox.mode === "setup"
    ? {
        cfg,
        configStore,
        redis,
        loginFactory: await makeGramJSLoginFactory(),
        bringUp,
        leaseProbe: async () => {
          if (!redis) return { held: true, detail: "no Redis — M5 single-instance fallback" };
          const leaseCb = lease; // TS18047: snapshot into a local
          if (leaseCb?.isHeld) return { held: true, detail: "lease held by this instance" };
          if (leaseCb) {
            const got = await leaseCb.tryAcquire().catch(() => false);
            return {
              held: got || leaseCb.isHeld,
              detail: leaseCb.isHeld ? "lease held by this instance" : got ? "lease acquired by this instance" : "another instance may hold the lease — verify again after it drains",
            };
          }
          return { held: true, detail: "no lease yet — an unconfigured boot holds nothing" };
        },
      }
    : undefined;

  const app = buildServer({ config: cfg, db, telegram, indexer, redis, modeBox, runtime, setup: setupDeps });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  app.log.info(`BitChord addon serving on :${cfg.port} (v${cfg.addonVersion})`);

  // M6.2 (doc §5 row 3): the setup link lives in the LOGS ONLY — token in the
  // URL fragment so browsers never transmit it (no access-log leakage).
  if (setupDeps) {
    const acc = (app as unknown as { setup?: { access?: SetupAccess } }).setup?.access;
    if (acc) {
      app.log.warn(`[setup] open ${cfg.publicBaseUrl}/${cfg.addonSecret}/setup#t=${acc.token}`);
    }
  }

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
  /** STANDBY → ACTIVE: connect Telegram (overlap-retry), then start indexing.   * Reads runtime.* — the M6.2 finish flow replaces the manager before the
   * first goActive() under SETUP boot. */
  const goActive = async (): Promise<void> => {
    if (modeIs("draining")) return;
    const bootState = await bootTelegram(runtime.telegram, runtime.cfg, app.log);
    if (modeIs("draining")) return; // SIGTERM raced the connect
    if (bootState === "fatal" || runtime.telegram.state === "fatal") {
      modeBox.mode = "failed";
      app.log.error(`${runtime.telegram.detail} — run npm run session to re-provision; exiting`);
      await app.close();
      redis?.close();
      process.exit(1);
    }
    runtime.indexer?.start();
    modeBox.mode = "active";
    app.log.info("lease held — addon is active");
  };

  const drainingSetup = async (): Promise<void> => {
    const s = (app as unknown as { setup?: { manager?: { close(): Promise<void> } } }).setup?.manager;
    if (s) await s.close().catch(() => undefined); // §8: wizard state discarded on drain
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
        runtime.indexer?.stop();
        void runtime.telegram.stop();
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
    runtime.indexer?.stop();
    const deadline = Date.now() + cfg.lease.drainMs;
    const activeStreams = () => {
      const a = (app as unknown as { admissions?: { activeCount: number } }).admissions;
      return a?.activeCount ?? 0;
    };
    while (activeStreams() > 0 && Date.now() < deadline) await delayMs(100);
    await drainingSetup();
    await runtime.telegram.stop();
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
