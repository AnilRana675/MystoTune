# MystoTune — BitChord Telegram Addon

A [BitChord](https://bitchord.music) addon server that indexes music shared in your own
Telegram channels and streams it back with signed URLs, random access and byte-exact
seeking. Spec source of truth: `docs/BitChord Telegram Addon PRD & TRD (v2).md`.

```
src/            server.ts (routes, media proxy) · db.ts (SQLite+FTS5) · indexer.ts
                (track ids, metadata cleaning, §4.5 quality tiers) · telegram.ts ·
                media.ts (ranges + admission control) · sign.ts (HMAC tokens) · config.ts
scripts/        seed-fixture.ts · session.mjs (M1) · channels.mjs (M1)
test/           contract/range/query/admission/fault/m1/m2/m3 suites + fake-redis + soak
```

## Quick start (dev)

```bash
npm install
cp .env.example .env          # then fill values; for local http dev keep ALLOW_INSECURE_BASE_URL=1
npm run seed                  # fixture tracks (ffmpeg if present, else deterministic bytes)
npm run dev                   # Fastify on :8080
```

Generate secrets per §4.10:

```bash
openssl rand -hex 24    # ADDON_SECRET   (>= 32 chars)
openssl rand -base64 32 # MEDIA_SIGNING_KEY (>= 32 bytes)
```

Helper scripts are live: `npm run session` performs the interactive Telegram login
and prints `TELEGRAM_SESSION_STRING`; `npm run channels` lists the account's
dialogs with the ids to paste into `TARGET_CHANNEL_IDS`; `npm run sync-once`
forces an immediate index pass against the live session. Never run `npm run
session` on an untrusted machine: the StringSession is your Telegram account
credential.

## The four endpoints (M0 contract)

| Route                             | Notes                                                     |
| --------------------------------- | --------------------------------------------------------- |
| `GET /{secret}/manifest.json`     | `'search'`,`'stream'` resources; `no-store`               |
| `GET /{secret}/search?q=&quality=&atmos=` | FTS5 + bm25, hostile-q safe, order kept, cap 25    |
| `GET /{secret}/stream/{id}`       | signed media URL; 404 empty on miss; 503/429 upstream     |
| `GET|HEAD /media/{token}`         | no secret prefix (signature is the credential)            |

`/media` honours `Range` (200/206/416), `If-Range`, optimistic `HEAD`,
`ETag {docId}-{size}`, `Cache-Control: private, max-age=300`; ≤4 KiB probes and HEAD
are admission-free (FR-19); new Range seeks abort the previous stream for the token.

For **telegram-source** tracks (M2): `/stream` resolves the live message first and
the `GET /media` byte bridge streams real `upload.GetFile` windows — 512 KiB-aligned
(never crossing a 1 MiB edge), head/tail trimmed to the requested range, one chunk in
flight plus one read-ahead, `FILE_REFERENCE_EXPIRED` re-fetches the message and
retries the window exactly once, mid-stream truncation is an error, client disconnect
aborts the pipeline, and the file DC is kept warm (first-byte p95 < 600 ms; seek
storms stay in the 0.2-0.6 s band). The first chunk is fetched *before* the HTTP
headers are committed, so cold/FloodWait/expired-reference failures surface as real
503/429/404 instead of a connect-then-truncate.

## Tests & soak

```bash
npm test                        # 77 assertions across contract/range/query/admission/fault/m1/m2/m3
npm run soak -- --seconds 60 --out docs/m2-soak-baseline.json
```

Baseline (M0, in-process fixtures, `NODE_OPTIONS` caps as in §4.12): 70 165 seek-storm
requests in 60 s, **0 × 5xx**, served 19.6 GB, p50 1 ms / p95 6 ms, first-byte p95 5 ms,
peak RSS 156 784 KiB (budget ≤ 192 MB hard / 128 MB stretch), heapUsed ≤ 27 565 KiB,
max 2 active streams, 0 queued, no floods. Full JSON: `docs/m0-soak-baseline.json`
(uncapped-dev comparison run kept at `docs/m0-soak-baseline-unbounded.json`).
M2 re-run after the byte-bridge rework: 28 616 requests in 26 s, 0 × 5xx, p95 5 ms,
peak RSS 147 620 KiB — `docs/m2-soak-baseline.json`.

M3 dockerized 30-minute compose soak (`compose.bench.yaml`, cgroup 192 m / 384 m,
no Redis, no Telegram): 2 440 456 requests, **0 × 5xx / 0 × 429 / 0 errors**, served
44.3 GB, p50 2 ms / p95 6 ms / max 19 ms, first-byte p95 3 ms, peak process RSS
102 420 KiB (heapUsed ≤ 28 426 KiB), max 2 active / 0 queued, no OOM, 0 restarts —
`docs/m3-soak-baseline.json`. Docker slim-vs-alpine benchmark:
`docs/m3-docker-benchmark.json` (slim 62 743 req / p95 5 ms / cgroup RSS 53 MiB;
alpine 46 327 req / p95 7 ms / 49 MiB; both far inside the 192 MiB limit, so slim
stays the default image for its glibc `MALLOC_ARENA_MAX` support).

## Roadmap

- **M0 ✅ contract stub** — manifest/search/stream over fixtures, signed `/media`,
  Range math, admission, status contract, soak baseline.
- **M1 ✅ Telegram read** — real GramJS client (single client, StringSession,
  floodSleepThreshold=0, watchdog reconnect ≤30 s, `AUTH_KEY_*` ⇒ unhealthy+exit),
  SQLite-backed indexer with per-chat `min_id` cursors and MAX_INDEX_ENTRIES trim,
  `InputMessagesFilterMusic`+`Document` audio polling, voice-note skip, caption/
  filename metadata fallback, deletion reconcile in batches of 100, doc LRU +
  `HEAD`-ready resolution for telegram rows.
- **M2 ✅ byte bridge** — real `upload.GetFile` transfer for telegram rows (512 KiB
  aligned windows inside the 1 MiB rule, head/tail trim, pre-header first-window
  fetch, FILE_REFERENCE_EXPIRED refetch+retry-once rules, truncation detection,
  keep-warm DC toucher + DC-migration correction, 50-slice checksum battery,
  live-verified `fLaC` magic + byte-deterministic seeks on a 44 MB FLAC).
- **M3 ✅ hardening** — optional Redis layer (§4.11): `flood:until` shared FloodWait
  cooldown (written on `recordFloodWait`, adopted on the 15 s watchdog cadence),
  `rl:{op}:{ip}:{minute}` rate-limit counters with the in-process limiter as
  fallback, `msg:{id}` resolved-doc metadata cache (30 min TTL, **never** the file
  reference), `q:{hash}` search cache (10 min TTL, 500-entry FIFO cap, hydrated by
  track id), `index:snapshot` gzip dump after every sync (REDIS_SNAPSHOT=1,
  replayed on boot when the disk index is empty). Every Redis command races
  REDIS_TIMEOUT_MS (default 200 ms) and falls back to local state — playback never
  blocks on Redis (FR-15). `/healthz` now reports `cache: {redis, redisStats,
  docEntries, queryEntries}`. Docker (§4.12/§4.13): `BASE_IMAGE` build-arg benchmarks
  slim vs alpine; fixed the broken runtime entry (`dist/src/server.js`, rootDir "."),
  pre-owned `/data` for the non-root user; compose.bench.yaml exercises the compose
  path with a seeded disposable index. Dockerized seek-storm benchmark
  (`scripts/docker-bench.mjs`, 25 s × 2-3 workers): slim 62 743 req, 0 × 5xx, p95 5 ms,
  cgroup peak RSS 53 MiB; alpine 46 327 req, 0 × 5xx, p95 7 ms, peak RSS 49 MiB
  (both ≪ 192 MiB limit) — `docs/m3-docker-benchmark.json`. Tests: 77/77 with the
  fake RESP2 Redis (`test/fake-redis.ts`) — limiter buckets, q-cache cap/eviction,
  msg-meta TTL + no-fileReference, flood adoption, snapshot export/restore, and
  the §7 "Redis stopped ⇒ search and playback keep working" fallback contract.
- **M4** — extras: artwork `/art/{token}`, ID3 probing (album + real bitrate),
  ALAC detection.
