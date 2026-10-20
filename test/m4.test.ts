/**
 * M4 tests (TRD FR-12 + FR-13 + §4.5 ALAC truthfulness): network-free by
 * construction — synthetic ID3v2/FLAC/MP4 buffers plus the scripted
 * windowOpener seam for the deep-probe and artwork fetches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { probeFirstBytes } from "../src/probe.js";
import { parseTrackMeta, trackIdFor } from "../src/indexer.js";
import { createArtToken, createMediaToken, etagFor, verifyArtToken, verifyMediaToken } from "../src/sign.js";
import { openDb, createSchema, upsertTrack, getTrack, type UpsertTrack } from "../src/db.js";
import { type ResolvedDocument, type WindowRequest } from "../src/telegram.js";
import { buildTestServer, fetchJson, TEST_SECRET, CHAT_ID, type TestServer } from "./util.js";

const S = TEST_SECRET;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- synthetic buffers */

/** Build an ID3v2 tag (v2.3/2.4) with optional utf16/utf8/latin1 text. */
function id3v2(opts: {
  ver?: 3 | 4;
  enc?: 0 | 1 | 3;
  title?: string;
  artist?: string;
  album?: string;
  extendTo?: number; // pad the resulting buffer out to this many bytes
}): Buffer {
  const ver = opts.ver ?? 3;
  const enc = opts.enc ?? 0;
  const frames: Array<{ id: string; text: string }> = [];
  if (opts.title) frames.push({ id: "TIT2", text: opts.title });
  if (opts.artist) frames.push({ id: "TPE1", text: opts.artist });
  if (opts.album) frames.push({ id: "TALB", text: opts.album });
  const body: Buffer[] = [];
  for (const f of frames) {
    let text: Buffer;
    if (enc === 1) text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.text, "utf16le")]);
    else if (enc === 3) text = Buffer.from(f.text, "utf8");
    else text = Buffer.from(f.text, "latin1");
    const content = Buffer.concat([Buffer.from([enc]), text]);
    const head = Buffer.alloc(10);
    head.write(f.id, 0, "latin1");
    head.writeUInt32BE(content.length, 4); // plain u32 frame size (v2.3 style)
    body.push(head, content);
  }
  const tag = Buffer.concat(body);
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "latin1");
  header[3] = ver;
  header[4] = 0;
  const sz = tag.length; // synchsafe big-endian size
  header[6] = (sz >> 21) & 0x7f;
  header[7] = (sz >> 14) & 0x7f;
  header[8] = (sz >> 7) & 0x7f;
  header[9] = sz & 0x7f;
  const out = Buffer.concat([header, tag]);
  if (opts.extendTo && out.length < opts.extendTo) {
    return Buffer.concat([out, Buffer.alloc(opts.extendTo - out.length, 0xff)]);
  }
  return out;
}

/** Minimal FLAC: "fLaC" + STREAMINFO (18-byte body written bit by bit). */
function flacStreaminfo(sampleRate: number, totalSamples: number): Buffer {
  const body = Buffer.alloc(18);
  // NB: `value >> n` in JS shifts mod 32, so wide fields (36-bit totalSamples)
  // must read bits without wrapping — divide for positions ≥ 32.
  const bitAt = (value: number, pos: number): 0 | 1 =>
    pos < 32 ? ((value >>> pos) & 1) as 0 | 1 : (Math.floor(value / 2 ** pos) & 1) as 0 | 1;
  const writeBits = (start: number, width: number, value: number): void => {
    for (let i = 0; i < width; i++) {
      const byte = Math.floor((start + i) / 8);
      const bit = (start + i) % 8;
      if (bitAt(value, width - 1 - i)) body[byte]! |= 1 << (7 - bit);
    }
  };
  writeBits(80, 20, sampleRate);
  writeBits(100, 3, 1); // stereo
  writeBits(103, 5, 15); // 16 bit
  writeBits(108, 36, totalSamples);
  const header = Buffer.from([0x80, 0, 0, 34]); // LAST flag | type 0, length 34
  return Buffer.concat([Buffer.from("fLaC", "latin1"), header, body, Buffer.alloc(200, 0x01)]);
}

function mp4Box(type: string, ...payload: Buffer[]): Buffer {
  let size = 8;
  for (const p of payload) size += p.length;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(size, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, ...payload]);
}

/** Minimal .m4a with a single sample entry `codec` inside stsd. */
function mp4File(codec: string): Buffer {
  const entry = mp4Box(codec, Buffer.alloc(36), mp4Box("esds"));
  const stsd = mp4Box("stsd", Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), entry);
  const moov = mp4Box("moov", mp4Box("trak", mp4Box("mdia", mp4Box("minf", mp4Box("stbl", stsd)))));
  return Buffer.concat([mp4Box("ftyp", Buffer.from("M4A ", "latin1"), Buffer.from([0, 0, 0, 0])), moov]);
}

/* ---------------------------------------------------------------- helpers */

interface ScriptedCalls {
  offset: number;
  thumbSize?: string;
}

/** Returns its firstWindow for the opening request, then nothing. */
function scriptedOpener(firstWindow: Buffer): { opener: (req: WindowRequest) => Promise<Buffer>; calls: ScriptedCalls[] } {
  const calls: ScriptedCalls[] = [];
  return {
    calls,
    opener: async (req) => {
      calls.push({ offset: req.offset, thumbSize: req.thumbSize });
      return req.offset === 0 ? firstWindow : Buffer.alloc(0);
    },
  };
}

async function until(cond: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await delay(25);
  }
  throw new Error("condition not reached in time");
}

/* ------------------------------------------------------------ probe tests */

test("probe: ID3v2.3 latin1 tags parse from the tag head", () => {
  const buf = id3v2({ title: "Midnight Glass", artist: "Aurora Veil", album: "Silent Parade" });
  assert.deepEqual(probeFirstBytes(buf, "audio/mpeg"), {
    id3: { title: "Midnight Glass", artist: "Aurora Veil", album: "Silent Parade" },
  });
});

test("probe: ID3v2.4 utf8 and utf16+BOM decodes", () => {
  const utf8 = id3v2({ ver: 4, enc: 3, album: "Silent Parade" });
  assert.deepEqual(probeFirstBytes(utf8, "audio/mpeg")?.id3?.album, "Silent Parade");
  const utf16 = id3v2({ ver: 4, enc: 1, album: "Ürüm Pläne" });
  assert.deepEqual(probeFirstBytes(utf16, "audio/mpeg")?.id3?.album, "Ürüm Pläne");
});

test("probe: audio junk after the tag is ignored (padding bounds respected)", () => {
  const buf = Buffer.concat([id3v2({ title: "T", artist: "A", album: "B" }), Buffer.alloc(900, 0x55)]);
  assert.deepEqual(probeFirstBytes(buf, "audio/mpeg")?.id3, { title: "T", artist: "A", album: "B" });
});

test("probe: truncated frame body stops iteration without inventing fields", () => {
  const tag = id3v2({ title: "Only Title", album: "Real Album" });
  // album frame header starts at 32 (10 tag + 10 frame + 12 body); corrupt its
  // size field so iteration breaks after the title frame resolves
  const broken = Buffer.from(tag);
  broken.writeUInt32BE(0x7fffffff, 36);
  const res = probeFirstBytes(broken, "audio/mpeg");
  assert.ok(res?.id3?.title === "Only Title");
  assert.equal(res?.id3?.album, null);
});

test("probe: FLAC STREAMINFO duration (180 s at 44.1 kHz)", () => {
  const res = probeFirstBytes(flacStreaminfo(44100, 44100 * 180), "audio/flac");
  assert.deepEqual(res, { flac: { durationSec: 180, sampleRate: 44100 } });
});

test("probe: junk and non-ftyp inputs yield null (never throw)", () => {
  assert.equal(probeFirstBytes(Buffer.alloc(64, 0x33), "audio/mpeg"), null);
  assert.equal(probeFirstBytes(mp4File("mp4a").subarray(4), "audio/mp4"), null);
  assert.equal(probeFirstBytes(Buffer.alloc(0), "audio/mpeg"), null);
});

test("probe: ALAC stsd detection fires, mp4a stays quiet", () => {
  assert.deepEqual(probeFirstBytes(mp4File("alac"), "audio/mp4"), { mp4: { codec: "alac", alac: true } });
  // mp4a is already the conservative label: nothing to correct
  assert.equal(probeFirstBytes(mp4File("mp4a"), "audio/x-m4a"), null);
  // moov without a stsd chain: keep the index
  const bare = Buffer.concat([mp4Box("ftyp", Buffer.from("M4A ", "latin1")), mp4Box("moov", mp4Box("trak"))]);
  assert.equal(probeFirstBytes(bare, "audio/mp4"), null);
});

test("parseTrackMeta: ID3 is strictly priority (c) behind attributes/filename", () => {
  // (a)/(b) win per field; ID3 only fills what they left null (same rule enrichRow applies)
  assert.deepEqual(
    parseTrackMeta({ attrTitle: "Attr One", id3Title: "ID3 Two", id3Artist: "ID3 Artist", album: "ID3 Album" }),
    { title: "Attr One", artist: "ID3 Artist", album: "ID3 Album" },
  );
  assert.deepEqual(parseTrackMeta({ id3Title: "Song", id3Artist: "Perf" }), { title: "Song", artist: "Perf", album: null });
});

/* ---------------------------------------------------------- token sep */

test("sign: art tokens are kind-tagged and cannot cross onto /media", () => {
  const key = Buffer.alloc(32, 7);
  const art = createArtToken("tg_n1001234567890_5", key, 60, 1_000_000);
  const media = createMediaToken("tg_n1001234567890_5", key, 60, 1_000_000);
  const live = 1_059_000; // inside exp (exp=1060s ⇒ expMs 1_060_000)
  assert.deepEqual(verifyArtToken(art, key, live), { id: "tg_n1001234567890_5", exp: 1060 });
  assert.equal(verifyMediaToken(art, key, live), null); // k:"art" rejected as media
  assert.equal(verifyArtToken(media, key, live), null); // untagged never art
  assert.ok(verifyMediaToken(media, key, live));
  // expired art token (exp 1060s ⇒ 1_060_000 ms is exactly the boundary)
  assert.equal(verifyArtToken(art, key, 1_060_000), null);
});

/* ------------------------------------------------- schema migration v1→v2 */

test("db: schema v1 databases gain hasThumb on open (ALTER + version 3)", () => {
  const dir = mkdtempSync(path.join(__dirname, "..", "tmp-m4-migrate-"));
  try {
    const p = path.join(dir, "old.sqlite");
    const seed: UpsertTrack = {
      id: "tg_n1001234567890_10",
      chatId: CHAT_ID,
      msgId: 10,
      title: "Old Row",
      artist: null,
      album: null,
      duration: 10,
      mime: "audio/mpeg",
      size: 10,
      fileName: "Old Row.mp3",
      codec: "mp3",
      container: "mp3",
      lossless: 0,
      bitrateKbps: 8,
      docId: 10,
      source: "telegram",
      filePath: null,
      hasThumb: 0,
    };
    {
      const db = openDb(p);
      createSchema(db);
      upsertTrack(db, seed);
      db.exec("ALTER TABLE tracks DROP COLUMN hasThumb");
      db.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
      db.close();
    }
    const db2 = openDb(p);
    createSchema(db2);
    const cols = db2.prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "hasThumb"), "hasThumb column restored");
    const ver = (db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;
    assert.equal(ver, "3");
    const row = getTrack(db2, seed.id);
    assert.ok(row, "row survived the migration");
    assert.equal(row?.hasThumb, 0); // default applies
    assert.equal(row?.title, "Old Row");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------- enrichment (FR-13/ALAC) */

function m4Row(over: Partial<UpsertTrack> & { msgId: number; fileName: string; mime: string }): UpsertTrack {
  const id = trackIdFor(CHAT_ID, over.msgId);
  return {
    id,
    chatId: CHAT_ID,
    title: "Enrich Target",
    artist: null,
    album: null,
    duration: null,
    size: 5_000_000,
    codec: over.codec ?? null,
    container: over.container ?? null,
    lossless: over.lossless ?? 0,
    bitrateKbps: over.bitrateKbps ?? null,
    docId: 3000 + over.msgId,
    source: "telegram",
    filePath: null,
    hasThumb: 0,
    ...over,
  };
}

function resolvedDocFor(row: UpsertTrack, thumb?: ResolvedDocument["thumb"]): ResolvedDocument {
  return {
    docId: row.docId!,
    size: row.size!,
    mime: row.mime,
    fileName: row.fileName,
    docLongId: String(9_900_000 + (row.msgId ?? 0)),
    accessHash: "seeded",
    fileReference: Buffer.alloc(24, 7),
    dcId: 2,
    ...(thumb === undefined ? {} : { thumb }),
  };
}

test("enrichment: m4a stsd=alac upgrades codec truthfully on the next stream", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    const row = m4Row({ msgId: 501, mime: "audio/mp4", fileName: "Candor Sonata.m4a", codec: "aac", container: "mp4" });
    upsertTrack(ts.db, row);
    ts.telegram.resolvedDocs.set(row.id, resolvedDocFor(row));
    const scripted = scriptedOpener(mp4File("alac"));
    ts.telegram.windowOpener = scripted.opener;

    // first stream: conservative aac label (§4.5), probe happens in background
    const first = await fetchJson(ts, `/${S}/stream/${row.id}`);
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { codec?: string; quality?: string };
    assert.equal(firstBody.codec, "aac");
    assert.notEqual(firstBody.quality, "LOSSLESS");
    await until(() => getTrack(ts.db, row.id)?.codec === "alac");
    const updated = getTrack(ts.db, row.id);
    assert.equal(updated?.lossless, 1);
    assert.equal(updated?.bitrateKbps, null);
    assert.equal(updated?.container, "mp4");

    // probe ran exactly once
    assert.equal(scripted.calls.length, 1);
    assert.equal(scripted.calls[0]?.offset, 0);

    // second stream now reports the truthful descriptor
    const second = await fetchJson(ts, `/${S}/stream/${row.id}`);
    const secondBody = (await second.json()) as { codec?: string; quality?: string };
    assert.equal(secondBody.codec, "alac");
  // quality tracks the established §4.3 shape ("Lossless · FLAC" ⇒ ALAC variant)
  assert.equal(secondBody.quality, "Lossless · ALAC");
    assert.equal(scripted.calls.length, 1); // still exactly one probe per process
  } finally {
    await ts.cleanup();
  }
});

test("enrichment: ID3 fills missing album/artist, keeps priority-(a) values, probes once", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    const row = m4Row({
      msgId: 502,
      mime: "audio/mpeg",
      fileName: "Fall Through - Enrich Target.mp3",
      codec: "mp3",
      container: "mp3",
    });
    upsertTrack(ts.db, row);
    ts.telegram.resolvedDocs.set(row.id, resolvedDocFor(row));
    const scripted = scriptedOpener(id3v2({ title: "Ignored ID3 Title", artist: "Aurora Veil", album: "Silent Parade" }));
    ts.telegram.windowOpener = scripted.opener;

    const res = await fetchJson(ts, `/${S}/stream/${row.id}`);
    assert.equal(res.status, 200);
    await until(() => getTrack(ts.db, row.id)?.album === "Silent Parade");
    const updated = getTrack(ts.db, row.id);
    // title keeps the (b)-derived value; artist was null so ID3 (c) fills it
    assert.equal(updated?.title, "Enrich Target");
    assert.equal(updated?.artist, "Aurora Veil");
    assert.equal(updated?.album, "Silent Parade");

    // second stream: no second probe
    await fetchJson(ts, `/${S}/stream/${row.id}`);
    assert.equal(scripted.calls.length, 1);
  } finally {
    await ts.cleanup();
  }
});

test("enrichment: existing artist is never overwritten by ID3 (priority order)", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    const row = m4Row({
      msgId: 503,
      mime: "audio/mpeg",
      artist: "Telegram Archive",
      fileName: "Enrich Target.mp3",
      codec: "mp3",
      container: "mp3",
    });
    upsertTrack(ts.db, row);
    ts.telegram.resolvedDocs.set(row.id, resolvedDocFor(row));
    ts.telegram.windowOpener = scriptedOpener(id3v2({ artist: "ID3 Artist", album: "Only Album" })).opener;
    const res = await fetchJson(ts, `/${S}/stream/${row.id}`);
    assert.equal(res.status, 200);
    await until(() => getTrack(ts.db, row.id)?.album === "Only Album");
    assert.equal(getTrack(ts.db, row.id)?.artist, "Telegram Archive");
  } finally {
    await ts.cleanup();
  }
});

test("enrichment: plain-document FLAC gains duration from STREAMINFO (FR-13 P1)", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    const row = m4Row({
      msgId: 504,
      mime: "audio/flac",
      fileName: "Enrich Target.flac",
      codec: "flac",
      container: "flac",
      lossless: 1,
      duration: null,
    });
    upsertTrack(ts.db, row);
    ts.telegram.resolvedDocs.set(row.id, resolvedDocFor(row));
    ts.telegram.windowOpener = scriptedOpener(flacStreaminfo(44100, 44100 * 95)).opener;
    const res = await fetchJson(ts, `/${S}/stream/${row.id}`);
    assert.equal(res.status, 200);
    await until(() => getTrack(ts.db, row.id)?.duration === 95);
    assert.equal(getTrack(ts.db, row.id)?.duration, 95);
  } finally {
    await ts.cleanup();
  }
});

/* --------------------------------------------------------- /art (FR-12) */

test("/art: absolute artworkURL on search rows, stripped-bytes 200/304/HEAD, token discipline", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    const row = m4Row({
      msgId: 505,
      mime: "audio/mpeg",
      fileName: "Enrich Target.mp3",
      codec: "mp3",
      container: "mp3",
      hasThumb: 1,
    });
    upsertTrack(ts.db, row);
    const stripped = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x42]);
    ts.telegram.resolvedDocs.set(row.id, resolvedDocFor(row, { type: "i", size: stripped.length, stripped }));
    ts.telegram.windowOpener = scriptedOpener(Buffer.alloc(0)).opener;

    const search = await fetchJson(ts, `/${S}/search?q=Enrich%20Target`);
    assert.equal(search.status, 200);
    const body = (await search.json()) as { tracks: Array<Record<string, unknown>> };
    const hit = body.tracks.find((t) => t.id === row.id);
    assert.ok(hit, "search must return the seeded row");
    const artworkURL = typeof hit["artworkURL"] === "string" ? (hit["artworkURL"] as string) : null;
    assert.ok(artworkURL, "hasThumb=1 rows carry absolute artworkURL");
    assert.ok(artworkURL.startsWith(`${ts.baseUrl}/art/`), `absolute URL: ${artworkURL}`);
    assert.equal(artworkURL.includes(S), false, "no secret prefix in artwork URLs (§4.8)");

    const artRes = await fetch(artworkURL);
    assert.equal(artRes.status, 200);
    assert.equal(artRes.headers.get("content-type"), "image/jpeg");
    assert.equal(artRes.headers.get("cache-control"), "private, max-age=86400");
    const etag = artRes.headers.get("etag");
    assert.ok(etag);
    assert.deepEqual(Buffer.from(await artRes.arrayBuffer()), stripped); // zero-RPC inline bytes
    assert.deepEqual(
      etag,
      etagFor(row.docId!, stripped.length),
    );

    // conditional request: If-None-Match → 304 empty
    const notModified = await fetch(artworkURL, { headers: { "if-none-match": etag! } });
    assert.equal(notModified.status, 304);
    assert.equal((await notModified.arrayBuffer()).byteLength, 0);

    // HEAD carries headers with no body
    const head = await fetch(artworkURL, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), stripped.length);

    // a media token is never an art token (kind separation)
    const base = ts.baseUrl;
    const artPart = artworkURL.slice(`${base}/art/`.length);
    const mediaToken = createMediaToken(row.id, ts.cfg.mediaSigningKey, 300);
    const mediaAsArt = await fetch(`${base}/art/${mediaToken}`);
    assert.equal(mediaAsArt.status, 403);
    assert.equal((await mediaAsArt.text()), "{}");
    // garbage token is 403 with empty body
    assert.equal((await fetch(`${base}/art/garbage.token`)).status, 403);

    // a thumbless resolved doc → 404 (real miss)
    const bareRow = m4Row({ msgId: 506, mime: "audio/mpeg", fileName: "Enrich Target.mp3", hasThumb: 1 });
    upsertTrack(ts.db, bareRow);
    ts.telegram.resolvedDocs.set(bareRow.id, resolvedDocFor(bareRow)); // no thumb
    const artToken = createArtToken(bareRow.id, ts.cfg.mediaSigningKey, 300);
    assert.equal((await fetch(`${base}/art/${artToken}`)).status, 404);
    assert.equal((await fetch(`${base}/art/${artPart}`)).status, 200); // original still fine
  } finally {
    await ts.cleanup();
  }
});

test("/art: streams renditions for regular photo thumbs through the bridge", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    ts.telegram.forceState("ready", "scripted");
    const row = m4Row({
      msgId: 507,
      mime: "audio/mpeg",
      fileName: "Enrich Target.mp3",
      codec: "mp3",
      container: "mp3",
      hasThumb: 1,
    });
    upsertTrack(ts.db, row);
    const jpeg = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0x33, 0x44, 0x99]);
    ts.telegram.resolvedDocs.set(row.id, resolvedDocFor(row, { type: "y", size: jpeg.length, stripped: null }));
    const scripted = scriptedOpener(jpeg);
    ts.telegram.windowOpener = scripted.opener;

    const artToken = createArtToken(row.id, ts.cfg.mediaSigningKey, 300);
    const res = await fetch(`${ts.baseUrl}/art/${artToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(Number(res.headers.get("content-length")), jpeg.length);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg);
    assert.deepEqual(scripted.calls[0], { offset: 0, thumbSize: "y" });
  } finally {
    await ts.cleanup();
  }
});

test("/art and search: fixture rows and thumbless documents never expose artwork", async () => {
  const ts: TestServer = await buildTestServer({ logLevel: "error" });
  try {
    const fixtureRow = ts.tracks[0]!;
    const search = await fetchJson(ts, `/${S}/search?q=${encodeURIComponent(fixtureRow.title.split(" ")[0]!)}`);
    const body = (await search.json()) as { tracks: Array<Record<string, unknown>> };
    const hit = body.tracks.find((t) => t.id === fixtureRow.id);
    assert.ok(hit);
    assert.equal("artworkURL" in hit, false);

    // hasThumb=1 row but source=fixture: artwork unknown → the 404 guard holds
    const token = createArtToken(fixtureRow.id, ts.cfg.mediaSigningKey, 300);
    assert.equal((await fetch(`${ts.baseUrl}/art/${token}`)).status, 404);
  } finally {
    await ts.cleanup();
  }
});
