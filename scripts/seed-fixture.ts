/**
 * M0 fixture generator + seeder.
 *
 * Creates six playable audio files under test/fixtures/generated/ (ffmpeg if
 * available; deterministic pseudo-random bytes otherwise) and upserts them
 * into the SQLite index as `source: "fixture"` tracks on a stable fake chat
 * (chatId -1001234567890 -> peer key n1001234567890, msgIds 1..6).
 *
 * Run with `npm run seed`. Idempotent: re-running replaces the same rows.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb, createSchema, upsertTrack } from "../src/db.js";
import { trackIdFor, parseTrackMeta, audioDescriptor } from "../src/indexer.js";

const ROOT = process.cwd(); // npm run seed executes from the package root
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "generated");
export const CHAT_ID = -1001234567890; // §6 M0: stable fake channel
const DURATION = 30; // seconds of generated audio

interface FixtureSpec {
  msgId: number;
  /** Noisy filename on purpose — exercises §4.6.2 title cleaning. */
  fileName: string;
  mime: string;
  caption: string | null;
  album: string | null;
  /** Deterministic size used when ffmpeg is unavailable (bitrate math). */
  prngSize: number;
  /** ffmpeg encoder args (after the lavfi input). */
  enc: string[];
  /** Only materialized when seeding from PRNG (test runs). */
  prngOnly?: boolean;
}

const SPECS: FixtureSpec[] = [
  {
    msgId: 1,
    fileName: "01 - Aurora Veil - Midnight Glass [24Bit Lossless] (FLAC).flac",
    mime: "audio/flac",
    caption: "t.me/auroraveil • FLAC rip",
    album: "Prism Drive",
    prngSize: 2_000_000,
    enc: ["-c:a", "flac"],
  },
  {
    msgId: 2,
    fileName: "Aurora Veil - Midnight Glass (320 kbps CBR @veilmusic).mp3",
    mime: "audio/mpeg",
    caption: null,
    album: null,
    prngSize: Math.round((320_000 / 8) * DURATION), // -> 320 kbps -> HIGH
    enc: ["-c:a", "libmp3lame", "-b:a", "320k"],
  },
  {
    msgId: 3,
    fileName: "02-Cinder & the Stove Slim Pale Hue.mp3",
    mime: "audio/mpeg",
    caption: "Cinder & the Stove - Slim Pale Hue (96kbps radio grab)",
    album: null,
    prngSize: Math.round((96_000 / 8) * DURATION), // -> 96 kbps -> LOW
    enc: ["-c:a", "libmp3lame", "-b:a", "96k"],
  },
  {
    msgId: 4,
    fileName: "03 - Novalee Campo - Tide Radio Edit.v1.wav",
    mime: "audio/wav",
    caption: null,
    album: null,
    prngSize: 5_292_000,
    enc: ["-c:a", "pcm_s16le"],
  },
  {
    msgId: 5,
    fileName: "Novalee Campo - Tide Radio Edit.1.m4a",
    mime: "audio/x-m4a",
    caption: null,
    album: "Shore Signal",
    prngSize: Math.round((128_000 / 8) * DURATION),
    enc: ["-c:a", "aac", "-b:a", "128k"],
  },
  {
    msgId: 6,
    fileName: "04 - Kettle Bell Choir - Hum Lapel (Live) [V0].opus",
    mime: "audio/opus",
    caption: null,
    album: null,
    prngSize: Math.round((96_000 / 8) * DURATION),
    enc: ["-c:a", "libopus", "-b:a", "96k"],
  },
  // Test-only oversized fixtures (never ffmpeg-generated): big enough that
  // loopback buffers cannot swallow them, so client backpressure reliably
  // stalls the server mid-file (realistic byte-stream behaviour).
  {
    msgId: 7,
    fileName: "09 - Buffertest Choir - Longform Drain Guard.mp3",
    mime: "audio/mpeg",
    caption: null,
    album: null,
    prngSize: 40_000_000,
    enc: ["-c:a", "libmp3lame", "-b:a", "320k"],
    prngOnly: true,
  },
  {
    msgId: 8,
    fileName: "10 - Buffertest Choir - Longform Drain Party.mp3",
    mime: "audio/mpeg",
    caption: null,
    album: null,
    prngSize: 40_000_000,
    enc: ["-c:a", "libmp3lame", "-b:a", "320k"],
    prngOnly: true,
  },
];

/** FNV-1a 32-bit over the track id — stable positive docId for fixtures. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic PRNG bytes (mulberry32) so byte tests are reproducible. */
function prngFile(filePath: string, size: number, seed: number): void {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const buf = Buffer.alloc(size);
  const words = size >>> 2;
  for (let i = 0; i < words; i++) buf.writeUInt32LE(next(), i * 4);
  for (let i = words * 4; i < size; i++) buf[i] = next() & 0xff;
  writeFileSync(filePath, buf);
}

function ffmpegGenerate(filePath: string, spec: FixtureSpec): boolean {
  const res = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION}:sample_rate=44100`,
      "-ac", "2",
      ...spec.enc,
      filePath,
    ],
    { stdio: "pipe" },
  );
  if (res.error || res.status !== 0 || !existsSync(filePath)) return false;
  return statSync(filePath).size > 10_000;
}

/** Generates fixture files into `dir` and upserts them into an open db. */
export function seedFixtureDb(
  db: ReturnType<typeof openDb>,
  dir: string,
  opts: { quiet?: boolean; useFfmpeg?: boolean; includePrngOnly?: boolean } = {},
): void {
  mkdirSync(dir, { recursive: true });
  const hasFfmpeg = (opts.useFfmpeg ?? true) && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (!hasFfmpeg && !opts.quiet) {
    console.warn("ffmpeg not found — writing deterministic PRNG fixtures (tests still pass).");
  }

  for (const spec of SPECS) {
    if (spec.prngOnly && !opts.includePrngOnly) continue;
    const id = trackIdFor(CHAT_ID, spec.msgId);
    const filePath = path.join(dir, `${spec.msgId}${path.extname(spec.fileName)}`);
    let generated = false;
    if (!spec.prngOnly) generated = hasFfmpeg && ffmpegGenerate(filePath, spec);
    if (!generated) prngFile(filePath, spec.prngSize, fnv1a(id));
    const meta = parseTrackMeta({
      fileName: spec.fileName,
      caption: spec.caption,
      album: spec.album,
    });
    if (!meta) throw new Error(`no title parsed for ${spec.fileName}`);
    const size = statSync(filePath).size;
    const d = audioDescriptor(spec.mime, spec.fileName, size, DURATION);
    upsertTrack(db, {
      id,
      chatId: CHAT_ID,
      msgId: spec.msgId,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      duration: DURATION,
      mime: spec.mime,
      size,
      fileName: spec.fileName,
      codec: d.codec,
      container: d.container,
      lossless: d.lossless ? 1 : 0,
      bitrateKbps: d.bitrateKbps,
      docId: fnv1a(id),
      source: "fixture",
      filePath,
    });
    if (!opts.quiet) {
      console.log(
        `seeded ${id}  ${meta.artist ?? "?"} — ${meta.title}  [${d.codec ?? "?"}/${d.container ?? "?"}] ${size} bytes`,
      );
    }
  }
}

function main(): void {
  const dbPath = process.env.DB_PATH || path.join(ROOT, "data", "index.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  const db = openDb(dbPath);
  createSchema(db);
  seedFixtureDb(db, FIXTURE_DIR);
  const n = SPECS.filter((s) => !s.prngOnly).length;
  db.close();
  console.log(`\n${n} fixture tracks seeded into ${dbPath}`);
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("seed-fixture.ts") || process.argv[1].endsWith("seed-fixture.js"));
if (invokedAsScript) main();
