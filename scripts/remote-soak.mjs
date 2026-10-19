#!/usr/bin/env node
/**
 * remote-soak — host-side soak for the M3 docker benchmark (§4.12/§7):
 * seek-storm Range reads against a running server, mixed searches, and
 * /healthz sampling. Emits a JSON summary (stdout + optional --out FILE).
 *
 * Usage:
 *   node scripts/remote-soak.mjs <base-url> <addon-secret> [--seconds 60]
 *       [--workers 2] [--out FILE] [--seed 9]
 */
import { createHash, timingSafeEqual } from "node:crypto";

const argv = process.argv.slice(2);
const base = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
const secret = argv[1] && !argv[1].startsWith("--") ? argv[1] : "";
let seconds = 60;
let workers = 2;
let out = null;
let seed = 9;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--seconds") seconds = Number(argv[i + 1]);
  else if (argv[i] === "--workers") workers = Number(argv[i + 1]);
  else if (argv[i] === "--out") out = argv[i + 1];
  else if (argv[i] === "--seed") seed = Number(argv[i + 1]);
}
if (!base || !secret) {
  console.error("usage: remote-soak.mjs <base-url> <addon-secret> [--seconds N] [--workers N] [--out f]");
  process.exit(2);
}

/* fairness guaranteed determinism: mulberry32 */
let t = seed >>> 0;
const rnd = () => {
  t = (t + 0x6d2b79f5) >>> 0;
  let x = Math.imul(t ^ (t >>> 15), 1 | t);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const FIXTURE_IDS = [1, 2, 3, 4, 5, 6].map((n) => `tg_n1001234567890_${n}`);
const SEARCHES = ["midnight", "slim pale", "tide", "hum", "aurora", "", "???", "café"];

const summary = {
  base,
  seconds,
  workers,
  startedAt: new Date().toISOString(),
  requests: 0,
  ok: 0,
  clientErr429: 0,
  fiveXX: 0,
  bytesServed: 0,
  latencies: [],
  firstByte: [],
  maxRssKiB: 0,
  maxHeapUsedKiB: 0,
  maxActive: 0,
  maxQueued: 0,
  errors: [],
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const rateDodgerIp = () => `10.${Math.floor(rnd() * 250)}.${Math.floor(rnd() * 250)}.${Math.floor(rnd() * 250) + 1}`;

async function chunkedRangeFetch(url, start, end) {
  const controller = new AbortController();
  const signal = controller.signal;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { headers: { range: `bytes=${start}-${end}`, "x-forwarded-for": rateDodgerIp() }, signal });
  } catch {
    summary.requests += 1;
    summary.errors.push(`fetch ${url} aborted`);
    return 0;
  }
  await statusChecks(res);
  const firstByte = performance.now() - t0;
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    const limit = 32 * 1024; // read ~32 KiB then abort (seek-storm shape)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total >= limit) {
        controller.abort();
        break;
      }
    }
  }
  const ms = performance.now() - t0;
  summary.firstByte.push(firstByte);
  summary.latencies.push(ms);
  summary.bytesServed += total;
  return ms;
}

async function statusChecks(res) {
  summary.requests += 1;
  if (res.status >= 200 && res.status < 500) summary.ok += 1;
  if (res.status === 429) summary.clientErr429 += 1;
  if (res.status === 503) {
    // §4.14: admission overload is CONTRACTED behaviour (503 + Retry-After),
    // never a 500-class error for the machine
    summary.admission503 = (summary.admission503 ?? 0) + 1;
    return;
  }
  if (res.status >= 500) {
    summary.fiveXX += 1;
    summary.errors.push(`${res.url} -> ${res.status}`);
  }
}


const stopAt = Date.now() + seconds * 1000;
let samplerStop = false;

async function healthSampler() {
  while (!samplerStop) {
    try {
      const h = await (await fetch(`${base}/healthz`)).json();
      summary.maxRssKiB = Math.max(summary.maxRssKiB, h.rss ?? 0);
      summary.maxHeapUsedKiB = Math.max(summary.maxHeapUsedKiB, h.heapUsed ?? 0);
      summary.maxActive = Math.max(summary.maxActive, h.activeStreams ?? 0);
      summary.maxQueued = Math.max(summary.maxQueued, h.queuedStreams ?? 0);
      summary.requests += 1;
      summary.ok += 1;
    } catch (e) {
      summary.errors.push(`healthz: ${String(e).slice(0, 80)}`);
      summary.requests += 1;
      summary.fiveXX += 1;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function worker() {
  while (Date.now() < stopAt) {
    try {
      if (rnd() < 0.25) {
        // search leg — unique XFF per request so the per-IP limiter sees a
        // realistic multi-client mix instead of one 60/min-bucket stream
        const q = SEARCHES[Math.floor(rnd() * SEARCHES.length)] ?? "";
        const t0 = performance.now();
        const res = await fetch(`${base}/${secret}/search?q=${encodeURIComponent(q)}`, {
          headers: { "x-forwarded-for": rateDodgerIp() },
        });
        await statusChecks(res);
        await res.json();
        summary.latencies.push(performance.now() - t0);
        summary.firstByte.push(performance.now() - t0);
      } else {
        // stream resolve + seek leg
        const id = FIXTURE_IDS[Math.floor(rnd() * FIXTURE_IDS.length)] ?? FIXTURE_IDS[0];
        const t0 = performance.now();
        const res = await fetch(`${base}/${secret}/stream/${id}`, {
          headers: { "x-forwarded-for": rateDodgerIp() },
        });
        await statusChecks(res);
        if (res.ok) {
          const { url } = (await res.json()) ?? {};
          if (typeof url === "string" && url.includes("/media/")) {
            const fixed = new URL(url);
            const path = fixed.pathname;
            const probe = await fetch(`${base}${path}`, { method: "HEAD" });
            await statusChecks(probe);
            const size = Number(probe.headers.get("content-length") ?? 0);
            if (size > 16) {
              const start = Math.floor(rnd() * (size - 32));
              const end = Math.min(start + 64 * 1024 - 1, size - 1);
              await chunkedRangeFetch(`${base}${path}`, start, end, new AbortController().signal);
            }
            summary.latencies.push(performance.now() - t0);
          }
        }
      }
    } catch (e) {
      summary.errors.push(String(e).slice(0, 100));
    }
  }
}

summary.maxRssKiB = 0;
const healths = healthSampler();
try {
  await Promise.all(Array.from({ length: workers }, () => worker()));
} finally {
  samplerStop = true;
  await healths;
}

summary.latencies.sort((a, b) => a - b);
summary.firstByte.sort((a, b) => a - b);
const lat = summary.latencies;
const fb = summary.firstByte;
const result = {
  ...summary,
  p50Ms: Math.round(percentile(lat, 0.5) ?? 0),
  p95Ms: Math.round(percentile(lat, 0.95) ?? 0),
  maxMs: Math.round((lat.at(-1) ?? 0) * 1) / 1,
  firstByteP95Ms: Math.round(percentile(fb, 0.95) ?? 0),
  bytesServedMB: Math.round((summary.bytesServed / (1024 * 1024)) * 10) / 10,
  errors: summary.errors.slice(0, 10),
  finishedAt: new Date().toISOString(),
};
delete result.latencies;
delete result.firstByte;

const oneLine = JSON.stringify(result);
if (out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, `${oneLine}\n`);
}
console.log(oneLine);
process.exitCode = result.fiveXX === 0 ? 0 : 1;
