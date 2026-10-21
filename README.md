# MystoTune — BitChord Telegram Addon

A [BitChord](https://github.com/kushagrasinghx/BitChord) addon server that indexes music shared in your own
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

### Search grammar (what you can type in BitChord)

Plain words work exactly as before — the grammar is opt-in:

- `artist:m83` / `album:hurry` / `title:'day glow'` — field scoping
  (single word = prefix match; quotes = exact phrase in that field);
- `"midnight city"` — quoted phrase, word order matters;
- `lossless` — only lossless results (FLAC/ALAC);
- `dur:>=300` `dur:<180` `dur:180` — duration windows in seconds;
- `recent:7d` — only tracks added in the last 7 days (up to 3650d);
- `sort:recent` / `sort:oldest` / `sort:longest` / `sort:relevance` —
  explicit ordering (default `relevance`, unchanged from v0.6).

Combine freely: `artist:m83 lossless`, `title:'skinny love' dur:<200`,
`recent:2 sort:recent`. Unknown prefixes degrade back to plain text.
The last 10 queries show up in `/healthz` as `lastSearches` — handy to
confirm what BitChord actually sent.

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

## Docs

- `docs/ROADMAP.md` — milestone ledger: everything shipped plus the open
  manual acceptance drills (source of the release-notes Highlights).
- `docs/render.md` — Render ops: Blueprint, free-plan constraints, failure
  modes, redeploy lease hand-over, live-service history.
- `.env.example` — every configuration variable, wizard-first ordering.
- `docs/MystoTune M6 Guided Setup Website and One-Click Render Deploy.md` —
  the M6 spec of record; `docs/BitChord Telegram Addon PRD & TRD (v2).md` —
  product & technical requirements (M0–M5).
