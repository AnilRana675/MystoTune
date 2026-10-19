/**
 * M2 tests (TRD §4.7 + §4.14): the upload.GetFile byte bridge for telegram rows.
 *
 *  - pure window maths (512 KiB alignment, 1 MiB boundary rule, head/tail trim)
 *  - 50-slice byte-exact checksum battery through a SCRIPTED Telegram window
 *    opener (never touches the network)
 *  - FILE_REFERENCE_EXPIRED: re-fetch the message once and retry once (§4.14)
 *  - truncation, FloodWait, abort and in-flight cap semantics
 *  - server-level GET /media through the bridge (Range + full length + sha256)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { WINDOW, alignDown, withinOneMebibyteBlock, sliceForWindow } from "../src/download-window.js";
import { TelegramManager, TelegramSourceError, type ResolvedDocument, type WindowRequest } from "../src/telegram.js";
import type { AppConfig } from "../src/config.js";
import { upsertTrack, type UpsertTrack } from "../src/db.js";
import { createMediaToken } from "../src/sign.js";
import { buildTestServer, type TestServer } from "./util.js";

const CHAT = -1001234567890;
const ENTRY = { id: "tg_n1001234567890_9", source: "telegram", chatId: CHAT, msgId: 9 };
const ROW_ID = ENTRY.id;
const size = 2_500_000; // ~4.77 windows + partial tail

/* deterministic content: byte at absolute offset i */
const pat = (i: number) => (i * 31 + 7) & 0xff;
function contentFor(offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = pat(offset + i);
  return buf;
}

const DOC = (): ResolvedDocument => ({
  docId: 7654321,
  size,
  mime: "audio/flac",
  fileName: "a.flac",
  docLongId: "9931881700077",
  accessHash: "2222",
  fileReference: Buffer.alloc(24, 7),
  dcId: 2,
});

/* --------------------------------------------------------- window maths */

test("window maths: alignment and 1 MiB boundary rule", () => {
  assert.equal(alignDown(0), 0);
  assert.equal(alignDown(1), 0);
  assert.equal(alignDown(WINDOW - 1), 0);
  assert.equal(alignDown(WINDOW), WINDOW);
  assert.equal(alignDown(size), 4 * WINDOW); // 2_500_000 -> 4 windows down
  for (const start of [0, 1, WINDOW - 3, WINDOW, size - 1, size]) {
    const off = alignDown(start);
    assert.ok(withinOneMebibyteBlock(off, WINDOW), `offset ${off} must sit inside one 1 MiB block`);
  }
});

test("window maths: sliceForWindow trims head and tail", () => {
  const w0 = contentFor(0, WINDOW);
  // head trim: slice starts mid-window
  const head = sliceForWindow(w0, 0, 100, 399);
  assert.equal(head.length, 300);
  assert.equal(head[0], pat(100));
  assert.equal(head[299], pat(399));
  // tail trim: window covers beyond end
  assert.equal(sliceForWindow(w0, 0, 0, 1023).length, 1024);
  assert.equal(sliceForWindow(w0, 0, 0, size - 1).length, WINDOW);
  // disjoint windows yield nothing
  assert.equal(sliceForWindow(w0, 0, WINDOW + 1, WINDOW + 9).length, 0);
  assert.equal(sliceForWindow(w0, WINDOW, 0, 99).length, 0);
  // EOF window: buffer shorter than a full window
  const tail = contentFor(2 * WINDOW, size - 2 * WINDOW);
  const last = sliceForWindow(tail, 2 * WINDOW, size - 10, size - 1);
  assert.equal(last.length, 10);
  assert.equal(last[9], pat(size - 1));
});

/* ------------------------------------------------------ scripted Telegram */

class Scripted {
  calls: WindowRequest[] = [];
  /** errors to throw per absolute window offset — FIFO, cleared by use */
  private errors = new Map<number, unknown[]>();
  /** shortened content: offset -> byte length (mid-file truncation scenarios) */
  private shorts = new Map<number, number>();
  /** references returned by the (faked) refetchDoc after FILE_REFERENCE_EXPIRED */
  refetchedDocs: ResolvedDocument[] = [];
  maxInflight = 0;
  private inflight = 0;

  /** queue an error for the window at `offset` (called `times` times) */
  fail(offset: number, err: unknown, times = 1): void {
    const key = alignDown(offset);
    const queue = this.errors.get(key) ?? [];
    for (let i = 0; i < times; i++) queue.push(err);
    this.errors.set(key, queue);
  }

  shortAt(offset: number, length: number): void {
    this.shorts.set(alignDown(offset), length);
  }

  refetch(): ResolvedDocument {
    const doc = this.refetchedDocs.shift();
    if (!doc) throw new Error("Scripted.refetch exhausted");
    return doc;
  }

  readonly opener = async (req: WindowRequest): Promise<Buffer> => {
    this.calls.push(req);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (req.signal.aborted) throw new TelegramSourceError("unreachable", "aborted before fetch", 0);
      const queue = this.errors.get(req.offset);
      const err = queue?.shift();
      if (queue && queue.length === 0) this.errors.delete(req.offset);
      if (err) throw err;
      const shortLen = this.shorts.get(req.offset);
      if (shortLen !== undefined) return contentFor(req.offset, shortLen);
      const length = Math.max(0, Math.min(req.limit, size - req.offset));
      return length ? contentFor(req.offset, length) : Buffer.alloc(0);
    } finally {
      this.inflight -= 1;
    }
  };
}

/* helpers */

const testCfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    port: 0,
    publicBaseUrl: "http://127.0.0.1:9",
    insecureBaseAllowance: true as const,
    addonId: "test",
    addonName: "t",
    addonDescription: "d",
    addonVersion: "0",
    addonSecret: "s".repeat(40),
    mediaSigningKey: Buffer.alloc(32, 1),
    mediaUrlTtlSeconds: 300,
    telegram: { apiId: 1, apiHash: "h", session: "s", channels: [CHAT], configured: true },
    dbPath: "ignored",
    maxIndexEntries: 50000,
    syncIntervalMinutes: 1,
    reconcileIntervalHours: 1,
    maxConcurrentStreams: 2,
    admissionWaitMs: 100,
    allowDownloads: false,
    checkValidLossless: false,
    logLevel: "error" as const,
    redis: { url: "", timeoutMs: 200, snapshot: false },
    ...over,
  }) as AppConfig;

function bridge(scripted: Scripted, doc = DOC()): TelegramManager {
  const tm = new TelegramManager(testCfg());
  tm.state = "ready";
  tm.resolvedDocs.set(ENTRY.id, doc);
  tm.windowOpener = scripted.opener;
  return tm;
}

function sliceStream(scripted: Scripted, start: number, end: number, tm?: TelegramManager): AsyncIterable<Buffer> {
  return (tm ?? bridge(scripted)).docSource(ENTRY).stream(
    start,
    end,
    new AbortController().signal,
  ) as unknown as AsyncIterable<Buffer>;
}

async function drain(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of it) out.push(chunk);
  return Buffer.concat(out);
}

/** node:mulberry32 — deterministic prng (same style as test/range.test.ts) */
function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----------------------------------------------- 50-slice checksum battery */

test("50 random slices byte-exact through the scripted telegram bridge", async () => {
  const scripted = new Scripted();
  const tm = bridge(scripted);
  const rand = prng(0xbee5);
  let seenCalls = 0;
  for (let n = 0; n < 50; n++) {
    const start = Math.floor(rand() * (size - 1));
    const span = 1 + Math.floor(rand() * Math.min(1_500_000, size - start));
    const end = start + span - 1;
    const got = await drain(sliceStream(scripted, start, end, tm));
    assert.equal(got.length, span, `slice ${n} [${start}..${end}] length`);
    assert.ok(got.equals(contentFor(start, span)), `slice ${n} [${start}..${end}] bytes must match the pattern`);
    const fresh = scripted.calls.slice(seenCalls);
    assert.ok(fresh.length >= 1, "each slice opens at least one window");
    assert.equal(fresh[0]!.offset, alignDown(start), "first window aligns DOWN to a 512 KiB boundary");
    for (const req of fresh) {
      assert.ok(withinOneMebibyteBlock(req.offset, req.limit), "no window may cross a 1 MiB boundary");
      assert.equal(req.offset % 4096, 0, "offsets are 4 KiB multiples");
      assert.equal(req.limit, WINDOW, "fixed 512 KiB windows");
    }
    seenCalls = scripted.calls.length;
  }
  // sequential fetches: at most one chunk in flight plus one read-ahead buffer
  assert.ok(scripted.maxInflight <= 2, `in-flight cap violated: ${scripted.maxInflight}`);
});

/* ------------------------------------------------- §4.14 expiry semantics */

test("FILE_REFERENCE_EXPIRED: refetch the message once, retry once, bytes intact", async () => {
  const scripted = new Scripted();
  scripted.fail(0, { errorMessage: "FILE_REFERENCE_EXPIRED" });
  const freshDoc = DOC();
  freshDoc.fileReference = Buffer.alloc(24, 13); // "new" reference after refetch
  scripted.refetchedDocs.push(freshDoc);

  const tm = bridge(scripted);
  (tm as unknown as { fetchResolvedDoc: (e: unknown) => Promise<ResolvedDocument> }).fetchResolvedDoc = async () =>
    scripted.refetch();

  const all = await drain(sliceStream(scripted, 0, WINDOW + 100, tm));
  assert.equal(all.length, WINDOW + 101);
  assert.equal(all[0], pat(0));
  assert.equal(all[WINDOW], pat(WINDOW));

  // first call fails, the second retries the SAME offset with a fresh reference
  assert.equal(scripted.calls.length >= 2, true);
  assert.equal(scripted.calls[0]!.offset, 0);
  assert.equal(scripted.calls[1]!.offset, 0);
  assert.deepEqual(scripted.calls[1]!.doc.fileReference, freshDoc.fileReference);
  // refetch repopulates the LRU for later players
  assert.notEqual(tm.resolvedDocs.get(ENTRY.id)?.fileReference, undefined);
  assert.equal(tm.resolvedDocs.get(ENTRY.id)!.fileReference!.toString(), freshDoc.fileReference.toString());
});

test("FILE_REFERENCE_EXPIRED twice -> unreachable (no infinite loop)", async () => {
  const scripted = new Scripted();
  scripted.fail(0, { errorMessage: "FILE_REFERENCE_EXPIRED" }, 2); // expires twice
  scripted.refetchedDocs.push(DOC());

  const tm = bridge(scripted);
  (tm as unknown as { fetchResolvedDoc: (e: unknown) => Promise<ResolvedDocument> }).fetchResolvedDoc = async () =>
    scripted.refetch();

  await assert.rejects(
    sliceStream(scripted, 0, 100, tm)[Symbol.asyncIterator]().next(),
    (e: TelegramSourceError) => e.kind === "unreachable" && /expired again/.test(e.message),
  );
});

/* ------------------------------------------------- failure + abort shapes */

test("mid-file short window is a truncation error", async () => {
  const scripted = new Scripted();
  scripted.shortAt(0, 100); // window at 0 returns 100 bytes, but range wants more
  await assert.rejects(
    drain(sliceStream(scripted, 0, 1000)),
    (e: TelegramSourceError) => e.kind === "unreachable" && /truncat/.test(e.message),
  );
});

test("FloodWait through the opener surfaces as a flood TelegramSourceError", async () => {
  const scripted = new Scripted();
  scripted.fail(0, new TelegramSourceError("flood", "FLOOD_WAIT 30", 30));
  await assert.rejects(
    sliceStream(scripted, 0, 100)[Symbol.asyncIterator]().next(),
    (e: TelegramSourceError) => e.kind === "flood" && e.retryAfterSeconds === 30,
  );
});

test("abort mid-stream stops windows and closes without throwing", async () => {
  const scripted = new Scripted();
  const tm = bridge(scripted);
  const ac = new AbortController();
  const iter = tm.docSource(ENTRY).stream(0, size - 1, ac.signal)[Symbol.asyncIterator]();
  const first = await iter.next(); // window 1 bytes
  assert.ok(first.value && first.value.length > 0);
  ac.abort();
  const second = await iter.next();
  assert.equal(second.done, true); // generator closed gracefully
  const callsAfterAbort = scripted.calls.length;
  await iter.next(); // must not open further windows
  assert.equal(scripted.calls.length, callsAfterAbort);
  await (iter as unknown as { return?: (v?: unknown) => Promise<unknown> }).return?.();
});

/* ------------------------------------------------------ server-level flow */

function rowFull(): UpsertTrack {
  return {
    id: ROW_ID,
    chatId: CHAT,
    msgId: 9,
    title: "Scripted Signal",
    artist: "Test Phantom",
    album: null,
    duration: 300,
    mime: "audio/flac",
    size,
    fileName: "Test Phantom - Scripted Signal.flac",
    codec: "flac",
    container: "flac",
    lossless: 1,
    bitrateKbps: null,
    docId: 7654321,
    source: "telegram",
    filePath: null,
    hasThumb: 0,
  };
}

test("GET /media through the bridge: Range byte-exact, full 200 + sha256", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    upsertTrack(ts.db, rowFull());
    const scripted = new Scripted();
    ts.telegram.windowOpener = scripted.opener;
    ts.telegram.resolvedDocs.set(ROW_ID, DOC());

    const token = createMediaToken(ROW_ID, ts.cfg.mediaSigningKey, 300);
    const url = `${ts.baseUrl}/media/${token}`;

    // slice spanning a window boundary
    const start = WINDOW - 44;
    const end = WINDOW + 101;
    const r = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
    assert.equal(r.status, 206);
    assert.match(r.headers.get("content-range") ?? "", new RegExp(`bytes ${start}-${end}/${size}`));
    assert.equal(Number(r.headers.get("content-length")), end - start + 1);
    const body = Buffer.from(await r.arrayBuffer());
    assert.ok(body.equals(contentFor(start, end - start + 1)), "206 body must be byte-exact");

    // full GET: Content-Length equals the live size and the bytes line up
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(Number(full.headers.get("content-length")), size);
    const all = Buffer.from(await full.arrayBuffer());
    assert.ok(all.equals(contentFor(0, size)), "full body must equal the whole scripted file");

    // windows stayed sequential, inside the boundary rule, and start aligned
    assert.ok(scripted.maxInflight <= 2);
    assert.ok(scripted.calls.every((c) => c.offset % 4096 === 0 && withinOneMebibyteBlock(c.offset, c.limit)));
    assert.equal(scripted.calls[0]!.offset, 0);

    // explicit checksum guard for the full-body transfer
    const sum = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(sum(all), sum(contentFor(0, size)));
  } finally {
    await ts.cleanup();
  }
});

test("GET /media with scripted FloodWait: 429 Retry-After, no body", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    upsertTrack(ts.db, rowFull());
    const scripted = new Scripted();
    scripted.fail(0, new TelegramSourceError("flood", "FLOOD_WAIT 30", 30));
    ts.telegram.windowOpener = scripted.opener;
    ts.telegram.resolvedDocs.set(ROW_ID, DOC());

    const token = createMediaToken(ROW_ID, ts.cfg.mediaSigningKey, 300);
    const res = await fetch(`${ts.baseUrl}/media/${token}`);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "30");
    assert.equal(await res.text(), "{}"); // established short JSON error body
  } finally {
    await ts.cleanup();
  }
});
