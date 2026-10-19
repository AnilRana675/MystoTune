/**
 * Deep byte probes (FR-13, M4) — pure parsers over the FIRST 64 KB of a
 * file, no network and no Telegram imports:
 *
 *   MP3  → ID3v2 tags: TIT2/TPE1/TALB (metadata priority §4.6.2 (c): fills
 *          what (a)/(b) could not provide; album is the usual win).
 *   FLAC → STREAMINFO: duration = totalSamples / sampleRate.
 *   MP4  → stsd entry: 'alac' ⇒ codec alac + lossless (§4.5: an .m4a may
 *          actually contain ALAC; without probing report aac conservatively).
 *
 * Everything here is best-effort: malformed data yields null, never throws.
 */

export interface ProbeResult {
  /** ID3 fills — metadata priority (c): only used when (a)/(b) came up empty */
  id3?: { title: string | null; artist: string | null; album: string | null };
  /** FLAC STREAMINFO result */
  flac?: { durationSec: number | null; sampleRate: number | null };
  /** MP4 stsd codec correction */
  mp4?: { codec: string | null; alac: boolean };
}

const MAX_TEXT = 4096; // sanity cap for one ID3 text frame

function swapPairs(b: Buffer): Buffer {
  const out = Buffer.from(b);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = t;
  }
  return out;
}

function decodeText(raw: Buffer, enc: number): string | null {
  try {
    let out: string;
    if (enc === 1 || enc === 2) {
      let b = raw;
      // BOM (enc 1) or declared big-endian (enc 2) → normalize to utf16le
      if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) b = swapPairs(b.subarray(2));
      else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) b = b.subarray(2);
      else if (enc === 2) b = swapPairs(b);
      out = b.toString("utf16le");
    } else if (enc === 3) out = raw.toString("utf8");
    else out = raw.toString("latin1");
    return out.replace(/\0+$/g, "").trim() || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- ID3v2 */

function decodeId3FrameText(body: Buffer): string | null {
  if (body.length < 1) return null;
  return decodeText(body.subarray(1), body[0]!);
}

/**
 * Parse an ID3v2 tag (2.2/2.3/2.4). Only the TIT2(TT2)/TPE1(TP1)/TALB(TAL)
 * text frames interest FR-13; unknown frames are skipped by size.
 */
function parseId3(buf: Buffer): ProbeResult["id3"] | null {
  if (buf.length < 10) return null;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null; // "ID3"
  const major = buf[3]!;
  if (major !== 2 && major !== 3 && major !== 4) return null;
  // synchsafe 32-bit tag size: 4×7-bit groups
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const end = Math.min(10 + size, buf.length);
  let pos = 10;
  // extended header (flag 0x40): skip it; v2.3 stores the 4-byte size BEFORE
  // the count, v2.4 stores the size including those 4 bytes (§ID3v2.4 6.1)
  if ((buf[5]! & 0x40) !== 0) {
    const extSize = ((buf[pos]! & 0x7f) << 21) | ((buf[pos + 1]! & 0x7f) << 14) | ((buf[pos + 2]! & 0x7f) << 7) | (buf[pos + 3]! & 0x7f);
    pos += major === 4 ? extSize : 6 + extSize;
    pos = Math.min(pos, end);
  }

  let title: string | null = null;
  let artist: string | null = null;
  let album: string | null = null;

  while (pos + (major === 2 ? 6 : 10) <= end) {
    if (buf[pos] === 0) break; // padding
    let id: string;
    let fsize: number;
    if (major === 2) {
      id = buf.subarray(pos, pos + 3).toString("latin1");
      fsize = (buf[pos + 3]! << 16) | (buf[pos + 4]! << 8) | buf[pos + 5]!;
      pos += 6;
    } else {
      id = buf.subarray(pos, pos + 4).toString("latin1");
      if (major === 4) {
        fsize =
          ((buf[pos + 4]! & 0x7f) << 21) | ((buf[pos + 5]! & 0x7f) << 14) | ((buf[pos + 6]! & 0x7f) << 7) | (buf[pos + 7]! & 0x7f);
      } else {
        fsize = (buf[pos + 4]! << 24) | (buf[pos + 5]! << 16) | (buf[pos + 6]! << 8) | buf[pos + 7]!;
      }
      pos += 10;
    }
    if (fsize <= 0 || pos + fsize > end) break;
    const body = buf.subarray(pos, pos + fsize);
    if (id === "TIT2" || id === "TT2") title ??= decodeId3FrameText(body);
    else if (id === "TPE1" || id === "TP1") artist ??= decodeId3FrameText(body);
    else if (id === "TALB" || id === "TAL") album ??= decodeId3FrameText(body);
    pos += fsize;
  }
  if (!title && !artist && !album) return null;
  const cap = (s: string | null): string | null => {
    if (!s) return null;
    const t = s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
    return t || null;
  };
  return { title: cap(title), artist: cap(artist), album: cap(album) };
}

/* -------------------------------------------------------------------- FLAC */

function parseFlac(buf: Buffer): ProbeResult["flac"] | null {
  if (buf.length < 26) return null;
  if (buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return null; // "fLaC"
  if ((buf[4]! & 0x7f) !== 0) return null; // block type 0 = STREAMINFO must be first
  if (buf[5]! !== 0 || buf[6]! !== 0 || buf[7]! !== 34) return null; // mandatory 34-byte block
  // big-endian bit assembly over the 18-byte STREAMINFO body. FP arithmetic
  // keeps 36-bit counts exact (32-bit shifts would overflow).
  const body = buf.subarray(8, 8 + 18);
  const readBits = (startBit: number, width: number): number => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = Math.floor((startBit + i) / 8);
      const bitIdx = (startBit + i) % 8;
      v = v * 2 + ((body[byte]! >> (7 - bitIdx)) & 1);
    }
    return v;
  };
  const sampleRate = readBits(80, 20); // after min/max block + min/max frame = 80 bits
  const channels = readBits(100, 3) + 1;
  void channels;
  const totalSamples = readBits(108, 36);
  const durationSec = sampleRate > 0 && totalSamples > 0 ? Math.round(totalSamples / sampleRate) : null;
  return { durationSec, sampleRate: sampleRate > 0 ? sampleRate : null };
}

/* --------------------------------------------------------------------- MP4 */

function boxSize(buf: Buffer, pos: number): number | null {
  if (pos + 8 > buf.length) return null;
  const size = (buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!;
  if (size === 1) {
    // 64-bit largesize follows the 4-byte type
    if (pos + 16 > buf.length) return null;
    const big = buf.readBigUInt64BE(pos + 8);
    return big > 0xffff_ffffn ? null : Number(big);
  }
  return size === 0 ? buf.length - pos : size; // 0 = runs to EOF
}

function boxType(buf: Buffer, pos: number): string {
  return buf.subarray(pos + 4, pos + 8).toString("latin1");
}

/** Walk [start..end) child boxes looking for `name`; returns its BODY span. */
function findBox(buf: Buffer, start: number, end: number, name: string): [number, number] | null {
  let pos = start;
  while (pos + 8 <= end) {
    const size = boxSize(buf, pos);
    if (size === null || size < 8 || pos + size > end) return null;
    if (boxType(buf, pos) === name) return [pos + 8, pos + size];
    pos += size;
  }
  return null;
}

const MP4_STSD_MISSING: { codec: string | null; alac: boolean } = { codec: null, alac: false };

/** moov → trak → mdia → minf → stbl → stsd → first sample entry's codec. */
function parseMp4Codec(buf: Buffer): ProbeResult["mp4"] | null {
  if (buf.length < 12) return null;
  if (boxType(buf, 0) !== "ftyp") return null;
  let span: [number, number] | null = [0, buf.length];
  for (const name of ["moov", "trak", "mdia", "minf", "stbl", "stsd"]) {
    if (!span) return MP4_STSD_MISSING;
    span = findBox(buf, span[0], span[1], name);
  }
  if (!span) return MP4_STSD_MISSING;
  // stsd body: 4b version/flags + 4b entry count, then the first sample entry
  const entryStart = span[0] + 8;
  if (entryStart + 8 > span[1]) return MP4_STSD_MISSING;
  const codec = boxType(buf, entryStart);
  if (/^[a-z0-9 \xa0]{3,4}$/i.test(codec.toLowerCase())) {
    return { codec: codec.toLowerCase() === "mp4a" ? "aac" : codec.toLowerCase(), alac: codec.toLowerCase() === "alac" };
  }
  return MP4_STSD_MISSING;
}

/* ---------------------------------------------------------------- dispatch */

/**
 * Probe the first bytes of one file. Returns null when the buffer does not
 * look like one of the supported formats (callers keep the index as-is).
 */
export function probeFirstBytes(buf: Buffer, mime: string | null | undefined): ProbeResult | null {
  if (!buf || buf.length === 0) return null;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const id3 = parseId3(buf);
    return id3 ? { id3 } : null;
  }
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) {
    const flac = parseFlac(buf);
    return flac && flac.durationSec !== null ? { flac } : null;
  }
  if (buf.length >= 12 && boxType(buf, 0) === "ftyp") {
    const mp4 = parseMp4Codec(buf);
    return mp4 && mp4.alac ? { mp4 } : null;
  }
  // mime without a recognizable signature: still try the declared format
  if (mime === "audio/mpeg") {
    const id3 = parseId3(buf);
    return id3 ? { id3 } : null;
  }
  if (mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/aac") {
    const mp4 = parseMp4Codec(buf);
    return mp4 && mp4.alac ? { mp4 } : null;
  }
  return null;
}
