#!/usr/bin/env node
/**
 * docker-bench — M3 §4.12/§4.13 verification driver:
 * builds the slim + alpine images (parametric BASE_IMAGE), starts each with
 * the mandated cgroup caps (mem 192m / memswap 384m, tmpfs, init), seeds
 * fixtures inside, runs remote-soak traffic from the host, and samples
 * `docker stats` for peak RSS. Writes docs/m3-docker-benchmark.json.
 */
import { execSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

const P = "/home/mystogan/Projects/MystoTune";
const SECONDS = Number(process.env.BENCH_SECONDS ?? 60);
const WORKERS = Number(process.env.BENCH_WORKERS ?? 3);
const HOST_PORT = 18091;
const BASE = `http://127.0.0.1:${HOST_PORT}`;
const SECRET = "bench-secret-0123456789abcdef0123456789abcdef"; // 44 chars, bench-only
const MEDIA_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5"; // bench-only, 32B base64

const sh = (cmd) => execSync(cmd, { cwd: P, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function run(cmd) {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", cmd], { cwd: P, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout }));
  });
}

async function waitReady(deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${BASE}/${SECRET}/status`);
      const j = await res.json();
      if (j.ok === true && j.indexCount >= 6) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const runs = [];
  for (const variant of ["slim", "alpine"]) {
    const image = `bitchord:${variant}`;
    const base = variant === "alpine" ? "node:22-alpine" : "node:22-slim";
    const t0 = Date.now();
    console.log(`\nbuilding ${image} (BASE_IMAGE=${base})…`);
    const built = await run(`docker build --build-arg BASE_IMAGE=${base} -t ${image} .`);
    if (built.code !== 0) {
      console.error(`build failed for ${variant}; skipping. tail:\n${built.stdout.slice(-600)}`);
      continue;
    }
    runs.push({ image, variant, buildMs: Date.now() - t0 });
  }
  if (runs.length === 0) {
    console.error("no images built — benchmark aborted");
    process.exit(1);
  }

  for (const entry of runs) {
    const name = `bitbench-${entry.variant}`;
    console.log(`\n=== ${entry.image} ===`);
    await run(`docker rm -f ${name} 2>/dev/null || true`);
    const started = await run(
      // tmpfs default perms are root:root 0755 on this daemon — the image's
      // `node` user (uid 1000) needs explicit uid/gid or sqlite gets EACCES.
      `docker run -d --name ${name} --memory 192m --memory-swap 384m --init ` +
        `--tmpfs /tmp:rw,uid=1000,gid=1000 --tmpfs /data:rw,uid=1000,gid=1000,size=64m --tmpfs /app/test:rw,uid=1000,gid=1000 ` +
        `-p ${HOST_PORT}:8080 ` +
        `-e PORT=8080 -e DB_PATH=/data/index.sqlite ` +
        `-e PUBLIC_BASE_URL=${BASE} -e ALLOW_INSECURE_BASE_URL=1 ` +
        `-e ADDON_SECRET=${SECRET} -e MEDIA_SIGNING_KEY=${MEDIA_KEY} -e MEDIA_URL_TTL_SECONDS=3600 ` +
        `-e LOG_LEVEL=warn -e NODE_ENV=production --entrypoint sh ${entry.image} ` +
        `-c "node dist/scripts/seed-fixture.js > /tmp/seed.log 2>&1 && exec node dist/src/server.js"`,
    );
    if (started.code !== 0) {
      console.error("docker run failed:", started.stdout, started.stdout.slice(0, 400));
      continue;
    }
    console.log("container started:", started.stdout.trim().slice(0, 12));
    if (!(await waitReady(30_000))) {
      console.error(`${entry.image}: server never became ready`);
      const logs = sh(`docker logs ${name} 2>&1 | head -30`);
      console.error(logs);
      await run(`docker rm -f ${name}`);
      continue;
    }

    let maxRss = 0;
    let stopStats = false;
    const sampler = (async () => {
      while (!stopStats) {
        try {
          const out = sh(`docker stats --no-stream --format '{{.MemUsage}}' ${name}`);
          const mem = out.split(" ")[0] ?? "0";
          const kib = mem.endsWith("GiB")
            ? Math.round(parseFloat(mem) * 1048576)
            : mem.endsWith("MiB")
              ? Math.round(parseFloat(mem) * 1024)
              : Math.round(parseFloat(mem));
          if (Number.isFinite(kib)) maxRss = Math.max(maxRss, kib);
        } catch {
          /* stats races the container lifecycle */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();

    const soak = await run(
      `node scripts/remote-soak.mjs ${BASE} ${SECRET} --seconds ${SECONDS} --workers ${WORKERS} --out /tmp/opencode/soak-${entry.variant}.json`,
    );
    stopStats = true;
    await sampler;

    let soakJson = null;
    try {
      soakJson = JSON.parse(readFileSync(`/tmp/opencode/soak-${entry.variant}.json`, "utf8"));
    } catch {
      /* soak summary missing */
    }
    entry.stats = { maxRssKiB: maxRss, limitKiB: 192 * 1024, soak: soakJson, soakExit: soak.code };
    console.log(
      `RESULT ${entry.image}: soakExit=${soak.code} requests=${soakJson?.requests ?? "?"} 5xx=${soakJson?.fiveXX ?? "?"} p95=${soakJson?.p95Ms ?? "?"}ms firstByteP95=${soakJson?.firstByteP95Ms ?? "?"}ms maxRss=${Math.round(maxRss / 1024)}MiB (limit 192MiB)`,
    );
    await run(`docker rm -f ${name}`);
  }

  writeFileSync(
    `${P}/docs/m3-docker-benchmark.json`,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), seconds: SECONDS, workers: WORKERS, runs },
      null,
      2,
    ),
  );
  console.log("\nwritten: docs/m3-docker-benchmark.json");
}

await main();
