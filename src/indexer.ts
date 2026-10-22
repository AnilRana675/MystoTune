/**
 * Index-time transforms — §4.6 (source filter, metadata priority, title
 * cleaning), §4.5 (format/quality mapping), §4.3 (id scheme).
 * M0: pure helpers. The Telegram sync/reconcile loop lands in M1 (FR-14)
 * using the per-chat cursors in db.ts.
 */

/** id = tg_{peerKey}_{msgId}; peer key is the signed chat id with "-" written as "n" (§4.3). */
export function parseTrackId(id: string): { chatId: number; msgId: number } | null {
  const m = /^tg_(n?)(\d+)_(\d+)$/.exec(id);
  if (!m) return null;
  const chatId = m[1] ? -Number(m[2]) : Number(m[2]);
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  return { chatId, msgId: Number(m[3]) };
}

export function peerKeyForChat(chatId: number): string {
  return chatId < 0 ? `n${-chatId}` : String(chatId);
}

export function trackIdFor(chatId: number, msgId: number): string {
  return `tg_${peerKeyForChat(chatId)}_${msgId}`;
}

/* ------------------------------------------------------------ title cleaning */

const NOISE_KEYWORD = "kbps|320|192|128|bit|flac|mp3|wav|aac|ogg|lossless|lossy|hq|vbr|explicit";
const NOISE_TAGS: RegExp[] = [
  // [320kbps], [FLAC], [320], [Lossless], [V0]… bracketed junk only
  new RegExp(`\\[[^\\[\\]\\n]*(?:${NOISE_KEYWORD})[^\\[\\]\\n]*\\]`, "gi"),
  // (FLAC), (320 kbps), (Explicit)… bracketed junk only (live/remix kept, §4.14)
  new RegExp(`\\([^()\\n]*(?:${NOISE_KEYWORD})[^()]*\\)`, "gi"),
  // @channel handles, t.me/... links, stray ellipsis
  /\b(?:t\.me\/|telegram\.me\/)\S+/gi,
  /\bhttps?:\/\/\S+/gi,
  /@\S+/g,
  /\u2026/g,
];

const KNOWN_EXT = /\.(flac|mp3|wav|m4a|aac|ogg|opus|alac|aiff|wma)$/i;

/**
 * §4.14 rules: strip ext, underscores -> spaces, drop leading numbers,
 * remove bitrate/format tags, @handles and t.me links, then trim.
 * live/remix/edit/instrumental markers are intentionally kept (§4.14).
 */
export function cleanName(base: string | null | undefined): string | null {
  if (!base) return null;
  let s = base.trim();
  const dot = s.lastIndexOf(".");
  if (dot > 0 && KNOWN_EXT.test(s.slice(dot).toLowerCase())) s = s.slice(0, dot);
  s = s.replace(/_/g, " ");
  for (const rx of NOISE_TAGS) s = s.replace(rx, " ");
  s = s.replace(/^\s*\d{1,3}\s*[.\-_–)]\s*/, ""); // "01 - ", "1.", "02-"
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\-–—:,.]+/, "").replace(/[\-–—:,.]+$/, "").trim();
  return s.length ? s : null;
}

export interface ParsedMeta {
  title: string;
  artist: string | null;
  album: string | null;
}

export interface MetaInput {
  /** DocumentAttributeAudio.title */
  attrTitle?: string | null;
  /** DocumentAttributeAudio.performer */
  attrPerformer?: string | null;
  fileName?: string | null;
  caption?: string | null;
  /** optional ID3 probe result (FR-13) — priority (c), fills what (a)/(b) missed */
  album?: string | null;
  id3Title?: string | null;
  id3Artist?: string | null;
}

/**
 * Metadata priority (§4.6.2):
 * (a) attribute title + performer (junk cleaned);
 * (b) caption/filename parsed as "Artist - Title" when (a) is missing/partial.
 */
export function parseTrackMeta(input: MetaInput): ParsedMeta | null {
  let title = cleanName(input.attrTitle);
  let artist: string | null = input.attrPerformer ? cleanName(input.attrPerformer) : null;

  let fallbackBase = cleanName(input.fileName) ?? cleanName(input.caption);
  // "Aurora Veil - Midnight Glass (320 kbps).mp3" parses fine from the file
  // name, but "02-Slim Pale Hue.mp3" does not: in that case fall back to an
  // "Artist - Title" caption when the file name had no usable separator.
  if (fallbackBase && !/ - /.test(fallbackBase)) {
    const capBase = cleanName(input.caption);
    if (capBase && / - /.test(capBase)) fallbackBase = capBase;
  }
  if (fallbackBase && (!title || !artist)) {
    const dash = fallbackBase.indexOf(" - ");
    if (dash > 0) {
      if (!artist) artist = fallbackBase.slice(0, dash).trim() || null;
      if (!title) title = fallbackBase.slice(dash + 3).trim() || null;
    }
  }
  if (!title && fallbackBase) title = fallbackBase;
  // (c) FR-13 ID3 fills — strictly after (a)/(b)
  if (!title && input.id3Title) title = cleanName(input.id3Title) ?? title;
  if (!artist && input.id3Artist) artist = cleanName(input.id3Artist) ?? artist;
  if (!title) return null;
  return { title, artist, album: input.album ?? null };
}

/* --------------------------------------------------------------- §4.5 mapping */

export interface AudioDescriptor {
  codec: string | null; // mp3 | flac | pcm | aac | opus | alac | null (unknown until probed)
  container: string | null; // mp3 | flac | wav | mp4 | aac | ogg — accurate even when codec is null
  lossless: boolean;
  /** size×8/duration in kbps; null when lossless or unknown (§4.5). */
  bitrateKbps: number | null;
}

const KNOWN_TYPES: Record<string, AudioDescriptor> = {
  "audio/mpeg": { codec: "mp3", container: "mp3", lossless: false, bitrateKbps: null },
  "audio/flac": { codec: "flac", container: "flac", lossless: true, bitrateKbps: null },
  "audio/x-flac": { codec: "flac", container: "flac", lossless: true, bitrateKbps: null },
  "audio/wav": { codec: "pcm", container: "wav", lossless: true, bitrateKbps: null },
  "audio/x-wav": { codec: "pcm", container: "wav", lossless: true, bitrateKbps: null },
  "audio/mp4": { codec: "aac", container: "mp4", lossless: false, bitrateKbps: null },
  "audio/x-m4a": { codec: "aac", container: "mp4", lossless: false, bitrateKbps: null },
  "audio/aac": { codec: "aac", container: "aac", lossless: false, bitrateKbps: null },
  // §4.5: ogg may be Vorbis or Opus; without a probe, omit codec, keep container.
  "audio/ogg": { codec: null, container: "ogg", lossless: false, bitrateKbps: null },
  "audio/opus": { codec: "opus", container: "ogg", lossless: false, bitrateKbps: null },
};

const EXT_TYPES: Record<string, AudioDescriptor> = {
  flac: KNOWN_TYPES["audio/flac"]!,
  mp3: KNOWN_TYPES["audio/mpeg"]!,
  wav: KNOWN_TYPES["audio/wav"]!,
  m4a: KNOWN_TYPES["audio/x-m4a"]!,
  aac: KNOWN_TYPES["audio/aac"]!,
  ogg: KNOWN_TYPES["audio/ogg"]!,
  opus: KNOWN_TYPES["audio/opus"]!,
  // ALAC is detectable only by probing (FR-13/M4); until then .m4a stays aac.
  alac: { codec: "alac", container: "m4a", lossless: true, bitrateKbps: null },
  aiff: { codec: "pcm", container: "aiff", lossless: true, bitrateKbps: null },
};

export function audioDescriptor(
  mime: string | null | undefined,
  fileName: string | null | undefined,
  size: number | null,
  duration: number | null,
  /**
   * Probed codec correction (FR-13/M4). Only ever UPGRADES a conservative
   * label: a probed ALAC payload in an .m4a flips codec to alac/lossless —
   * ADTS (container "aac") cannot carry ALAC and is left untouched.
   */
  knownCodec?: string | null,
): AudioDescriptor {
  let d = mime ? KNOWN_TYPES[mime.toLowerCase()] : undefined;
  if (!d && fileName) {
    const ext = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    if (ext) d = EXT_TYPES[ext];
  }
  const lossyKbps = size && duration ? Math.round((size * 8) / duration / 1000) : null;
  if (!d) {
    return { codec: null, container: null, lossless: false, bitrateKbps: lossyKbps };
  }
  if (knownCodec === "alac" && d.container === "mp4") {
    return { codec: "alac", container: "mp4", lossless: true, bitrateKbps: null };
  }
  return { ...d, bitrateKbps: d.lossless ? null : lossyKbps };
}

export type AudioQuality = "LOSSLESS" | "HIGH" | "LOW";

/** §4.5: HIGH at ≥224 kbps effective, otherwise LOW; unknown duration -> LOW. */
export function audioQuality(d: AudioDescriptor): AudioQuality {
  if (d.lossless) return "LOSSLESS";
  if (d.bitrateKbps === null) return "LOW";
  return d.bitrateKbps >= 224 ? "HIGH" : "LOW";
}

/** "format" per row/spec examples: codec when known, else ext, else mime subtype, else container. */
export function formatOf(d: AudioDescriptor, fileName: string | null | undefined, mime: string | null | undefined): string | null {
  if (d.codec) {
    // WAV rows carry codec "pcm"; BitChord treats pcm as an unknown codec and
    // falls back to the container anyway — advertise "wav" so the format is
    // meaningful to clients that read it directly (§4.3).
    if (d.codec.toLowerCase() === "pcm" && (d.container === "wav" || /\.wav$/i.test(fileName ?? ""))) {
      return "wav";
    }
    return d.codec;
  }
  if (fileName) {
    const ext = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    if (ext) return ext;
  }
  if (mime) {
    const sub = mime.match(/^audio\/(?:x-)?([\w-]+)/i)?.[1]?.toLowerCase();
    if (sub) return sub;
  }
  return d.container;
}

/** "quality" field for /stream (§4.3 example: "Lossless · FLAC"). */
export function qualityLabel(d: AudioDescriptor): string {
  if (d.lossless && d.codec) return `Lossless · ${d.codec.toUpperCase()}`;
  if (d.lossless) return "Lossless";
  if (d.codec) return `Lossy · ${d.codec.toUpperCase()}`;
  return "Lossy";
}

/* =========================================================== M1 sync path (§4.6) */

import type { UpsertTrack } from "./db";

/**
 * A Telegram document message reduced to the fields the indexer needs. The
 * GramJS adapter (src/telegram.ts) produces these; this module stays pure so
 * the transform is unit-testable without a live client.
 */
export interface RawDocMessage {
  chatId: number;
  msgId: number;
  /** doc id, 64-bit as decimal string */
  docId: string;
  mime: string | null;
  size: number | null;
  fileName: string | null;
  attrTitle: string | null;
  attrPerformer: string | null;
  duration: number | null;
  voice: boolean;
  /** message text (media caption in Telegram terms) */
  caption: string | null;
  /** FR-12: the document carries at least one thumbnail */
  hasThumb: boolean;
}

/**
 * TrackRow.docId is a Number (SQLite integer). Telegram doc ids are 64-bit;
 * values past 2^53 collapse into a stable fnv1a-32 hash. docId only feeds
 * ETag "{docId}-{size}" and LRU keys — identity is the track id itself (§4.3).
 */
export function docIdFromLong(id: string | number | null | undefined): number {
  const s = id === null || id === undefined ? "" : String(id);
  if (!s) return 0;
  if (s.length <= 15 && /^[0-9]+$/.test(s)) return Number(s); // exact below 2^53
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/** mime or file extension qualifies the doc as audio post-filter material (§4.6). */
export function looksLikeAudio(mime: string | null | undefined, fileName: string | null | undefined): boolean {
  if (mime && (mime === "audio/mpeg" || mime.startsWith("audio/"))) return true;
  if (fileName && /\.(flac|mp3|wav|m4a|aac|ogg|opus|alac|aiff|wma)$/i.test(fileName)) return true;
  return false;
}

/**
 * Convert one raw document message into an index row, or null to skip (§4.6):
 * voice notes skipped, non-audio docs skipped (music+doc filters are polluted),
 * messages without a derivable title skipped. Metadata priority §4.6.2.
 */
export function transformDocumentMessage(raw: RawDocMessage): UpsertTrack | null {
  if (raw.voice) return null; // §4.7: voice notes are never music
  if (!looksLikeAudio(raw.mime, raw.fileName)) return null;
  const meta = parseTrackMeta({
    attrTitle: raw.attrTitle,
    attrPerformer: raw.attrPerformer,
    fileName: raw.fileName,
    caption: raw.caption,
  });
  if (!meta) return null;
  const d = audioDescriptor(raw.mime, raw.fileName, raw.size, raw.duration);
  return {
    id: trackIdFor(raw.chatId, raw.msgId),
    chatId: raw.chatId,
    msgId: raw.msgId,
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    duration: raw.duration,
    mime: raw.mime,
    size: raw.size,
    fileName: raw.fileName,
    codec: d.codec,
    container: d.container,
    lossless: d.lossless ? 1 : 0,
    bitrateKbps: d.bitrateKbps,
    docId: docIdFromLong(raw.docId),
    source: "telegram",
    filePath: null,
    hasThumb: raw.hasThumb ? 1 : 0,
  };
}
