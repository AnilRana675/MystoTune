# MystoTune — BitChord Telegram Addon

A [BitChord](https://github.com/kushagrasinghx/BitChord) addon server that indexes music shared in your own
Telegram channels and streams it back with signed URLs, random access and byte-exact
seeking.

```
src/            server.ts (routes, media proxy) · db.ts (SQLite+FTS5) · indexer.ts
                (track ids, metadata cleaning, §4.5 quality tiers) · telegram.ts ·
                media.ts (ranges + admission control) · sign.ts (HMAC tokens) ·
                query.ts (typed-search lexer) · config.ts (env > store > defaults) ·
                configStore.ts · setup.ts (first-run wizard) · index-loop.ts ·
                download-window.ts · keys.ts · lease.ts · probe.ts
scripts/        seed-fixture.ts · session.mjs (M1) · channels.mjs (M1) · sync-once.ts
test/           contract/range/query/admission/fault/m1/m2/m3/m4/m6/m7 suites + fake-redis + soak
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
   - **Options** — download permission and monthly bandwidth budget (0 = unlimited,
     which is the default).
4. Press **Verify**: every row (Redis, Telegram, each channel, audio, public
   URL, lease) has to be green, then **Finish** — the addon swaps
   SETUP → STANDBY → ACTIVE without a terminal.
5. Open BitChord with your service's onrender.com URL and play.
   `config.enc` lives encrypted in the Key Value store; if the free store
   ever wipes it, setup re-opens cleanly and you run the wizard again.

Ops notes: deploys are manual (auto-deploy off — this is what makes the
Redis session-lease hand-over safe, doc §7.11), redeploys overlap for ≤15 s
without killing your Telegram session, a failed login re-opens setup
with a banner, and an emptied disk re-indexes the fast way — the boot
restores tracks + sync cursors from the Redis index snapshot
(`REDIS_SNAPSHOT=1`) in under a second instead of crawling Telegram again.
Details in `docs/render.md`.

BitChord-compat notes (verified against BitChord's source): `quality=LOW/HIGH/
LOSSLESS` is advisory — the addon serves the channel's canonical rendition and
labels it; there is no transcoding and no sibling rendition. Budget exhaustion
answers 404 on purpose so BitChord treats the track as a miss and falls back
instead of retrying. The one-time setup link is printed to the deploy log by
design (token in the URL fragment) — treat Render logs as sensitive; rotating
`ADDON_SECRET` after setup invalidates old links but also changes the addon URL
in BitChord.

### Search grammar (what you can type in BitChord)

Plain words work exactly as before — the grammar is opt-in:

- `artist:m83` / `album:hurry` / `title:"day glow"` — field scoping
  (single word = prefix match; quotes = exact phrase in that field);
- `"midnight city"` — quoted phrase, word order matters;
- `lossless` — only lossless results (FLAC, WAV, AIFF);
- `dur:>=300` `dur:<180` `dur:180` — duration windows in seconds;
- `recent:7d` — only tracks added in the last 7 days (up to 3650d);
- `sort:recent` / `sort:oldest` / `sort:longest` / `sort:relevance` —
  explicit ordering (default `relevance`).

Combine freely: `artist:m83 lossless`, `title:"skinny love" dur:<200`,
`recent:2 sort:recent`. Unknown prefixes degrade back to plain text.
The last 10 queries show up in `/{secret}/status` as `lastSearches` — handy to
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

## The endpoints (M0 contract, M4 artwork, M7 ops split)

| Route                             | Notes                                                     |
| --------------------------------- | --------------------------------------------------------- |
| `GET /{secret}/manifest.json`     | `'search'`,`'stream'` resources; `no-store`               |
| `GET /{secret}/search?q=&quality=&atmos=` | FTS5 + bm25 + typed grammar, hostile-q safe, order kept, cap 25 |
| `GET /{secret}/stream/{id}`       | signed media URL; 404 empty on miss; 503/429 upstream     |
| `GET|HEAD /media/{token}`         | no secret prefix (signature is the credential)            |
| `GET|HEAD /art/{token}`           | M4 artwork: kind-tagged token, ETag/304, thumbless ⇒ 404  |
| `GET /healthz`                    | public liveness — `{ok, mode}` only, deliberate           |
| `GET /{secret}/status`            | the ops payload: memory, index, sync health, last searches, counters |

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
aborts the pipeline, and the file DC is kept warm. The first chunk is fetched
*before* the HTTP headers are committed, so cold/FloodWait/expired-reference
failures surface as real 503/429/404 instead of a connect-then-truncate.

## Tests & soak

```bash
npm test                        # suites: contract/range/query/admission/fault/m1/m2/m3/m4/m6/m7
npm run soak -- --seconds 60 --no-budget --out docs/m5-soak-baseline.json
```

Baseline history (M0, M2, M5 soak runs; M3 compose; M6 Docker bench) lives in
`docs/m*-soak-baseline.json` + `docs/m3-docker-benchmark.json` +
`docs/m6-docker-benchmark.json`, with the numbers and their interpretation —
including why the in-process soak's RSS reading is a harness artifact — in
`docs/render.md`. The 192 MB planning limit stands; the in-process soak stays
for regression trends only.

## Docs

- `docs/ROADMAP.md` — milestone ledger: everything shipped (M0–M7.7) plus the
  open manual acceptance drills (source of the release-notes Highlights).
- `docs/render.md` — Render ops: Blueprint, free-plan constraints, failure
  modes, redeploy lease hand-over, live-service history.
- `.env.example` — every configuration variable, wizard-first ordering.
- `docs/MystoTune M6 Guided Setup Website and One-Click Render Deploy.md` —
  the M6 spec of record; `docs/BitChord Telegram Addon PRD & TRD (v2).md` —
  product & technical requirements (M0–M5).
