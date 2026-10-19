/**
 * Streaming window maths — TRD §4.7.3.
 *
 * Telegram upload.GetFile takes offsets and limits in 4 KiB multiples and one
 * request must not cross a 1 MiB boundary. Fixed 512 KiB windows starting on
 * 512 KiB boundaries satisfy both (512 KiB divides 1 MiB), so seeking into the
 * middle of a file replays windows without ever straddling an edge, and the
 * requested [start..end] slice is reconstructed by trimming the head of the
 * first window and the tail of the last one.
 */

/** One download window: 512 KiB (divides 1 MiB, multiple of 4 KiB). */
export const WINDOW = 512 * 1024;

/** First byte offset of the WINDOW block that contains `pos`. */
export function alignDown(pos: number): number {
  return pos - (pos % WINDOW);
}

/** True when the request [offset, offset+limit) sits inside one 1 MiB block. */
export function withinOneMebibyteBlock(offset: number, limit: number): boolean {
  const first = Math.floor(offset / (1024 * 1024));
  const last = Math.floor((offset + limit - 1) / (1024 * 1024));
  return first === last;
}

/**
 * The exact slice of a window buffer that falls inside [start..end] inclusive.
 * `bufferStart` is the absolute file offset of `buf` (the window boundary).
 */
export function sliceForWindow(buf: Buffer, bufferStart: number, start: number, end: number): Buffer {
  const bufEnd = bufferStart + buf.length; // exclusive
  if (bufEnd <= start || bufferStart > end) return Buffer.alloc(0);
  const skip = Math.max(0, start - bufferStart);
  const take = Math.min(bufEnd, end + 1) - bufferStart; // exclusive, relative
  return buf.subarray(skip, take);
}

/** Offset of the first never-needed byte after the current window. */
export function nextWindowOffset(bufferStart: number, bufLength: number): number {
  return bufferStart + bufLength;
}
