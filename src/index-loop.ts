/**
 * Indexer loop — §4.6, §4.12, FR-14.
 * M1: polls each TARGET_CHANNEL_IDS chat every SYNC_INTERVAL_MINUTES with a
 * per-chat cursor in SQLite, upserts audio-bearing document messages, trims
 * to MAX_INDEX_ENTRIES (keeping the newest), and reconciles deletions every
 * RECONCILE_INTERVAL_HOURS by probing known msg ids in batches of 100.
 */
import type { AppConfig } from "./config";
import { gunzip, gzip } from "node:zlib";
import type { Database } from "better-sqlite3";

import {
  countTracks,
  exportTrackSnapshot,
  getCursor,
  listChatTrackRows,
  oldestTrackRowids,
  removeTracksByRowids,
  restoreTrackSnapshot,
  setCursor,
  upsertTrack,
  type IndexSnapshot,
  type UpsertTrack,
} from "./db";
import { transformDocumentMessage, type RawDocMessage } from "./indexer";
import type { TelegramManager } from "./telegram";
import type { RedisStore } from "./redis";

const DEFAULT_CAP_PER_PASS = 5000;

function gzipAsync(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    gzip(input, (err, out) => (err ? reject(err) : resolve(Buffer.from(out)))),
  );
}

/** 4.11 (REDIS_SNAPSHOT=1): replay the Redis index:snapshot on boot when the */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Real-stream guarantee (§4.11): the very first redis command of a boot must
 * not race the TLS handshake — wait (bounded) until the store reports up. */
export async function waitRedisUp(redis: RedisStore, deadlineMs = 2_500): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (redis.status() === "up") return;
    await sleep(50);
  }
}

export async function restoreSnapshotIfEmpty(
  db: Database,
  cfg: AppConfig,
  redis: RedisStore | null,
): Promise<number> {
  if (!(redis && cfg.redis.snapshot)) return 0;
  if (countTracks(db) > 0) return 0; // disk already has the index — skip
  await waitRedisUp(redis);
  let gz: Buffer | null = null;
  try {
    gz = await redis.readSnapshot();
  } catch (e) {
    console.warn(`redis: index snapshot read failed (${(e as Error).message}) — crawling live`);
    return 0;
  }
  if (!gz || gz.length === 0) {
    // first boot on the plan: nothing stored yet; this boot's pass writes one
    console.log("redis: no index snapshot yet — crawling (this boot writes one after its pass)");
    return 0;
  }
  let snap: IndexSnapshot;
  try {
    const json = await new Promise<Buffer>((resolve, reject) => {
      gunzip(gz as Buffer, (err, out) => (err ? reject(err) : resolve(Buffer.from(out))));
    });
    snap = JSON.parse(json.toString("utf8")) as IndexSnapshot;
  } catch (e) {
    console.warn(`redis: index snapshot unusable (${(e as Error).message}) — crawling`);
    return 0;
  }
  const n = restoreTrackSnapshot(db, snap);
  if (n > 0) console.log(`redis: index snapshot restored (${n} tracks + sync cursors)`);
  else console.warn("redis: snapshot carried no usable rows — crawling live");
  return n;
}

export class IndexIndexer {
  /** read by /healthz (§4.12): a sync pass is in flight */
  active = false;
  lastSyncAt = 0;
  lastSyncError: string | null = null;
  lastReconcileAt = 0;

  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly tm: TelegramManager,
    private readonly cfg: AppConfig,
    private readonly warn: (message: string) => void = console.warn,
    private readonly redis?: RedisStore | null,
    /** M7.11-B5: fired once per sync pass with the count of newly added rows
     * (the curation bot uses it to trigger a coalesced sweep). */
    private readonly onNewRows?: (added: number) => void,
  ) {}

  start(): void {
    if (!this.cfg.telegram.configured) return;
    // first pass shortly after boot so the index is warm without waiting 10 min
    const boot = setTimeout(() => void this.syncOnce().catch(() => undefined), 5000);
    boot.unref?.();
    this.syncTimer = setInterval(
      () => void this.syncOnce().catch((e) => undefined),
      Math.max(1, this.cfg.syncIntervalMinutes) * 60_000,
    );
    this.syncTimer.unref?.();
    this.reconcileTimer = setInterval(
      () => void this.reconcileOnce().catch(() => undefined),
      Math.max(1, this.cfg.reconcileIntervalHours) * 3_600_000,
    );
    this.reconcileTimer.unref?.();
    void boot;
  }

  stop(): void {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.syncTimer = null;
    this.reconcileTimer = null;
  }

  /* --------------------------------------------------------------- sync */

  async syncOnce(): Promise<void> {
    if (this.stopped || this.active) return;
    this.active = true;
    try {
      if (this.tm.isFatal) return; // §4.13: dead sessions never sync
      let passAdded = 0;
      for (const chatId of this.cfg.telegram.channels) {
        if (this.tm.isFatal) break;
        try {
          const added = await this.syncChat(chatId);
          passAdded += added;
          if (added > 0) this.warn(`synced chat ${chatId}: ${added} new rows`);
        } catch (e) {
          this.lastSyncError = (e as Error)?.message ?? "sync error";
          this.warn(`sync chat ${chatId} failed: ${this.lastSyncError}`);
        }
      }
      this.lastSyncAt = Date.now();
      this.lastSyncError = null;
      if (passAdded > 0) this.onNewRows?.(passAdded); // B5: coalesced, once per pass
      void this.writeIndexSnapshot(); // §4.11 (REDIS_SNAPSHOT=1): after each sync
    } finally {
      this.active = false;
    }
  }

  /** Returns the number of rows upserted from this pass. */
  async syncChat(chatId: number): Promise<number> {
    const cursor = getCursor(this.db, chatId);
    const raws = await this.tm.listAudioMessages(chatId, cursor, DEFAULT_CAP_PER_PASS);
    let maxMsgId = cursor;
    let added = 0;
    for (const raw of raws) {
      const row = transformDocumentMessage(raw);
      if (row) {
        upsertTrack(this.db, row);
        added += 1;
      }
      if (raw.msgId > maxMsgId) maxMsgId = raw.msgId;
    }
    if (maxMsgId > cursor) setCursor(this.db, chatId, maxMsgId);
    this.enforceCap();
    return added;
  }

  /* --------------------------------------------------------------- cap */

  /** §4.6: MAX_INDEX_ENTRIES hard cap, keep newest, warn once per trim. */
  private lastTrimWarn = 0;

  private enforceCap(): void {
    const cap = this.cfg.maxIndexEntries;
    let overflow = countTracks(this.db) - cap;
    if (overflow <= 0) return;
    let trimmed = 0;
    while (overflow > 0) {
      const batch = oldestTrackRowids(this.db, Math.min(overflow, 1000));
      if (!batch.length) break;
      removeTracksByRowids(this.db, batch.map((v) => v.rowid));
      trimmed += batch.length;
      overflow -= batch.length;
    }
    if (Date.now() - this.lastTrimWarn > 3_600_000) {
      this.warn(`index cap reached (${cap}); trimmed ${trimmed} oldest rows`);
      this.lastTrimWarn = Date.now();
    }
  }

  /* --------------------------------- reconcile deletions (§4.6/FR-14) */

  async reconcileOnce(): Promise<void> {
    if (this.stopped || this.active) return;
    if (this.tm.isFatal) return;
    this.active = true;
    try {
      for (const chatId of this.cfg.telegram.channels) {
        const rows = listChatTrackRows(this.db, chatId);
        const missing: number[] = [];
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          const ids = batch.map((r) => r.msgId);
          const exist = await this.tm.messagesExist(chatId, ids);
          for (let j = 0; j < exist.length; j++) {
            if (!exist[j]) missing.push(batch[j]!.rowid);
          }
        }
        if (missing.length) {
          removeTracksByRowids(this.db, missing);
          this.warn(`reconciled chat ${chatId}: removed ${missing.length} deleted tracks`);
        }
      }
      this.lastReconcileAt = Date.now();
      void this.writeIndexSnapshot(); // §4.11: snapshot keeps up after trims too
    } finally {
      this.active = false;
    }
  }

  /**
   * §4.11 ephemeral-disk hosts (REDIS_SNAPSHOT=1): after each sync write the
   * gzip-compressed index to Redis's index:snapshot. Best-effort: a slow or
   * down Redis never blocks or fails the sync itself.
   */
  private async writeIndexSnapshot(): Promise<void> {
    const redis = this.redis;
    if (!(redis && this.cfg.redis.snapshot)) return;
    try {
      const json = Buffer.from(JSON.stringify(exportTrackSnapshot(this.db)), "utf8");
      const gz = await gzipAsync(json);
      redis.writeSnapshot(gz);
    } catch (e) {
      void e;
    }
  }
}
