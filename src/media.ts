/**
 * Media proxy mechanics — §4.3 (4th endpoint), §4.7 (pipeline), §4.14
 * (stream admission). Range maths + admission are pure and unit-testable;
 * serveMedia lives in server.ts and only needs an entry with a byte source.
 */
import { createReadStream as fsCreateReadStream, type ReadStream } from "node:fs";

export interface ParsedRange {
  kind: "none" | "full" | "slice" | "unsatisfiable";
  start?: number;
  end?: number; // INCLUSIVE, HTTP semantics
}

/**
 * Parse a single-range Range header. Malformed syntax -> "none" (RFC 9110:
 * ignore and serve full). Out-of-bounds -> unsatisfiable (416).
 */
export function parseRange(header: string | undefined | null, size: number): ParsedRange {
  if (!header) return { kind: "none" };
  const top = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!top) return { kind: "none" };
  const first = top[1]!.split(",")[0]!.trim();
  if (size <= 0) return { kind: "unsatisfiable" };

  let m = /^(\d+)-(\d+)$/.exec(first);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > b || a >= size) return { kind: "unsatisfiable" };
    return { kind: "slice", start: a, end: Math.min(b, size - 1) };
  }
  m = /^(\d+)-$/.exec(first);
  if (m) {
    const a = Number(m[1]);
    if (a >= size) return { kind: "unsatisfiable" };
    return { kind: "slice", start: a, end: size - 1 };
  }
  m = /^-(\d+)$/.exec(first);
  if (m) {
    const suffix = Number(m[1]);
    if (suffix <= 0) return { kind: "unsatisfiable" };
    return { kind: "slice", start: Math.max(0, size - suffix), end: size - 1 };
  }
  return { kind: "none" }; // unparsable but syntactically-bytes -> ignore (serve full)
}

/* ---------------------------------------------------------------- admission */

export class AdmissionTimeoutError extends Error {
  /** 4.4 / FR-19: queued too long -> 503 with Retry-After: 2. */
  retryAfterSeconds = 2;
}

interface Grant {
  token: string; // admission key (media token; unique per signed URL)
  probe: boolean;
  controller: AbortController;
  released: boolean;
  notify: () => void;
}

/**
 * §4.14 / FR-19: count only requests actively streaming bytes. HEAD and
 * <=4 KiB range probes are free. Extra requests queue for ADMISSION_WAIT_MS,
 * then 503/Retry-After 2. A new Range request with the same token aborts the
 * previous one so a seek storm never stacks up.
 */
export class Admissions {
  private active = new Map<string, Grant>();
  private waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout | null }> = [];

  constructor(
    private readonly maxActive: number,
    private readonly waitMs: number,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  async acquire(token: string, opts: { probe: boolean; signal?: AbortSignal }): Promise<Grant> {
    if (!opts.probe) await this.replaceActiveToken(token);
    for (;;) {
      if (this.signalAborted(opts.signal)) throw new AdmissionCancelledError();
      if (opts.probe || this.active.size < this.maxActive) {
        const grant = this.makeGrant(token, opts.probe);
        if (!opts.probe) this.active.set(token, grant);
        return grant;
      }
      await this.enqueue(opts.signal);
    }
  }

  release(grant: Grant): void {
    if (grant.released) return;
    grant.released = true;
    if (!grant.probe) {
      this.active.delete(grant.token);
      this.wake();
    }
    grant.notify();
  }

  private makeGrant(token: string, probe: boolean): Grant {
    let notify = () => undefined as void;
    const done = new Promise<void>((res) => {
      notify = () => res();
    });
    void done;
    return {
      token,
      probe,
      controller: new AbortController(),
      released: false,
      notify: () => notify(),
    };
  }

  /** FR-19: new request with the same token aborts the previous active one. */
  private async replaceActiveToken(token: string): Promise<void> {
    const prior = this.active.get(token);
    if (!prior) return;
    prior.controller.abort();
    await this.waitForRelease(prior);
  }

  private waitForRelease(grant: Grant): Promise<void> {
    if (grant.released) return Promise.resolve();
    let poll: NodeJS.Timeout | undefined;
    return new Promise<void>((resolve) => {
      const check = () => {
        if (grant.released) {
          if (poll) clearInterval(poll);
          resolve();
        }
      };
      poll = setInterval(check, 5);
      check();
      setTimeout(() => {
        if (poll) clearInterval(poll);
        resolve();
      }, 5000);
    });
  }

  private enqueue(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const slot = { resolve, timer: null as NodeJS.Timeout | null };
      const finish = (ok: boolean, err?: Error) => {
        this.waiters = this.waiters.filter((w) => w !== slot);
        if (slot.timer) clearTimeout(slot.timer);
        if (ok) resolve();
        else reject(err ?? new AdmissionTimeoutError());
      };
      slot.timer = setTimeout(() => finish(false, new AdmissionTimeoutError()), this.waitMs);
      if (signal) {
        const onAbort = () => finish(false, new AdmissionCancelledError());
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(slot);
    });
  }

  private wake(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    }
  }

  private signalAborted(signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted);
  }
}

export class AdmissionCancelledError extends Error {}

/* ------------------------------------------------------------- byte source */

export interface ByteSource {
  /** Readable producing exact bytes for [start..end] inclusive. */
  stream(start: number, end: number, signal: AbortSignal): ReadableLike;
}

export interface ReadableLike {
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
  destroy(err?: Error): void;
}

/** Fixture/local-file source (M0 stand-in for the Telegram iterator). */
export function localFileSource(filePath: string, chunkBytes = 384 * 1024): ByteSource {
  return {
    stream(start: number, end: number, signal: AbortSignal): ReadableLike {
      const rs = fsCreateReadStream(filePath, { start, end, highWaterMark: chunkBytes });
      const onAbort = () => rs.destroy(); // intentional stop, not an error
      signal.addEventListener("abort", onAbort, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              const chunk = await nextChunk(rs);
              return chunk ? { value: chunk, done: false as const } : { value: undefined as unknown as Buffer, done: true as const };
            },
          };
        },
        destroy(err?: Error) {
          rs.destroy(err ?? new Error("aborted"));
        },
      };
    },
  };
}

async function nextChunk(rs: ReadStream): Promise<Buffer | null> {
  for (;;) {
    const chunk = rs.read() as Buffer | null;
    if (chunk !== null) return chunk.length ? chunk : null;
    if (rs.readableEnded || rs.destroyed) return null;
    if (rs.errored) throw rs.errored;
    if (!rs.readable) return null;
    await new Promise<void>((resolve) => {
      const done = () => {
        rs.off("readable", done);
        rs.off("end", done);
        rs.off("close", done);
        rs.off("error", done);
        resolve();
      };
      rs.on("readable", done);
      rs.on("end", done);
      rs.on("close", done);
      rs.on("error", done);
    });
  }
}
