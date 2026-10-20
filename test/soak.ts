/**
 * M0 soak: N concurrent workers seek-storm a fixture with random Range reads
 * for a fixed duration, sampling /healthz every 2 s. Exit non-zero on any 5xx.
 *
 * Usage: tsx test/soak.ts [--seconds N] [--workers N] [--out FILE]
 */
import { createMediaToken } from "../src/sign.js";
import { buildTestServer, type TestServer } from "./util.js";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
};
const SECONDS = Math.max(5, Number(arg("--seconds") ?? 300));
const WORKERS = Math.max(1, Number(arg("--workers") ?? 2));
const OUT = arg("--out");
// §4.15: the soak storms far faster than real egress can (4.5 GB in ~15 s), so
// by default it disables the monthly budget gate to keep seek-storm semantics
// comparable to the M2/M3 baselines. --budget keeps it enforced instead.
const BUDGET_DISABLED = arg("--no-budget") !== null;

interface Sample {
  rss: number;
  heapUsed: number;
  activeStreams: number;
  queuedStreams: number;
}
interface Span {
  ok: boolean;
  bytes: number;
  firstByteMs: number;
  totalMs: number;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const ts = await buildTestServer({
    maxConcurrentStreams: 2,
    admissionWaitMs: 2000,
    extraEnv: BUDGET_DISABLED ? { MONTHLY_BYTES_BUDGET: "0" } : undefined,
  });
  const KEY = Buffer.from((ts.cfg as { mediaSigningKey: Buffer }).mediaSigningKey);
  // resolve three URLs up-front (§4.10: they are valid for MEDIA_URL_TTL_SECONDS)
  const urls: Array<{ url: string; size: number }> = [6, 7].map((i) => {
    const id = ts.tracks[i]!.id;
    const size = ts.tracks[i]!.size!;
    return { url: `${ts.baseUrl}/media/${createMediaToken(id, KEY, 21600)}`, size };
  });

  const spans: Span[] = [];
  const samples: Sample[] = [];
  let fiveXX = 0;
  const deadline = Date.now() + SECONDS * 1000;

  const worker = async (n: number): Promise<void> => {
    let i = n % urls.length;
    while (Date.now() < deadline) {
      const target = urls[i % urls.length]!;
      i += 1;
      const start = Math.floor(Math.random() * Math.max(1, target.size - 1024 * 1024));
      const end = Math.min(target.size - 1, start + 512 * 1024 - 1);
      const ac = new AbortController();
      const t0 = performance.now();
      let bytes = 0;
      let firstByteMs = 0;
      let ok = false;
      try {
        const res = await fetch(target.url, {
          headers: { range: `bytes=${start}-${end}` },
          signal: ac.signal,
        });
        firstByteMs = performance.now() - t0;
        if (res.status >= 500) {
          fiveXX += 1;
          console.error(`5xx ${res.status} at ${new Date().toISOString()}`);
          ac.abort();
          spans.push({ ok, bytes, firstByteMs, totalMs: performance.now() - t0 });
          continue;
        }
        assert206(res.status, start, end);
        if (!res.body) throw new Error("no body");
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            ok = true;
            break;
          }
          bytes += value!.byteLength;
          if (bytes >= 262_144) {
            ac.abort(); // seek-style partial read
            ok = true;
            break;
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          console.error("worker error", (err as Error)?.message);
        } else ok = true; // aborted on purpose mid-download
      }
      spans.push({ ok, bytes, firstByteMs, totalMs: performance.now() - t0 });
      // rapid-fire storm: no sleep
    }
  };

  const sampler = (async (): Promise<void> => {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const h = (await (await fetch(`${ts.baseUrl}/healthz`)).json()) as Record<string, number>;
      samples.push({
        rss: Number(h.rss),
        heapUsed: Number(h.heapUsed),
        activeStreams: Number(h.activeStreams),
        queuedStreams: Number(h.queuedStreams),
      });
    }
  })();

  const started = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, (_, n) => worker(n)));
  await sampler.catch(() => {});
  await ts.cleanup();

  const summary = {
    durationSec: Math.round((Date.now() - started) / 1000),
    workers: WORKERS,
    requests: spans.length,
    ok: spans.filter((s) => s.ok).length,
    fiveXX,
    bytesServedMB: Number((spans.reduce((a, s) => a + s.bytes, 0) / 1048576).toFixed(1)),
    p50Ms: Math.round(pct(spans.map((s) => s.totalMs), 50)),
    p95Ms: Math.round(pct(spans.map((s) => s.totalMs), 95)),
    maxMs: Math.round(Math.max(0, ...spans.map((s) => s.totalMs))),
    firstByteP95Ms: Math.round(pct(spans.map((s) => s.firstByteMs), 95)),
    maxActiveStreams: Math.max(0, ...samples.map((s) => s.activeStreams)),
    maxQueued: Math.max(0, ...samples.map((s) => s.queuedStreams)),
    maxRssKiB: Math.max(0, ...samples.map((s) => s.rss)),
    maxHeapUsedKiB: Math.max(0, ...samples.map((s) => s.heapUsed)),
    exitOk: fiveXX === 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (OUT) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
  }
  if (fiveXX > 0) process.exitCode = 1;
}

function assert206(status: number, start: number, end: number): void {
  // keep the soak honest: slice requests must come back 206
  if (status !== 206 || end < start) {
    throw new Error(`unexpected status ${status} for bytes=${start}-${end}`);
  }
}

main().catch((err) => {
  console.error("soak failed", err);
  process.exit(1);
});
