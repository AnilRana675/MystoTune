# MystoTune roadmap — milestone ledger

Everything shipped in M0 → M6.x, plus the manual acceptance drills that stay
open until exercised on a real Render account. Specs of record:
docs/BitChord Telegram Addon PRD & TRD (v2).md (M0–M5) and
docs/MystoTune M6 Guided Setup Website and One-Click Render Deploy.md (M6).
`scripts/release-notes.mjs` pulls each release's Highlights from the
matching `**M6.x ✅` headline below.

## Shipped

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

- **M6.13 ✅ config-store boot warm-up + docs split (v0.6.13-store-warmup)** —
  the last free-plan nit from live boot logs: the config-store read was the
  first Redis round-trip of a boot and could race the TLS handshake — ioredis
  rejected it instantly ("Stream isn't writeable"), the store fell back to
  env-only, and wizard-configured deployments lost their saved configuration on
  every cold boot. `main()` now holds that read behind a bounded 2.5 s
  `waitRedisUp` warm-up — the same guard the snapshot restore already had,
  which is what made the failure visible in the first place. Docs: README
  slimmed to hero / quick start / tests; this ledger became the release
  Highlights source (`scripts/release-notes.mjs` reads it now).
- **M7.0 ✅ typed-search grammar lexer (src/query.ts)** — a single
  `parseQuery()` that reads a BitChord search box without breaking plain
  queries: quoted spans become phrases, `artist:/album:/title:` scope
  tokens, `dur:` windows, `recent:` day windows, `sort:` explicit orders and
  a bare `lossless` flag — case-insensitive, junk-tolerant, unbalanced-quote
  safe, and unknown prefixes degrade to free text exactly like v0.6. Table
  driven lexer tests (23 rows) plus plain/empty framing tests.
- **M7.1 ✅ typed search binding (dual-path engine)** — plain queries run the
  untouched legacy pipeline byte-for-byte (same FTS match, same boosts, same
  dedupe); structured queries parse once and bind: FTS5 column filters
  (`artist : m83*`, exact adjacency for like `title : "day glow"`), real
  phrase adjacency (order matters), `lossless`, `dur:>=<=<>=` windows,
  `recent:Nd` windows, OR-fallback under 5 rows, and +4/+3 title/artist
  boosts with the same near-dup dedupe (±2 s, keep lossless) shared by both
  paths. The Redis query cache is salted `v2:` so pre-grammar cached ids
  expire harmlessly.
- **M7.2 ✅ explicit sorts** — `sort:recent|oldest|longest|relevance`
  (relevance stays default and byte-identical; the other three use dedicated
  ORDER BY pools — addedAt desc/asc, duration — with pool-order preserved
  through the shared dedupe). Longest on the fixture pool returns exact
  title order: Day Glow → Midnight City → Skinny Love → Lossless.
- **M7.3 ✅ ops-hygiene (live-ops visibility)** — `/healthz` grows
  `channels: N`, `lastSyncError` (message or null, already tracked by the
  indexer per sync pass) and `lastSearches` (the last 10 raw queries,
  memory-only ring) — day-one field verification of the grammar without
  touching logs; boots with no store and no channels now warn loudly.
- **M7.4 ✅ docs + release prep** — grammar examples in the README quick
  start; this ledger carries M7; version 0.7.0-discovery released on the
  automation when merged to main. Follow-up on the same milestone: the
  monthly egress budget now defaults to unlimited (`MONTHLY_BYTES_BUDGET=0`
  opt-in cap; also fixed the wizard options screen coercing a typed 0 back
  into the old 4.5 GB default).
- **M7.5 ✅ health privacy split (v0.7.0-discovery follow-up)** — `/healthz` is
  unauthenticated by contract (Render checks, pingers), so the M7.3 additions
  were a leak: anyone with the URL could read the `lastSearches` ring (raw
  query history), channel counts, budgets, and Redis stats. `/healthz` now
  returns only `ok` + `mode`; the full ops payload (memory, admissions, budget,
  index, sync health, lastSearches, counters) moved behind `/{secret}/status`,
  which keeps the M6.2 wizard payload while the setup site is open and rides
  the wizard closure fields (`closed`/`publicUrl`) on top of the ops payload
  after finish — both contracts on one secret route.
- **M7.6 ✅ security + correctness remediation (pre-merge review)** — signed
  `/media` and `/art` tokens had a length-confusion bug (a wrong-length
  signature compared against a padded copy verified as equal: forged,
  never-expiring media URLs were possible); both verifiers now reject any
  signature whose length differs before the constant-time compare, with a
  regression table for 0/1/31/33-byte forgeries. Explicit sorts now read one
  globally ordered pool, near-dup survivors follow the active sort, grammar
  tokens dropped by the lexer can never resurface as keywords, and the bench,
  soak and compose probes moved to the secret status route (the privacy split
  had broken their health checks).
- **M7.7 ✅ BitChord-compat polish (source-verified audit)** — `/stream` now
  returns `bitrate` in bits/s (the index stores kbps; absent stays absent so
  BitChord falls back to the requested tier) and PCM/WAV rows advertise
  `format: "wav"` instead of the unknown codec `pcm`. Search edge cases fixed:
  explicit sorts are strict-first (the AND pool wins when it has ≥5 rows — the
  M7.6 always-OR fix had let OR-only rows leak into sorted results), `q=""`
  no longer returns the whole library, and `sort:relevance` alone browses
  consistently with the other sort modes. AIFF descriptor gaps closed:
  `audio/aiff` + `audio/x-aiff` MIME and the `.aif` extension resolve to
  lossless PCM (no fabricated size-derived bitrate), and `.aif` docs now pass
  the audio filter so they are indexed at all. Policy decisions documented in the
  README: quality tiers stay advisory (single canonical rendition — no
  transcoding), budget exhaustion stays a deliberate 404 for BitChord
  fallback, and the one-time setup link in the deploy log is a known
  sensitivity (rotate `ADDON_SECRET` after setup if needed).

- **M7.9 ✅ library byte sizes on /status (opt-in env)** — `TRACK_SIZE_STATS=1`
  makes `/{secret}/status` report `totalBytes` plus a per-channel
  `{chatId, count, bytes}` breakdown (`byChannel`), answering "how big is the
  music on this channel" with one SQLite `GROUP BY chatId` pass. Default off:
  absent keys keep the status payload lean on big libraries; values stay out
  of the config store (env wins, §7.3).

## Open drills (manual acceptance on Render)

- [ ] Fresh account to first play ≤ 10 min (manual, needs a real account)
- [ ] Play one MP3 and one FLAC from the deployed instance
- [ ] Five consecutive redeploys without `AUTH_KEY_DUPLICATED` (the lease
      code + fake-Redis tests cover the mechanism; the drill is manual)
