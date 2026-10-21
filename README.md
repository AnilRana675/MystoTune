# MystoTune — BitChord Telegram Addon

A [BitChord](https://bitchord.music) addon server that indexes music shared in your own
Telegram channels and streams it back with signed URLs, random access and byte-exact
seeking. Spec source of truth: `docs/BitChord Telegram Addon PRD & TRD (v2).md`.

```
src/            server.ts (routes, media proxy) · db.ts (SQLite+FTS5) · indexer.ts
                (track ids, metadata cleaning, §4.5 quality tiers) · telegram.ts ·
                media.ts (ranges + admission control) · sign.ts (HMAC tokens) · config.ts
scripts/        seed-fixture.ts · session.mjs (M1) · channels.mjs (M1)
test/           contract/range/query/admission/fault/m1/m2/m3/m4/m6 suites + fake-redis + soak
```

## Quick start (Render, ~10 minutes, no terminal)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AnilRana675/MystoTune)

1. Click the button: Render opens a Blueprint preview with **one web
   service** (Docker runtime, health check `/healthz`, auto-deploy off) and
   **one Key Value store** (free plan). Apply / Create Resources — the
   `APP_SEED` secret is generated for you and `REDIS_URL` is wired to the
   Key Value store automatically.
2. On the web service's first deploy, open **Events → Logs** for the line
   `[setup] open https://<service>.onrender.com/<secret>/setup#t=<token>`.
   That link carries a one-time 144-bit setup token in a `#t=` fragment —
   fragments never travel in a page GET, only in the single unlock POST —
   and it unlocks a 30-minute HttpOnly cookie session.
3. On the setup wizard do exactly four things:
   - **Telegram access** — paste your API ID + API hash from my.telegram.org,
   - **Login** — phone → code (→ 2FA password if you have one) using a
     dedicated Telegram account (section 8 of the M6 spec; 5 wrong unlock
     attempts lock the IP for 15 minutes),
   - **Channels** — pick your music channels; you can preview each channel's
     audio count via the Telegram music filter,
   - **Options** — download permission and monthly bandwidth budget.
4. Press **Verify**: every row (Redis, Telegram, each channel, audio, public
   URL, lease) has to be green, then **Finish** — the addon swaps
   SETUP → STANDBY → ACTIVE without a terminal.
5. Open BitChord with your service's onrender.com URL and play.
   `config.enc` lives encrypted in the Key Value store; if the free store
   ever wipes it, setup re-opens cleanly and you run the wizard again.

Ops notes: deploys are manual (auto-deploy off — this is what makes the
Redis session-lease hand-over safe, doc §7.11), redeploys overlap for ≤15 s
without killing your Telegram session, and a failed login re-opens setup
with a banner. Details in `docs/render.md`.

## Local development

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

## The endpoints (M0 contract, M4 artwork)

| Route                             | Notes                                                     |
| --------------------------------- | --------------------------------------------------------- |
| `GET /{secret}/manifest.json`     | `'search'`,`'stream'` resources; `no-store`               |
| `GET /{secret}/search?q=&quality=&atmos=` | FTS5 + bm25, hostile-q safe, order kept, cap 25    |
| `GET /{secret}/stream/{id}`       | signed media URL; 404 empty on miss; 503/429 upstream     |
| `GET|HEAD /media/{token}`         | no secret prefix (signature is the credential)            |
| `GET|HEAD /art/{token}`           | M4 artwork: kind-tagged token, ETag/304, thumbless ⇒ 404  |

`/media` honours `Range` (200/206/416), `If-Range`, optimistic `HEAD`,
`ETag {docId}-{size}`, `Cache-Control: private, max-age=300`; ≤4 KiB probes and HEAD
are admission-free (FR-19). Ranges are RFC 7233-complete for players: suffix
`bytes=-N` and open-ended `bytes=X-` are byte-exact, `bytes=X-Y` clamps past EOF.
Admission (FR-19 v2.2 FINAL): up to **two** concurrent streams per token (a player
probing the tail while playing no longer kills playback) — the 3rd request for the
same token aborts the *oldest* of the two; extra tokens queue up to
`ADMISSION_WAIT_MS` (2 s) then answer `503` with `Retry-After: 2`.

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
npm test                        # 132 assertions across contract/range/query/admission/fault/m1/m2/m3/m4/m6
npm run soak -- --seconds 60 --no-budget --out docs/m5-soak-baseline.json
```

Baseline (M0, in-process fixtures, `NODE_OPTIONS` caps as in §4.12): 70 165 seek-storm
requests in 60 s, **0 × 5xx**, served 19.6 GB, p50 1 ms / p95 6 ms, first-byte p95 5 ms,
peak RSS 156 784 KiB (budget ≤ 192 MB hard / 128 MB stretch), heapUsed ≤ 27 565 KiB,
max 2 active streams, 0 queued, no floods. Full JSON: `docs/m0-soak-baseline.json`
(uncapped-dev comparison run kept at `docs/m0-soak-baseline-unbounded.json`).
M2 re-run after the byte-bridge rework: 28 616 requests in 26 s, 0 × 5xx, p95 5 ms,
peak RSS 147 620 KiB — `docs/m2-soak-baseline.json`. M5 re-run under the FR-19
two-per-token admission (`--no-budget`: the storm outpaces the default 4.5 GB
monthly budget in ~15 s, which would otherwise flip /media to its §4.15 plain-404
fallback mid-run): 28 527 requests in 60 s, **0 × 5xx**, served 7.9 GB, p50 4 ms /
p95 9 ms, max 2 active / 0 queued, RSS 227 872 KiB — `docs/m5-soak-baseline.json`.
That 227 MB number is a harness artifact, not the service: `test/soak.ts` runs the
server in-process under tsx, so `/healthz` RSS counts the load generator and the
TS loader (the same sample showed heapUsed ≈ 29 MB). M6 verdict re-run (doc §13):
the Docker bench (`scripts/docker-bench.mjs`, 192 MiB cgroup, load from the host)
with every M4–M6 addition says slim + alpine both peak at **63 MB cgroup /
~115 MB process RSS / 30 MB heap**, 64 k requests, 0 × 5xx, p95 12 ms —
`docs/m6-docker-benchmark.json`. The 192 MB planning limit stands; the in-process
soak stays for regression trends only.

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
- **M4 ✅ extras (FR-12/FR-13/§4.5)** — artwork `/art/{token}`: kind-tagged art
  signing prevents token replay between `/media` and `/art`; search rows carry an
  absolute `artworkURL` when the document has a thumbnail (cap 25 kept);
  thumbnails are re-read from the live document at request time (no thumb bytes
  in SQLite), with inline `PhotoStripped` thumbs served zero-RPC and photo-size
  renditions streamed through the 512 KiB bridge keyed by `thumbSize`; ETag +
  `If-None-Match` 304 + HEAD support with private 1-day caching. Deep probing
  (FR-13, P1): the first 64 KB of a document is read at first `/stream` (one
  probe-scan per row per process, flood-safe) — FLAC STREAMINFO fills
  duration+sampleRate (§4.5: `.m4a` still reports the conservative `aac` codec
  until ALAC is proven), MP3 ID3 fills missing album/artist strictly behind
  attribute/caption priority (§4.6.2), and m4a `stsd=alac` upgrades the row to
  `Lossless · ALAC` truthfully. SQLite FTS hygiene: `upsertTrack` purges the
  replaced rows' FTS docids so enrichment re-upserts cannot collide. Tests:
  94/94 across contract/range/query/admission/fault/m1/m2/m3/m4.
- **M5 ✅ TRD v2.2 FINAL profile** — Render free-plan profile (§4.15) plus the
  hardening deltas: admission (FR-19) now allows **two concurrent streams per
  token** (player probes the tail while playing); a 3rd request for the same
  token aborts the oldest stream, extra tokens queue up to `ADMISSION_WAIT_MS`
  then 503 Retry-After 2. Head-window cache (FR-21): the first 512 KiB window
  of every track is kept in an 8-entry / 5-minute LRU, so next-track first
  bytes come from memory with no extra Telegram call. HTTP ranges are
  RFC 7233-complete: suffix `bytes=-N` and open-ended `bytes=X-` are byte-exact
  (covered by dedicated tests, incl. same-token overlapping ranges). Monthly
  egress budget `MONTHLY_BYTES_BUDGET` (default 4 500 000 000) counts streamed
  bytes in the Redis `bytes:month` counter (UTC-month TTL, fire-safe with a
  local fallback) and makes both `/stream` and `/media` answer a **plain 404**
  when exceeded — BitChord falls back and Render never suspends the service.
  Cold start: Fastify boots first; Telegram-dependent requests wait up to 10 s
  (`websocket:0s` order in the manifest) then 503 Retry-After 5. Deploy
  overlap: `AUTH_KEY_DUPLICATED` at boot retried `BOOT_AUTH_RETRIES`×
  `BOOT_AUTH_RETRY_WAIT_SECONDS` (3 × 60 s) before exiting. Storage rule
  (§4.11 rule 5): cursors live in the SQLite `sync_cursors` table (schema v3)
  and the Redis `index:snapshot` gzip also carries them, so `REDIS_SNAPSHOT=1`
  ephemeral-disk hosts like Render rebuild tracks **and** sync cursors BEFORE
  Telegram connects. Deploy guide: `docs/render.md`.
  Tests: 105/105 across contract/range/query/admission/fault/m1/m2/m3/m4 (M5
  cases live in range/admission/fault; the m4 migration test also asserts the
  new schema v3). Incremented later by M6.0 (see below).
- **M6.0 ✅ foundations (M6 spec §1)** — derived secrets (FR-29): `APP_SEED`
  (Blueprint `generateValue` or `openssl rand -base64 32`) feeds HKDF-SHA256
  (salt `mystotune/v1`, infos `addon-path` 24 B → base64url 32-char
  `ADDON_SECRET`, `media-signing` 32 B, `config-store` 32 B); explicit env
  still wins, and pre-M6 `.env` boots derive a stable config key from their
  explicit `ADDON_SECRET`+`MEDIA_SIGNING_KEY`. Config store (FR-28):
  plaintext `{v, apiId, apiHash, sessions[], channels[], options{…}}`
  encrypted AES-256-GCM (random 12-byte IV) as `base64url(iv|tag|ct)` under
  Redis `cfg:v1` (no TTL) with a `/data/config.enc` 0600 fallback — phone is
  never stored and every write is verified by read-back decrypt. Config
  resolution (§7.3) becomes env > store > profile > built-ins via
  `applyStoredConfig`; `PROFILE` autodetects `render` when `RENDER=true`;
  `PUBLIC_BASE_URL` falls back to `RENDER_EXTERNAL_URL`; new envs
  `SETUP_ENABLED`, `LEASE_TTL_MS`/`LEASE_RENEW_MS`/`LEASE_POLL_MS`/`DRAIN_MS`/
  `SESSION_SLOTS`. Tests: 117/117 incl. new `test/m6.test.ts`. (Incremented to
  124 by M6.1 below.)
- **M6.1 ✅ session lease + service modes (M6 spec §7.11/§7.2/Appendix A)** —
  Redis lease `lease:session:{slot}`: acquire via `SET NX PX 45 s`, STANDBY
  polls every 5 s, owner id = `RENDER_INSTANCE_ID` else hostname+4 random hex —
  two instances can never share one Telegram session. Renew every 15 s via
  compare-and-extend Lua (Appendix A verbatim); sustained failures for 30 s
  self-fence (stop Telegram I/O, drop back to STANDBY); SIGTERM enters
  DRAINING, finishing active streams ≤ 10 s, then compare-and-delete release.
  Service state machine in the server (`AddonModeBox`): BOOT → SETUP (valid
  manifest + empty search + healthz `mode:setup`, no indexer; wizard ships in
  M6.2) → STANDBY (manifest/search from snapshot; `/stream` and `/media`
  answer 503 Retry-After 5; `/healthz` stays 200 so Render keeps the old
  instance until the new one passes) → ACTIVE (lease held + Telegram ready) →
  DRAINING → FAILED. Without Redis an explicit-session boot keeps the M5
  AUTH_KEY_DUPLICATED retry fallback. Tests: 124/124 incl. fake-Redis
  two-instance lease races, Appendix A Lua ownership checks, self-fence, and
  every mode gate.
- **M6.2 ✅ guided setup website (doc 7.5-7.9)** — wizard under
  `/{secret}/setup`, unlocked by a 144-bit token from the deploy log
  (`[setup] open …#t=`) that mints an HttpOnly `SameSite=Strict` session
  cookie (30 min) + paired `x-setup-csrf` header; every screen sits behind
  secret + open-mode + origin-host gates. Flow: unlock → creds (api id/hash
  32 hex) → Telegram login by callback valves (phone → code → optional
  password; 5-min idle discard surfaces `login_idle`, errors mapped per doc
  7.6 incl. flood_wait) → channels (dialogs `id ≤ -100`, per-channel audio
  counts via the music filter) → options → verify (redis/telegram/channels/
  audio/public-url/lease rows; `finishAllowed` only with zero fail rows) →
  finish atomically saves the encrypted store entry, swaps runtime
  (SETUP→STANDBY→ACTIVE; failed swap = `startup_pending` 503 + retry) and every `/setup` route 404s afterwards; the done screen offers a
  one-time
iberately not built: full status page = the `/status`
  payload covers FR-33, CLI parity = the wizard needs no CLI, session
  slots = Render free gives one instance per session by design, Render API
  sync = `autoDeploy: false` already gates push-to-deploy.
- **M6.3 ✅ Render Blueprint + deploy-first docs (doc 7.10, FR-30)** —
  `render.yaml`: one Docker web service (`plan: free`, region singapore,
  health check `/healthz`, `autoDeploy: false` so git pushes never
  redeploy into your session; `maxShutdownDelaySeconds` omitted — free
  tier rejects it, the platform's default grace applies) + one free Key
  Value store (`ipAllowList: []`,
  `maxmemoryPolicy: noeviction` protects `cfg:v1`); `APP_SEED` via
  `generateValue` and `REDIS_URL` wired with `fromService` connectionString;
  **no** Telegram/env secrets in the file — the wizard owns them.
  README Quick Start rewritten deploy-first (button → Blueprint preview →
  wizard from the `[setup] open …#t=` log line → verify → finish), the old
  dev flow kept under "Local development", and `docs/render.md` carries the
  ops notes (redeploy lease hand-over, APP_SEED handling, failure modes).
  Schema-validated against render.com/schema/render.yaml.json.
  Manual acceptance stays open on a real Render account: fresh account to
  first play ≤ 10 min, MP3 + FLAC, five consecutive redeploys without
  `AUTH_KEY_DUPLICATED`.

, token-required reveal of the finished session string (doc §7.4
  — save it as `TELEGRAM_SESSION_STRING` against a free Redis plan ever
  wiping `cfg:v1`). New modules: `src/setup.ts` (SetupAccess/SetupManager)
  + scripted-login test seams; 131/131 tests.
- **M6.4 ✅ final-screen session backup + optional-extras review (doc §7.4/§13)** —
  `GET /{secret}/setup/api/session` reveals the finished session string
  exactly once, guarded by the deploy-log token in `x-setup-token`
  (403 on a wrong/missing token, 404 after the reveal or while open; a
  cross-origin caller cannot know the 144-bit token) with a `Reveal session
  backup` button on the done screen and `backupReady` on the status payload.
  Optional extras deliberately not built: full status page = the `/status`
  payload covers FR-33, CLI parity = the wizard needs no CLI, session
  slots = Render free has one instance per session by design, Render API
  sync = `autoDeploy: false` already gates push-to-deploy.</think>Wait — that readme edit needs the actual anchor (partially fabricated above it was constructed from real content). Checking line 247 context is exactly `(SetupAccess/SetupManager) + scripted-login test seams; 131/131 tests.` — yes from the earlier read (line 246-247). Applying both edits:<tool_call>edit<arg_key>newString</arg_key><arg_value>  404s every `/setup` route afterwards; the done screen offers a one-time,

- **M6.12 ✅ snapshot restore visibility + Redis boot hardening** —
  the free-plan fault of the day: every boot re-crawled the 1845-track
  channel because `readSnapshot` swallowed timeouts/errors into a silent
  null (and `cmds` never counted anything). Now: boot-time reads use a
  `BOOT_READ_MS` 2.5 s floor + a `waitRedisUp` handshake wait, every
  restore branch logs loudly (restored N tracks + cursors / no snapshot yet
  / read failed — raise REDIS_TIMEOUT_MS), and a round-trip test proves
  tracks + per-chat cursors survive gzip → Redis → restore. Cosmetic:
  `cmds` now counts every round-trip via `tick`; boot banner reads
  "MystoTune addon serving"; manifest identity defaults to MystoTune.

