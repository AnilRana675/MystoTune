/**
 * M1 tests: pure transformDocumentMessage behaviour (§4.6 metadata priority,
 * voice skip, audio filter), docId stability, IndexIndexer sync/cursor/cap/
 * reconcile with a scripted fake TelegramManager, TelegramManager gate
 * behaviour, and the ready-state /stream + /media flow for a telegram row
 * (signed URL + real HEAD headers; GET stays 503 until the M2 byte bridge).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import {
  transformDocumentMessage,
  docIdFromLong,
  looksLikeAudio,
  trackIdFor,
  type RawDocMessage,
} from "../src/indexer";
import { TelegramManager, TelegramSourceError } from "../src/telegram";
import type { AppConfig } from "../src/config";
import { openDb, createSchema, countTracks, getCursor, getTrack, upsertTrack, type UpsertTrack } from "../src/db";
import { IndexIndexer } from "../src/index-loop";
import { buildTestServer, fetchJson, TEST_SECRET, type TestServer } from "./util.js";

const RAW = (over: Partial<RawDocMessage> = {}): RawDocMessage => ({
  chatId: -1001234567890,
  msgId: 789,
  docId: "1051188861",
  mime: "audio/mpeg",
  size: 1_002_000,
  fileName: "Artist Name - Track Title (320 kbps).mp3",
  attrTitle: null,
  attrPerformer: null,
  duration: 42,
  voice: false,
  caption: null,
  hasThumb: false,
  ...over,
});

const CHAT = -1001234567890;

test("transformDocumentMessage: full happy path (id scheme, quality math, noise cleaning)", () => {
  const row = transformDocumentMessage(RAW());
  assert.ok(row);
  assert.equal(row.id, "tg_n1001234567890_789");
  assert.equal(row.chatId, CHAT);
  assert.equal(row.source, "telegram");
  assert.equal(row.title, "Track Title"); // (320 kbps) tag gone, first dash split
  assert.equal(row.artist, "Artist Name");
  assert.equal(row.duration, 42);
  assert.equal(row.codec, "mp3");
  assert.equal(row.container, "mp3");
  assert.equal(row.lossless, 0);
  assert.equal(row.bitrateKbps, Math.round((1_002_000 * 8) / 42 / 1000));
  assert.equal(row.docId, 1051188861);
  assert.equal(row.filePath, null);
});

test("transformDocumentMessage: attr metadata wins over filename (§4.6.2 priority a)", () => {
  const row =
    transformDocumentMessage(
      RAW({ attrTitle: "Real Title", attrPerformer: "Real Artist", fileName: "AA - BB.mp3", caption: "CC - DD" }),
    );
  assert.ok(row);
  assert.equal(row.title, "Real Title");
  assert.equal(row.artist, "Real Artist");
});

test("transformDocumentMessage: caption fallback when filename has no dash", () => {
  const row = transformDocumentMessage(RAW({ fileName: "TrackTitle.mp3", caption: "Some Artist - Some Song" }));
  assert.ok(row);
  assert.equal(row.title, "Some Song");
  assert.equal(row.artist, "Some Artist");
});

test("transformDocumentMessage skips: voice notes, non-audio, no-title", () => {
  assert.equal(transformDocumentMessage(RAW({ voice: true })), null);
  assert.equal(transformDocumentMessage(RAW({ mime: "video/mp4", fileName: "clip.mp4" })), null);
  assert.equal(transformDocumentMessage(RAW({ fileName: null, attrTitle: null, caption: null })), null);
});

test("transformDocumentMessage: flac is lossless with null bitrate; ogg keeps unknown codec", () => {
  const flac = transformDocumentMessage(RAW({ mime: "audio/flac", fileName: "01 - Band - Song (Lossless).flac", size: 19_750_000 }));
  assert.ok(flac);
  assert.equal(flac.lossless, 1);
  assert.equal(flac.bitrateKbps, null);
  assert.equal(flac.codec, "flac");
  const ogg = transformDocumentMessage(RAW({ mime: "audio/ogg", fileName: "song.ogg" }));
  assert.ok(ogg);
  assert.equal(ogg.codec, null); // §4.5: Vorbis/Opus uncertain -> omit codec
  assert.equal(ogg.container, "ogg");
});

test("looksLikeAudio and docIdFromLong stability", () => {
  assert.equal(looksLikeAudio("audio/mpeg", null), true);
  assert.equal(looksLikeAudio("video/mp4", "x.flac"), true); // ext override
  assert.equal(looksLikeAudio("video/mp4", "movie.mp4"), false);
  assert.equal(docIdFromLong("1051188861"), 1051188861);
  assert.equal(docIdFromLong("9223372036854775807"), docIdFromLong("9223372036854775807")); // stable past 2^53
  assert.notEqual(docIdFromLong("99999999999999900"), docIdFromLong("99999999999999999"));
  assert.equal(docIdFromLong(null), 0);
});

test("trackIdFor encodes negative chats with the n prefix (§4.3)", () => {
  assert.equal(trackIdFor(CHAT, 5), "tg_n1001234567890_5");
  assert.equal(trackIdFor(12345, 6), "tg_12345_6");
});

/* --------------------------------------------------------------- loop */

const testCfg = (over: Partial<AppConfig> = {}): AppConfig => {
  const base = {
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
  };
  return { ...base, ...over } as AppConfig;
};

interface LoopHarness {
  db: ReturnType<typeof openDb>;
  indexer: IndexIndexer;
  warnings: string[];
  fake: unknown;
  cfg: AppConfig;
  list: (msgs: RawDocMessage[]) => void;
  setExists: (missingMsgIds: number[]) => void;
  cleanup: () => void;
}

/** Fresh db + IndexIndexer driven by a scripted fake manager. */
function loopHarness(cfgOver: Partial<AppConfig> = {}): LoopHarness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m1-loop-"));
  const db = openDb(path.join(dir, "i.sqlite"));
  createSchema(db);
  const cfg = testCfg({ dbPath: path.join(dir, "i.sqlite"), ...cfgOver });

  let script: RawDocMessage[] = [];
  let missingMsgIds: number[] = [];
  const fake = {
    state: "ready",
    detail: null,
    listAudioMessages: async (chatId: number, minId: number, cap?: number) => {
      void cap;
      assert.equal(chatId, CHAT);
      return script.filter((m) => m.msgId > minId);
    },
    messagesExist: async (chatId: number, ids: number[]) => {
      void chatId;
      return ids.map((id) => !missingMsgIds.includes(id));
    },
  } as unknown as TelegramManager;

  const warnings: string[] = [];
  const indexer = new IndexIndexer(db, fake, cfg, (m: string) => void warnings.push(m));
  return {
    db,
    indexer,
    warnings,
    fake,
    cfg,
    list: (msgs) => {
      script = msgs;
    },
    setExists: (holes) => {
      missingMsgIds = holes;
    },
    cleanup: () => {
      indexer.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const rawFor = (msgId: number, over: Partial<RawDocMessage> = {}): RawDocMessage =>
  RAW({ msgId, docId: String(900000000 + msgId), ...over });

test("sync inserts rows, advances cursor, dedupes on re-pass", async () => {
  const h = loopHarness();
  try {
    h.list([rawFor(1), rawFor(2), rawFor(3)]);
    await h.indexer.syncOnce();
    assert.equal(countTracks(h.db), 3);
    assert.equal(getCursor(h.db, CHAT), 3);

    // identical poll (cursor replay) => upserts overwrite, no duplicates
    h.list([rawFor(1), rawFor(2), rawFor(3)]);
    await h.indexer.syncOnce();
    assert.equal(countTracks(h.db), 3);
    assert.equal(getCursor(h.db, CHAT), 3);

    // next poll sees only the new message above the cursor
    h.list([rawFor(4)]);
    await h.indexer.syncOnce();
    assert.equal(countTracks(h.db), 4);
    assert.equal(getCursor(h.db, CHAT), 4);
  } finally {
    h.cleanup();
  }
});

test("reconcile removes deleted rows in batches of 100", async () => {
  const h = loopHarness();
  try {
    const msgs = Array.from({ length: 120 }, (_, i) => rawFor(i + 1));
    h.list(msgs);
    await h.indexer.syncOnce();
    assert.equal(countTracks(h.db), 120);

    // two holes: msgId 5 (first batch) and 117 (second batch)
    h.setExists([5, 117]);
    await h.indexer.reconcileOnce();
    assert.equal(countTracks(h.db), 118);
    assert.equal(getTrack(h.db, "tg_n1001234567890_5"), null);
    assert.equal(getTrack(h.db, "tg_n1001234567890_117"), null);
  } finally {
    h.cleanup();
  }
});

test("boot reconcile reaps deletions shortly after start() (M7.14)", async () => {
  const h = loopHarness();
  try {
    h.list([rawFor(1), rawFor(2)]);
    await h.indexer.syncOnce();
    assert.equal(countTracks(h.db), 2);

    // msgId 1 deleted in the channel (outside the bot — app-side delete)
    h.setExists([1]);
    const booted = new IndexIndexer(
      h.db,
      h.fake as TelegramManager,
      h.cfg,
      (m: string) => void h.warnings.push(m),
      null,
      undefined,
      10, // 10 ms boot delay — reaps without waiting the interval hours
    );
    booted.start();
    try {
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(countTracks(h.db), 1, "deleted track reaped right after boot");
      assert.ok(booted.lastReconcileAt > 0);
    } finally {
      booted.stop();
    }
  } finally {
    h.cleanup();
  }
});

test("cap keeps the newest rows (§4.6 MAX_INDEX_ENTRIES)", async () => {
  const h = loopHarness({ maxIndexEntries: 5 });
  try {
    h.list(Array.from({ length: 9 }, (_, i) => rawFor(i + 1)));
    await h.indexer.syncOnce();
    assert.ok(countTracks(h.db) <= 5, `expected <=5 after trim, got ${countTracks(h.db)}`);
    // newest = highest msg ids survive
    for (const msgId of [6, 7, 8, 9]) {
      assert.ok(getTrack(h.db, `tg_n1001234567890_${msgId}`), `msg ${msgId} should survive`);
    }
    for (const msgId of [1, 2]) {
      assert.equal(getTrack(h.db, `tg_n1001234567890_${msgId}`), null, `msg ${msgId} should be trimmed`);
    }
  } finally {
    h.cleanup();
  }
});

test("search finds real-synced rows immediately (real search, §4.6.4)", async () => {
  const h = loopHarness();
  try {
    h.list([rawFor(1), rawFor(2, { mime: "audio/flac", fileName: "Aurora Veil - Midnight Glass [24Bit Lossless] (FLAC).flac", size: 473090, duration: 30 })]);
    await h.indexer.syncOnce();
    const { searchTracks } = await import("../src/db.js");
    const rows = searchTracks(h.db, "midnight");
    assert.ok(rows.length >= 1);
    assert.match(rows[0]!.title, /Midnight Glass/i);
  } finally {
    h.cleanup();
  }
});

/* ------------------------------------------------------------ manager gates */

test("resolveDocument gates: not_configured > unreachable before any client use", async () => {
  const tm = new TelegramManager(
    testCfg({ telegram: { apiId: 1, apiHash: "h", session: "s", channels: [CHAT], configured: true } }),
  );
  tm.state = "not_configured";
  tm.detail = "not configured";
  await assert.rejects(
    tm.resolveDocument({ id: "tg_n1001234567890_1", source: "telegram", chatId: CHAT, msgId: 1 }),
    (e: TelegramSourceError) => e.kind === "unreachable" && Number(e.retryAfterSeconds) > 0,
  );
});

test("resolveDocument: fatal passes through; flood dominates once armed", async () => {
  const tm = new TelegramManager(testCfg());
  tm.state = "fatal";
  tm.detail = "telegram session fatal: AUTH_KEY_DUPLICATED";
  await assert.rejects(
    tm.resolveDocument({ id: "tg_n1001234567890_1", source: "telegram", chatId: CHAT, msgId: 1 }),
    (e: TelegramSourceError) => e.kind === "fatal",
  );

  tm.state = "ready";
  tm.recordFloodWait(37);
  await assert.rejects(
    tm.resolveDocument({ id: "tg_n1001234567890_1", source: "telegram", chatId: CHAT, msgId: 1 }),
    (e: TelegramSourceError) => e.kind === "flood" && e.retryAfterSeconds === 37,
  );
});

test("resolveDocument: ready without client -> unreachable; LRU cache short-circuits", async () => {
  const tm = new TelegramManager(testCfg());
  tm.state = "ready";
  await assert.rejects(
    tm.resolveDocument({ id: "tg_n1001234567890_1", source: "telegram", chatId: CHAT, msgId: 1 }),
    (e: TelegramSourceError) => e.kind === "unreachable",
  );
  tm.resolvedDocs.set("tg_n1001234567890_1", {
    docId: 42,
    size: 999,
    mime: "audio/flac",
    fileName: "a.flac",
    docLongId: "4242",
    accessHash: "111",
    fileReference: Buffer.alloc(24, 9),
    dcId: 2,
  });
  const doc = await tm.resolveDocument({ id: "tg_n1001234567890_1", source: "telegram", chatId: CHAT, msgId: 1 });
  assert.ok(doc, "LRU hit should resolve");
  assert.equal(doc.docId, 42);
  assert.equal(doc.size, 999);
  // fixture rows never consult the connector
  assert.equal(await tm.resolveDocument({ id: "tg_1_1", source: "fixture", chatId: 1, msgId: 1 }), null);
});

/* ------------------------------------------------------- server ready state */

test("ready-state telegram row: /stream 200 signed url, HEAD /media real headers, GET /media 503", async () => {
  const ts: TestServer = await buildTestServer();
  try {
    ts.telegram.forceState("ready", "wired to test stub");
    // seed a telegram-source row and pre-arm the LRU (no client in tests)
    const row: UpsertTrack = {
      id: "tg_n1001234567890_777",
      chatId: CHAT,
      msgId: 777,
      title: "Long Distance Radio",
      artist: "Signal Ghost",
      album: null,
      duration: 61,
      mime: "audio/mpeg",
      size: 1_200_000,
      fileName: "Signal Ghost - Long Distance Radio.mp3",
      codec: "mp3",
      container: "mp3",
      lossless: 0,
      bitrateKbps: 157,
      docId: 7654321,
      source: "telegram",
      filePath: null,
      hasThumb: 0,
    };
    upsertTrack(ts.db, row);
    ts.telegram.resolvedDocs.set(row.id, {
      docId: row.docId,
      size: row.size!,
      mime: row.mime,
      fileName: row.fileName,
      docLongId: "9931881700077",
      accessHash: "2222",
      fileReference: Buffer.alloc(24, 7),
      dcId: 2,
    });

    // /stream: 200 + absolute signed url, in-band descriptor fields
    const stream = await fetchJson(ts, `/${TEST_SECRET}/stream/${row.id}`);
    assert.equal(stream.status, 200);
    const streamBody = (await stream.json()) as Record<string, unknown>;
    assert.equal(streamBody["manifest"], "none");
    assert.equal(streamBody["encrypted"], false);
    const url = streamBody["url"] as string;
    assert.ok(url.startsWith(`${ts.baseUrl}/media/`), `expected signed media url, got ${url}`);

    // HEAD /media: real file headers from the index snapshot
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-type"), "audio/mpeg");
    assert.equal(head.headers.get("etag"), `"7654321-1200000"`);
    assert.equal(head.headers.get("content-length"), "1200000");
    assert.match(head.headers.get("cache-control") ?? "", /private/);
    assert.equal(await head.text(), "");

    // GET /media: byte bridge is M2 -> 503 with Retry-After on a known track
    const get = await fetch(url, { headers: { range: "bytes=0-99" } });
    assert.equal(get.status, 503);
    assert.ok(Number(get.headers.get("retry-after") ?? 0) > 0);

    // out-of-range still 416 before any connector work
    const bad = await fetch(url, { headers: { range: `bytes=${row.size! + 5}-${row.size! + 10}` } });
    assert.equal(bad.status, 416);
  } finally {
    await ts.cleanup();
  }
});

test("ready-state telegram row resolves via LRU: missing entry 503, flood 429", async () => {
  const ts: TestServer = await buildTestServer();
  try {
    ts.telegram.forceState("ready");
    // no LRU entry, no client -> unreachable -> 503 for a seeded telegram row
    const seed: UpsertTrack = telegramRowFor(778, "Ghost Delay");
    upsertTrack(ts.db, seed);
    const stream = await fetchJson(ts, `/${TEST_SECRET}/stream/${seed.id}`);
    assert.equal(stream.status, 503);

    // flood cooldown overrides everything downstream of the state gates
    ts.telegram.forceState("ready", "armed");
    ts.telegram.recordFloodWait(12);
    const flood = await fetchJson(ts, `/${TEST_SECRET}/stream/${seed.id}`);
    assert.equal(flood.status, 429);
    assert.equal(flood.headers.get("retry-after"), "12");
    ts.telegram.recordFloodWait(-1000000); // clear for other tests
  } finally {
    await ts.cleanup();
  }
});

/* helpers */

function telegramRowFor(msgId: number, title: string): UpsertTrack {
  return {
    id: `tg_n1001234567890_${msgId}`,
    chatId: CHAT,
    msgId,
    title,
    artist: null,
    album: null,
    duration: 30,
    mime: "audio/mpeg",
    size: 960_000,
    fileName: `${title}.mp3`,
    codec: "mp3",
    container: "mp3",
    lossless: 0,
    bitrateKbps: 256,
    docId: 88000 + msgId,
    source: "telegram",
    filePath: null,
    hasThumb: 0,
  };
}
