/**
 * Telegram connector — §4.1, §4.7, §4.13, §4.14.
 * M1: real GramJS wiring — one TelegramClient from a StringSession, no
 * interactive login (FR-20), floodSleepThreshold 0 (§4.13), fatal-state guard
 * for AUTH_KEY_DUPLICATED / AUTH_KEY_UNREGISTERED, auto-reconnect inside 30s,
 * document LRU (§4.14) and poll/exists surfaces for the indexer loop.
 * M2: the upload.GetFile byte bridge (512 KiB windows, DC keep-warm, one
 * file-reference re-fetch).
 * M3: optional Redis layer (§4.11) — the shared flood:until cooldown is read
 * through refreshRemoteFlood() on the watchdog cadence and written through
 * on recordFloodWait(); resolved-doc metadata (never the file reference) is
 * cached under msg:{id} with a 30 min TTL.
 */
import type { AppConfig } from "./config";
import { docIdFromLong, type RawDocMessage } from "./indexer";
import type { ByteSource } from "./media";
import { WINDOW, alignDown, sliceForWindow } from "./download-window";
import { etagFor } from "./sign";
import type { RedisStore, ResolvedDocMeta } from "./redis";

import { FileMigrateError } from "telegram/errors";
import type { Api as ApiNs, TelegramClient } from "telegram";
import bigInt from "big-integer"; // GramJS BigInteger offsets/limits for upload.GetFile

export type TelegramState = "not_configured" | "connecting" | "ready" | "unreachable" | "fatal";

export class TelegramSourceError extends Error {
  kind: "unreachable" | "flood" | "fatal" | "not_found";
  retryAfterSeconds?: number;

  constructor(kind: TelegramSourceError["kind"], message: string, retryAfterSeconds?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Fatal session problems (§4.13): log once, stop retrying, healthz unhealthy, exit. */
const FATAL_PREFIX = /^(AUTH_KEY_|SESSION_|USER_DEACTIVATED)/;
const FLOOD_PREFIX = /^FLOOD_(?:WAIT|TEST_PHONE_WAIT|PREMIUM_WAIT)_\d+$/;

interface DocShape {
  id: string;
  size: number;
  mime: string | null;
  attrs: ApiNs.TypeDocumentAttribute[];
  /** download location pieces (live values, never persisted — §4.14) */
  accessHash: string;
  fileReference: Buffer;
  dcId: number | null;
  /** FR-12 thumbnails (duck-typed: PhotoSize vs PhotoStrippedSize) */
  thumbs: Array<{ kind: "photo" | "stripped"; type: string; size: number; bytes: Buffer | null }>;
}

/** Pick the artwork source for /art (FR-12): largest regular photo size, else
 * the inline stripped bytes (served with zero RPC), else null. */
function chooseThumb(thumbs: DocShape["thumbs"]): ResolvedDocThumb | null {
  let bestPhoto: { type: string; size: number } | null = null;
  let stripped: { type: string; bytes: Buffer } | null = null;
  for (const t of thumbs) {
    if (t.kind === "photo") {
      if (!bestPhoto || t.size > bestPhoto.size) bestPhoto = { type: t.type, size: t.size };
    } else if (t.bytes && t.bytes.length > 0 && !stripped) {
      stripped = { type: t.type, bytes: Buffer.from(t.bytes) };
    }
  }
  if (bestPhoto && bestPhoto.size > 0) return { type: bestPhoto.type, size: bestPhoto.size, stripped: null };
  if (stripped) return { type: stripped.type, size: stripped.bytes.length, stripped: stripped.bytes };
  return null;
}

/** Pull the underlying Document out of a friendly Api.Message. */
function docOf(m: ApiNs.Message | undefined): DocShape | null {
  if (!m) return null;
  const doc = m.document;
  if (!doc || !doc.id || !doc.size) return null;
  const thumbs: DocShape["thumbs"] = [];
  for (const t of (doc.thumbs ?? []) as unknown as Array<Record<string, unknown>>) {
    const type = typeof t["type"] === "string" ? (t["type"] as string) : "";
    const bytes = t["bytes"];
    if (bytes instanceof Uint8Array) {
      thumbs.push({ kind: "stripped", type, size: bytes.length, bytes: Buffer.from(bytes) });
    } else if (typeof t["size"] === "number") {
      thumbs.push({ kind: "photo", type, size: t["size"] as number, bytes: null });
    }
  }
  return {
    id: doc.id.toString(),
    size: doc.size.toJSNumber(),
    mime: doc.mimeType,
    attrs: doc.attributes,
    accessHash: doc.accessHash?.toString() ?? "",
    fileReference: doc.fileReference ?? Buffer.alloc(0),
    dcId: typeof doc.dcId === "number" && doc.dcId > 0 ? doc.dcId : null,
    thumbs,
  };
}

/** Small TTL LRU (§4.14: 200 entries, 10 min) for resolved documents. */
export class Lru<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  get size(): number {
    this.sweep();
    return this.map.size;
  }

  get(key: string): V | undefined {
    this.sweep();
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.sweep();
    this.map.delete(key); // refresh recency on re-set
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  private sweep(): void {
    if (this.map.size <= this.capacity) return;
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
  }
}

/** A document thumbnail (FR-12): either an inline stripped JPEG or a regular
 * photo size that streams from the DC on demand. */
export interface ResolvedDocThumb {
  /** Telegram thumb size letter ("s"|"m"|"x"|"y"|"i"|"j") */
  type: string;
  /** bytes for photo sizes; stripped inline bytes length for stripped */
  size: number;
  /** inline JPEG for PhotoStrippedSize — servable with zero RPC */
  stripped: Buffer | null;
}

export interface ResolvedDocument {
  docId: number;
  size: number;
  mime: string | null;
  fileName: string | null;
  /** real Telegram document id (long) — feeds upload.GetFile location; */
  docLongId: string;
  /** live file-reference pieces; fileReference is null ONLY for Redis msg:{id}
   * metadata hits (§4.14: never persisted) — streaming re-fetches the live ref */
  accessHash: string;
  fileReference: Buffer | null;
  dcId: number | null;
  /** FR-12: largest thumb (photo) or inline stripped bytes; null when none */
  thumb?: ResolvedDocThumb | null;
}

/** FR-12 artwork payload for GET /art: inline bytes (PhotoStrippedSize, served
 * with zero RPC) or a byte stream sourced from the document's thumbnail
 * rendition over the 512 KiB bridge. size is the authoritative length. */
export interface ArtSource {
  size: number;
  /** per-render ETag used for If-None-Match 304s */
  etag: string;
  bytes?: Buffer;
  stream?: (start: number, end: number, signal: AbortSignal) => AsyncIterable<Buffer>;
}

/** Convert to the persisted Redis form (which must exclude fileReference). */
function asRedisMeta(doc: ResolvedDocument): ResolvedDocMeta {
  if (!doc.fileReference || !doc.docLongId || !doc.accessHash) {
    throw new Error("redis meta write requires a fully resolved document");
  }
  return {
    docId: doc.docId,
    size: doc.size,
    mime: doc.mime,
    fileName: doc.fileName,
    docLongId: doc.docLongId,
    accessHash: doc.accessHash,
    dcId: doc.dcId,
  };
}

interface EntryLike {
  id: string;
  source: string;
  chatId: number;
  msgId: number;
}

type FilterKind = "music" | "document";

export class TelegramManager {
  state: TelegramState = "not_configured";
  detail: string | null = null;
  /** Local FloodWait cooldown, epoch seconds (shared copy lives in Redis §4.11). */
  floodUntilSec = 0;
  /** Remote shared cooldown floor, adopted via refreshRemoteFlood (§4.11). */
  remoteFloodUntilSec = 0;
  /** resolved docs LRU: track id -> {docId,size,mime,..} (§4.14). */
  readonly resolvedDocs = new Lru<ResolvedDocument>(200, 10 * 60_000);
  /** FR-21 (TRD v2.2 FINAL): full first 512 KiB window per track, so the
   * next-track start serves byte 0 from memory (no extra Telegram call). */
  private readonly headWindows = new Lru<Buffer>(8, 5 * 60_000);
  floodWaits = 0;

  private api: typeof ApiNs | null = null;
  private client: TelegramClient | null = null;
  private connecting: Promise<void> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchBusy = false;
  /** §4.7.6: DCs we have streamed from — touched so the exported senders
   * (warm file connections) are never dropped by GramJS' 30 s release timer. */
  private warmDcs = new Set<number>();
  private warmTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional Redis layer (§4.11) — injected by main(); tests pass none. */
  private readonly redisStore?: RedisStore | null;

  constructor(
    private readonly cfg: AppConfig,
    redisStore?: RedisStore | null,
  ) {
    this.redisStore = redisStore ?? null;
    this.state = cfg.telegram.configured ? "connecting" : "not_configured";
    if (!cfg.telegram.configured) {
      this.detail = "TELEGRAM_* not configured; only fixture-source tracks are streamable";
    }
  }

  /** Used by tests to force FR-18 behaviour without a real client. */
  forceState(state: TelegramState, detail?: string): void {
    this.state = state;
    this.detail = detail ?? this.detail;
  }

  /** True while a shared FloodWait cooldown covers the next Telegram call. */
  floodCooldownRemaining(nowSec = Math.floor(Date.now() / 1000)): number {
    const until = Math.max(this.floodUntilSec, this.remoteFloodUntilSec);
    return Math.max(0, until - nowSec);
  }

  /** Public fatal check so the indexer loop avoids TS property-narrowing traps. */
  get isFatal(): boolean {
    return this.state === "fatal";
  }

  recordFloodWait(seconds: number, nowSec = Math.floor(Date.now() / 1000)): void {
    if (seconds > this.floodCooldownRemaining(nowSec)) {
      this.floodUntilSec = nowSec + seconds;
      this.floodWaits += 1;
      // §4.11: share the new cooldown with sibling instances (fire-and-forget)
      this.redisStore?.writeFloodUntil(this.floodUntilSec, seconds);
    }
  }

  /**
   * §4.11: adopt the shared flood:until cooldown from Redis if it is longer
   * than the local one. Best-effort — a down Redis just means local-only state.
   */
  async refreshRemoteFlood(): Promise<void> {
    if (!this.redisStore) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const until = await this.redisStore.readFloodUntil();
    if (until > nowSec && until > this.remoteFloodUntilSec) {
      this.remoteFloodUntilSec = until;
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * Connect the single client. Fatal session problems set `fatal` and return
   * (§4.13: log once, stop retrying, healthz unhealthy — main() exits).
   * Network trouble stays at unreachable/connecting; the watchdog keeps the
   * reconnect cadence under 30s (§4.13).
   */
  async start(): Promise<void> {
    if (!this.cfg.telegram.configured) return;
    if (this.state === "fatal") return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectImpl();
    return this.connecting;
  }

  /**
   * §4.15 (TRD v2.2 FINAL): cold starts — Fastify already serves while GramJS
   * is still connecting, so /stream and /media wait briefly for readiness.
   * Returns immediately true when ready; false for fatal/not_configured and
   * for unreachable (callers keep their existing 503 mapping), and polls
   * (100 ms) while `connecting` until ready/fatal/timeout.
   */
  async waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.state === "ready") return true;
    // Only a boot connect in flight is worth waiting for: unreachable/fatal
    // keep the existing immediate 503 mapping, and the watchdog-led reconnect
    // path stays non-blocking (§4.13).
    if (this.state !== "connecting" || !this.connecting) return false;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      const s = String(this.state); // re-read across await (TS narrows unions)
      if (s === "ready") return true;
      if (s !== "connecting") return false;
      await delay(100);
    }
    return String(this.state) === "ready";
  }

  async stop(): Promise<void> {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.warmTimer) {
      clearInterval(this.warmTimer);
      this.warmTimer = null;
    }
    this.warmDcs.clear();
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (this.state !== "fatal") this.forceState("unreachable", "shutting down");
    try {
      await client?.disconnect();
    } catch (e) {
      void e;
    }
  }

  private async connectImpl(): Promise<void> {
    let client: TelegramClient;
    let api: typeof ApiNs;
    try {
      const mod = await import("telegram");
      const StringSession = mod.sessions.StringSession;
      api = mod.Api;
      // gramJS prints its version banner at INFO from the client constructor's
      // own logger; hand it an error-level baseLogger so the banner (and any
      // other library INFO chatter) never surfaces (§4.13 log hygiene).
      const { Logger, LogLevel } = (await import("telegram/extensions/Logger.js")) as unknown as {
        Logger: { new (level?: string): never };
        LogLevel: { ERROR: string };
      };
      const log = new Logger(LogLevel.ERROR);
      client = new mod.TelegramClient(
        new StringSession(this.cfg.telegram.session ?? ""),
        this.cfg.telegram.apiId ?? 0,
        this.cfg.telegram.apiHash ?? "",
        {
          connectionRetries: 3,
          retryDelay: 2000,
          autoReconnect: true,
          floodSleepThreshold: 0, // §4.13: never sleep; throw FLOOD_WAIT and gate
          baseLogger: log,
        },
      );
      client.setLogLevel("error" as unknown as Parameters<typeof client.setLogLevel>[0]); // §4.13: log level error
    } catch (e) {
      this.markFatal(`gramjs import failed: ${(e as Error)?.message ?? "unknown"}`);
      return;
    }
    this.api = api;
    this.client = client;

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        this.state = "connecting";
        this.detail = "connecting to telegram";
        await client.connect();
        this.markReady("connected to telegram");
        this.startWatchdog();
        return;
      } catch (e) {
        const c = this.classify(e);
        if (c.kind === "fatal") {
          this.markFatal(c.detail);
          return; // §4.13: log once, stop retrying, healthz unhealthy, exit
        }
        this.state = "unreachable";
        this.detail = c.detail;
        if (attempt === 5) {
          this.detail = `connect failed after retries: ${c.detail} (watchdog keeps trying)`;
          return;
        }
        await delay(Math.min(15_000, 1000 * 2 ** attempt)); // 2,4,8,15s
      }
    }
  }

  /** Watchdog: restores state after drops and forces a reconnect within 30s. */
  private startWatchdog(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => void this.heartbeat(), 15_000);
    this.watchTimer.unref?.();
    if (!this.warmTimer) {
      this.warmTimer = setInterval(() => void this.touchWarmDcs(), 20_000);
      this.warmTimer.unref?.();
    }
    void this.refreshRemoteFlood(); // §4.11: adopt any shared cooldown on connect
  }

  /** §4.7.6: keep file-DC senders connected (borrow resets GramJS' 30s release). */
  private async touchWarmDcs(): Promise<void> {
    if (!this.client || this.state !== "ready") return;
    for (const dc of this.warmDcs) {
      try {
        await this.client.getSender(dc);
      } catch {
        // warm-touch failures are invisible; the next borrow handles them
      }
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.watchBusy || !this.client || this.state === "fatal" || this.state === "not_configured") return;
    this.watchBusy = true;
    try {
      if (this.client.connected === true) {
        if (this.state !== "ready") this.markReady("connected to telegram (watchdog)");
        void this.refreshRemoteFlood(); // §4.11: keep the shared cooldown in view
        return;
      }
      if (this.state !== "connecting") {
        this.state = "connecting";
        this.detail = "connection lost; reconnecting";
      }
      await this.client.connect();
      this.markReady("reconnected");
    } catch (e) {
      const c = this.classify(e);
      if (c.kind === "fatal") {
        this.markFatal(c.detail);
        return;
      }
      this.state = "unreachable";
      this.detail = c.detail;
      // next tick retries (15s cadence < 30s window, §4.13)
    } finally {
      this.watchBusy = false;
    }
  }

  /* ------------------------------------------------------------ state utils */

  private markReady(detail: string): void {
    this.state = "ready";
    this.detail = detail;
  }

  private markFatal(detail: string): void {
    this.state = "fatal";
    this.detail = `telegram session fatal: ${detail}`;
  }

  /** Map any thrown value onto the §4.4 status vocabulary. */
  private classify(e: unknown): { kind: "fatal" | "flood" | "unreachable" | "not_found"; detail: string; seconds?: number } {
    const err = e as { errorMessage?: string; className?: string; message?: string; seconds?: number };
    const msg = err?.errorMessage ?? err?.className ?? err?.message ?? `unknown telegram error: ${String(e)}`;
    if (typeof msg === "string" && FLOOD_PREFIX.test(msg)) {
      const seconds = err?.seconds ?? Number(/_(\d+)$/.exec(msg)?.[1] ?? 0) ?? 30;
      return { kind: "flood", detail: msg, seconds: seconds || 30 };
    }
    if (typeof msg === "string" && FATAL_PREFIX.test(msg)) {
      return { kind: "fatal", detail: msg };
    }
    if (typeof msg === "string" && /^(MESSAGE_ID_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE|CHAT_ID_INVALID|PEER_ID_INVALID|FRESH_RESET_AUTHORISATION_FORBIDDEN)/.test(msg)) {
      return { kind: "not_found", detail: msg };
    }
    return { kind: "unreachable", detail: msg };
  }

  /* --------------------------------------------------------------- peer ops */

  /** channel/group entity for TARGET_CHANNEL_IDS entries, cached per boot. */
  private entities = new Map<number, unknown>();

  private requireConnect(): TelegramClient {
    if (!this.client) throw new TelegramSourceError("unreachable", "telegram client not started", 5);
    if (this.state === "fatal") throw new TelegramSourceError("fatal", this.detail ?? "telegram session fatal");
    const remaining = this.floodCooldownRemaining();
    if (remaining > 0) {
      throw new TelegramSourceError("flood", `FLOOD_WAIT ${remaining}`, remaining);
    }
    return this.client;
  }

  private apiNs(): typeof ApiNs {
    if (!this.api) throw new TelegramSourceError("unreachable", "telegram client not started", 5);
    return this.api;
  }

  private async entityFor(chatId: number): Promise<unknown> {
    const cached = this.entities.get(chatId);
    if (cached) return cached;
    const client = this.client!;
    for (const attempt of [Number(chatId), String(chatId)]) {
      try {
        const ent = await client.getEntity(attempt);
        if (ent) {
          this.entities.set(chatId, ent);
          return ent;
        }
      } catch (e) {
        void e;
      }
    }
    try {
      await client.getDialogs({ limit: 1000 });
      const ent = await client.getEntity(String(chatId));
      this.entities.set(chatId, ent);
      return ent;
    } catch {
      throw new TelegramSourceError(
        "unreachable",
        `peer ${chatId} not found (is the account a member? npm run channels), or network issue`,
        10,
      );
    }
  }

  /* ----------------------------------------------------------- poll surface */

  /**
   * §4.6: one chat pass = messages.search with InputMessagesFilterMusic AND
   * InputMessagesFilterDocument (post-filtered to audio), merged and deduped
   * by msgId, ascending above `minId`.
   */
  async listAudioMessages(chatId: number, minId: number, cap = 5000): Promise<RawDocMessage[]> {
    const ent = await this.entityFor(chatId).then((e) => e as never);
    const [music, docs] = await Promise.all([
      this.pollFilter(ent, "music", minId, cap, chatId),
      this.pollFilter(ent, "document", minId, cap, chatId),
    ]);
    const best = new Map<number, RawDocMessage>();
    for (const raw of [...music, ...docs]) {
      const prev = best.get(raw.msgId);
      // keep the richer record when the same msg id shows up in both filters
      if (!prev || (!prev.attrTitle && raw.attrTitle)) best.set(raw.msgId, raw);
    }
    return [...best.values()].sort((a, b) => a.msgId - b.msgId);
  }

  private async pollFilter(ent: never, kind: FilterKind, minId: number, cap: number, chatId: number): Promise<RawDocMessage[]> {
    const client = this.requireConnect();
    const api = this.apiNs();
    const out: RawDocMessage[] = [];
    try {
      const filter = kind === "music" ? new api.InputMessagesFilterMusic() : new api.InputMessagesFilterDocument();
      // reverse:true => ascending order starting just above minId
      const iter = client.iterMessages(ent, { minId, reverse: true, limit: cap, filter });
      for await (const m of iter) {
        const raw = this.toRawDocMessage(m as ApiNs.Message, chatId);
        if (raw) out.push(raw);
        if (out.length >= cap) break;
      }
    } catch (e) {
      const c = this.classify(e);
      if (c.kind === "flood") {
        this.recordFloodWait(c.seconds ?? 30);
        throw new TelegramSourceError("flood", `FLOOD_WAIT ${c.seconds ?? ""}`, c.seconds ?? 30);
      }
      throw new TelegramSourceError(c.kind === "fatal" ? "fatal" : c.kind, c.detail, c.kind === "fatal" ? undefined : 10);
    }
    return out;
  }

  private toRawDocMessage(m: ApiNs.Message, chatId: number): RawDocMessage | null {
    const shape = docOf(m);
    if (!shape) return null;
    let attrTitle: string | null = null;
    let attrPerformer: string | null = null;
    let duration: number | null = null;
    let voice = false;
    const fileName = shape.attrs.find((a): a is ApiNs.DocumentAttributeFilename => a instanceof this.api!.DocumentAttributeFilename)?.fileName ?? null;
    for (const attr of shape.attrs) {
      if (attr instanceof this.api!.DocumentAttributeAudio) {
        if (attr.voice) voice = true;
        duration = attr.duration;
        attrTitle = attr.title ?? null;
        attrPerformer = attr.performer ?? null;
        break;
      }
    }
    return {
      chatId,
      msgId: m.id,
      docId: shape.id,
      mime: shape.mime,
      size: shape.size,
      fileName: fileName ?? (m as unknown as { fileName?: string }).fileName ?? null,
      attrTitle,
      attrPerformer,
      duration,
      voice,
      caption: m.message ?? null,
      hasThumb: shape.thumbs.length > 0, // FR-12
    };
  }

  /** Bot curation (SDD §2): delete channel messages through the OWNER session.
   * Never throws — returns a typed result the bot renders into a receipt. */
  async deleteChannelMessages(
    chatId: number,
    msgIds: number[],
  ): Promise<{ deleted: number; error?: string }> {
    if (msgIds.length === 0) return { deleted: 0 };
    if (this.state !== "ready" || this.client === null) {
      return { deleted: 0, error: `telegram ${this.state}` };
    }
    try {
      const res = await this.client.deleteMessages(chatId, msgIds, { revoke: true });
      // gramJS returns one AffectedMessages per <=100-id chunk — sum pid counts,
      // not array length (gate-2: receipts must report real message counts).
      const n = Array.isArray(res)
        ? (res as Array<{ ptsCount?: number }>).reduce((s, r) => s + (r?.ptsCount ?? 0), 0)
        : 0;
      return { deleted: n };
    } catch (e) {
      const msg = (e as { errorMessage?: string; message?: string }).errorMessage
        ?? (e as Error).message ?? "error";
      return { deleted: 0, error: msg };
    }
  }

  /** reconcile helper (§4.6): do these known msg ids still exist? batched 100 max. */
  async messagesExist(chatId: number, msgIds: number[]): Promise<boolean[]> {
    const client = this.requireConnect();
    const ent = (await this.entityFor(chatId)) as never;
    const result = new Array<boolean>(msgIds.length).fill(false);
    for (let i = 0; i < msgIds.length; i += 100) {
      const batch = msgIds.slice(i, i + 100);
      try {
        const list = await client.getMessages(ent, { ids: batch });
        for (let j = 0; j < batch.length; j++) {
          const m = list[j] as ApiNs.Message | undefined;
          if (!m) continue; // hole: deleted message
          result[i + j] = Boolean(docOf(m));
        }
      } catch (e) {
        const c = this.classify(e);
        if (c.kind === "flood") {
          this.recordFloodWait(c.seconds ?? 30);
          throw new TelegramSourceError("flood", `FLOOD_WAIT ${c.seconds ?? ""}`, c.seconds ?? 30);
        }
        if (c.kind === "fatal") throw new TelegramSourceError("fatal", c.detail);
        // transient errors: keep rows (only confirmed holes are removed)
        for (let j = 0; j < batch.length; j++) result[i + j] = true;
      }
    }
    return result;
  }

  /* ----------------------------------------------------------- doc resolve */

  /**
   * M1 contract: fixture entries return null (caller uses its own source);
   * telegram entries resolve the current message (file refs expire — never
   * persisted, §4.14) and cache the immutable doc bundle in the LRU.
   */
  async resolveDocument(entry: EntryLike): Promise<ResolvedDocument | null> {
    if (entry.source === "fixture") return null;
    if (this.state === "not_configured") {
      throw new TelegramSourceError("unreachable", "telegram not configured", 30);
    }
    if (this.state === "fatal") {
      throw new TelegramSourceError("fatal", this.detail ?? "telegram session fatal");
    }
    if (this.state === "unreachable") {
      throw new TelegramSourceError("unreachable", this.detail ?? "telegram unreachable", 30);
    }
    const remaining = this.floodCooldownRemaining();
    if (remaining > 0) {
      throw new TelegramSourceError("flood", `FLOOD_WAIT ${remaining}`, remaining);
    }
    const cached = this.resolvedDocs.get(entry.id);
    if (cached) return cached;
    // §4.11: msg:{id} metadata cache (30 min) — head/descriptor paths may skip
    // Telegram completely; streaming re-fetches the live file reference later.
    if (this.redisStore) {
      const meta = await this.redisStore.getDocMeta(entry.id);
      if (meta) {
        const doc: ResolvedDocument = {
          docId: meta.docId,
          size: meta.size,
          mime: meta.mime,
          fileName: meta.fileName,
          docLongId: meta.docLongId,
          accessHash: meta.accessHash,
          fileReference: null, // never persisted — refetched on stream (§4.14)
          dcId: meta.dcId,
          thumb: null, // thumb info lives only in live docs (FR-12)
        };
        this.resolvedDocs.set(entry.id, doc);
        return doc;
      }
    }
    const doc = await this.fetchResolvedDoc(entry);
    this.resolvedDocs.set(entry.id, doc);
    return doc;
  }

  /**
   * Live document lookup (entity + getMessages), always fresh — resolveDocument
   * LRU-caches the result; the FILE_REFERENCE_EXPIRED retry path calls this
   * with the LRU bypassed so a stale cached reference never gets reused.
   */
  private async fetchResolvedDoc(entry: EntryLike): Promise<ResolvedDocument> {
    const client = this.requireConnect();
    this.apiNs(); // warm-check
    let raw: ApiNs.Message | undefined;
    try {
      const ent = (await this.entityFor(entry.chatId)) as never;
      const list = await client.getMessages(ent, { ids: [entry.msgId] });
      raw = list[0] as ApiNs.Message | undefined;
    } catch (e) {
      const c = this.classify(e);
      if (c.kind === "flood") {
        this.recordFloodWait(c.seconds ?? 30);
        throw new TelegramSourceError("flood", `FLOOD_WAIT ${c.seconds ?? ""}`, c.seconds ?? 30);
      }
      throw new TelegramSourceError(c.kind, c.detail, c.kind === "fatal" ? undefined : 10);
    }
    if (!raw) throw new TelegramSourceError("not_found", `message gone: ${entry.id}`, 0);
    const shape = docOf(raw);
    if (!shape || raw.voice) {
      throw new TelegramSourceError("not_found", `no audio document at ${entry.id}`, 0);
    }
    const fileName =
      shape.attrs.find((a): a is ApiNs.DocumentAttributeFilename => a instanceof this.api!.DocumentAttributeFilename)?.fileName ?? null;
    const doc: ResolvedDocument = {
      docId: docIdFromLong(shape.id),
      size: shape.size,
      mime: shape.mime,
      fileName,
      docLongId: shape.id,
      accessHash: shape.accessHash,
      fileReference: shape.fileReference,
      dcId: shape.dcId,
      thumb: chooseThumb(shape.thumbs), // FR-12
    };
    // §4.11 write-through: cache the metadata (WITHOUT the file reference) for
    // sibling instances / restart warm-up; failures are invisible by design.
    try {
      this.redisStore?.putDocMeta(entry.id, asRedisMeta(doc));
    } catch {
      void 0;
    }
    return doc;
  }

  /* -------------------------------------------------------- M2 byte bridge */

  /**
   * Byte source for GET /media on telegram rows (TRD §4.7 + §4.14): streams the
   * exact bytes of [start..end] by replaying 512 KiB-aligned upload.GetFile
   * windows, trims head/tail, aborts with the caller's signal, and performs the
   * mandated "re-fetch the message once and retry once" on
   * FILE_REFERENCE_EXPIRED. The opener is injectable so tests exercise the
   * window pipeline against a scripted Telegram without a live client.
   */
  docSource(entry: EntryLike): ByteSource {
    return {
      stream: (start, end, signal) => {
        const iter = this.telegramDocIter(entry, start, end, signal);
        return {
          [Symbol.asyncIterator]() {
            return iter;
          },
          destroy() {
            void iter.return?.(undefined as never); // the signal alone stops the loop
          },
        };
      },
    };
  }

  /**
   * Test seam: when set, every window goes through this opener instead of the
   * real GramJS upload.GetFile bridge. Tests script it to simulate Telegram.
   */
  windowOpener: WindowOpener | null = null;

  /* ------------------------------------------------ M4 deep probe (FR-13) */

  /**
   * First ≤max bytes of a document (FR-13 probes read the ID3 / STREAMINFO /
   * stsd headers, which all live in the opening bytes). Exactly ONE window
   * request through the same windowOpener seam as telegramDocIter, so tests
   * stay network-free. Returns null only when Telegram hands back no bytes.
   */
  async firstBytes(entry: EntryLike, max: number, signal: AbortSignal): Promise<Buffer | null> {
    let doc = this.resolvedDocs.get(entry.id) ?? null;
    if (!doc || !doc.fileReference) doc = await this.fetchResolvedDoc(entry);
    const bytes = this.windowOpener
      ? await this.windowOpener({ doc, offset: 0, limit: WINDOW, signal })
      : await this.realOpenWindow(doc, 0, WINDOW, signal);
    if (!bytes || bytes.length === 0) return null;
    return bytes.length > max ? Buffer.from(bytes.subarray(0, max)) : bytes;
  }

  /* ------------------------------------------------ M4 artwork (FR-12) */

  /**
   * Resolve the artwork payload for /art (TRD FR-12). Returns null when the
   * live document carries no thumbnail; HTTP errors surface as mapped
   * TelegramSourceError kinds (429/503/404).
   */
  async artSource(entry: EntryLike): Promise<ArtSource | null> {
    let doc = await this.resolveDocument(entry);
    if (!doc) return null;
    if (!doc.thumb && !doc.fileReference) {
      // Redis msg:{id} metadata hits carry no thumb info (§4.14): fetch the
      // live document once before declaring a genuine 404.
      doc = await this.fetchResolvedDoc(entry);
      this.resolvedDocs.set(entry.id, doc);
    }
    const thumb = doc.thumb;
    if (!thumb) return null;
    const etag = etagFor(doc.docId, thumb.size);
    if (thumb.stripped) return { size: thumb.size, etag, bytes: thumb.stripped };
    return { size: thumb.size, etag, stream: this.artThumbStream(doc, thumb) };
  }

  /** Thumb renditions are ≤512 KiB by Telegram design: [start..end] resolves
   * from a single window fetched with the rendition's thumbSize selected. */
  private artThumbStream(
    doc: ResolvedDocument,
    thumb: ResolvedDocThumb,
  ): (start: number, end: number, signal: AbortSignal) => AsyncIterable<Buffer> {
    return (start, end, signal) => {
      const iter = this.artThumbIter(doc, thumb, start, end, signal);
      return {
        [Symbol.asyncIterator]() {
          return iter;
        },
        destroy() {
          void iter.return?.(undefined as never);
        },
      };
    };
  }

  private async *artThumbIter(
    doc: ResolvedDocument,
    thumb: ResolvedDocThumb,
    start: number,
    end: number,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer, void, undefined> {
    if (end < start || start >= thumb.size) return;
    const bytes = this.windowOpener
      ? await this.windowOpener({ doc, offset: 0, limit: WINDOW, signal, thumbSize: thumb.type })
      : await this.realOpenWindow(doc, 0, WINDOW, signal, thumb.type);
    const avail = bytes ? Math.min(bytes.length, thumb.size) : 0;
    const from = Math.min(start, avail);
    const to = Math.min(end, avail - 1);
    if (to >= from) yield bytes.subarray(from, to + 1);
  }

  async *telegramDocIter(
    entry: EntryLike,
    start: number,
    end: number,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer, void, undefined> {
    let pos = alignDown(start); // §4.7.3: first request aligns DOWN to a 512 KiB boundary
    let doc: ResolvedDocument | null = this.resolvedDocs.get(entry.id) ?? null;
    let refetched = false; // §4.14: re-fetch the message once and retry once
    while (pos <= end && !signal.aborted) {
      // FR-21: byte-0 requests are served from the head-window cache when the
      // full opening window is already resident — no Telegram call at all.
      if (start === 0 && pos === 0) {
        const cached = this.headWindows.get(entry.id);
        if (cached && cached.length >= WINDOW) {
          const out = sliceForWindow(cached, 0, start, end);
          if (out.length) yield out;
          pos += cached.length;
          continue;
        }
      }
      // A Redis-sourced metadata entry carries no file reference: replace it
      // with the fully-resolved live doc before opening windows (§4.14).
      if (!doc || !doc.fileReference) doc = await this.fetchResolvedDoc(entry);
      let bytes: Buffer;
      try {
        bytes = this.windowOpener
          ? await this.windowOpener({ doc, offset: pos, limit: WINDOW, signal })
          : await this.realOpenWindow(doc, pos, WINDOW, signal);
      } catch (e) {
        if (looksLikeFileRefExpired(e)) {
          if (refetched) {
            throw new TelegramSourceError("unreachable", "file reference expired again after re-fetch", 10);
          }
          refetched = true;
          doc = await this.fetchResolvedDoc(entry); // fresh file reference (§4.14)
          this.resolvedDocs.set(entry.id, doc);
          continue; // retry the SAME window exactly once
        }
        throw e; // already a TelegramSourceError (flood/unreachable/not_found/fatal)
      }
      if (!bytes || bytes.length === 0) break; // EOS
      if (start === 0 && pos === 0 && bytes.length >= WINDOW) {
        // Keep the opening window warm for the next-track first byte (FR-21);
        // only FULL windows are cached so truncation fixtures stay exact.
        this.headWindows.set(entry.id, bytes);
      }
      const out = sliceForWindow(bytes, pos, start, end);
      if (out.length) yield out;
      if (bytes.length < WINDOW && pos + bytes.length <= end) {
        // A mid-file short window means Telegram closed the transfer early:
        // a truncated stream is worse than a failed one for Range clients.
        throw new TelegramSourceError("unreachable", "telegram truncated the document mid-stream", 5);
      }
      pos += bytes.length;
    }
  }

  /** Real window fetch: borrowed DC sender + Api.upload.GetFile (§4.7.3/4.7.6).
   * thumbSize (FR-12) selects a thumbnail rendition instead of the document. */
  private async realOpenWindow(
    doc: ResolvedDocument,
    offset: number,
    limit: number,
    signal: AbortSignal,
    thumbSize?: string,
  ): Promise<Buffer> {
    // Abort between requests: a settled call is at most one 512 KiB window.
    if (signal.aborted) throw abortErrorOf(signal);
    const client = this.requireConnect();
    const api = this.apiNs();
    if (!doc.accessHash || !doc.docLongId) {
      throw new TelegramSourceError("not_found", "document location unavailable", 0);
    }
    if (!doc.fileReference) {
      // unreachable by contract (telegramDocIter prefetches the live ref)
      throw new TelegramSourceError("unreachable", "document file reference unavailable", 60);
    }
    const location = new api.InputDocumentFileLocation({
      id: bigInt(doc.docLongId),
      accessHash: bigInt(doc.accessHash),
      fileReference: doc.fileReference,
      thumbSize: thumbSize ?? "",
    });
    let sender = await client.getSender(doc.dcId ?? 0); // §4.7.6: warm DC pool
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await client.invokeWithSender(
          new api.upload.GetFile({ location, offset: bigInt(offset), limit }),
          sender,
        );
        if (doc.dcId) {
          this.warmDcs.add(doc.dcId); // remember for the keep-warm touche
        }
        if (res instanceof api.upload.FileCdnRedirect) {
          throw new TelegramSourceError("unreachable", "CDN-redirected downloads not supported", 60);
        }
        return Buffer.from(res.bytes); // copy off the MTProto scratch buffer
      } catch (e) {
        if (e instanceof FileMigrateError) {
          // the doc lied about its DC — remember the real one so subsequent
          // windows skip the migrate hop, and keep THAT dc warm too
          doc.dcId = e.newDc;
          this.warmDcs.add(e.newDc);
          sender = await client.getSender(e.newDc); // file lives in another DC
          continue;
        }
        if ((e as { errorMessage?: string }).errorMessage === "TIMEOUT" && attempt < 1) {
          await delay(1000); // one retry like GramJS' own DirectDownloadIter
          continue;
        }
        const c = this.classify(e);
        if (c.kind === "flood") {
          this.recordFloodWait(c.seconds ?? 30);
          throw new TelegramSourceError("flood", `FLOOD_WAIT ${c.seconds ?? ""}`, c.seconds ?? 30);
        }
        throw new TelegramSourceError(c.kind, c.detail, c.kind === "fatal" ? undefined : 10);
      }
    }
  }
}

/** The opener abort handshake: a regular Error the loop treats as abort. */
function abortErrorOf(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** FILE_REFERENCE_EXPIRED (plus its upgrade cousin) detection, §4.14. */
function looksLikeFileRefExpired(e: unknown): boolean {
  const err = e as { errorMessage?: string; message?: string };
  const msg = err?.errorMessage ?? err?.message ?? "";
  return msg === "FILE_REFERENCE_EXPIRED" || msg === "FILEREF_UPGRADE_NEEDED";
}

/** One upload.GetFile window request, as handed to the (injectable) opener. */
export interface WindowRequest {
  doc: ResolvedDocument;
  /** absolute file offset of the window start (512 KiB-aligned) */
  offset: number;
  /** = WINDOW except at EOF where Telegram may return less */
  limit: number;
  signal: AbortSignal;
  /** FR-12: set when the window targets a thumbnail rendition (M4 /art) */
  thumbSize?: string;
}

export type WindowOpener = (req: WindowRequest) => Promise<Buffer>;

/** Minimal promisified sleep for connect backoff. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
