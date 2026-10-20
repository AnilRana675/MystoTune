# Deploying the BitChord Telegram Addon on Render (§4.15)

TRD v2.2 FINAL section 4.15 defines a **Render free-plan profile** for the
addon: ephemeral disk, port-from-env, cold-start patience for Telegram, boot
auth-overlap retries, and a monthly egress budget that degrades gracefully
instead of letting Render suspend the service.

The stock `Dockerfile` works unchanged (`BASE_IMAGE=node:22-slim` is the
default build arg; EXPOSE 8080; `CMD node dist/src/server.js`). No Render
image building or compose changes are required.

## Boot order the server already implements

1. Fastify listens on `$PORT` (bind `0.0.0.0`) before Telegram connects.
2. `REDIS_SNAPSHOT=1` restores `index:snapshot` (tracks **and** sync cursors)
   from Redis when the ephemeral SQLite index is empty — **before** Telegram
   connects. Storage rule (§4.11 rule 5): cursors live in SQLite normally; the
   snapshot additionally carries them for ephemeral-disk hosts.
3. Telegram connects last; `/stream` and `/media` wait up to 10 s for the
   client when the state is still `connecting`, then answer
   `503 Retry-After: 5`.
4. If the session is already in use elsewhere (`AUTH_KEY_DUPLICATED`), boot
   retries `BOOT_AUTH_RETRIES` times spaced `BOOT_AUTH_RETRY_WAIT_SECONDS`
   apart before declaring fatal — this absorbs the overlap window when Render
   swaps instances while the old deployment still holds the session.

## Environment variables

| Variable                          | Value at Render                          | Notes                                                            |
| --------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `PORT`                            | *(Render default, do not set)*           | read from env, default 8080 locally; server binds `0.0.0.0`       |
| `PUBLIC_BASE_URL`                 | `https://<your-service>.onrender.com`    | must be https in production (omit `ALLOW_INSECURE_BASE_URL`)      |
| `ADDON_SECRET`                    | 32+ char random                          | the manifest/search/stream secret prefix                          |
| `MEDIA_SIGNING_KEY`               | base64 of 32 random bytes                | signs `/media` + `/art` tokens — rotate ⇒ old URLs expire         |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` | provisioned via `npm run session` | never commit these |
| `REDIS_URL`                       | free Render Key Value (or Upstash)       | required for the snapshot restore path                            |
| `REDIS_SNAPSHOT`                  | `1`                                      | index dump after each sync; replayed on cold boot                 |
| `MONTHLY_BYTES_BUDGET`            | `4500000000` (4.5 GB default)            | egress counter in Redis `bytes:month` (UTC-month TTL); when exceeded `/stream` and `/media` answer a plain `404` so BitChord falls back instead of the host suspending |
| `ALLOW_DOWNLOADS`                 | `0` (recommended at Render)              | keeps manifest `allowDownloads:0` to discourage client-side downloads on the free plan |
| `BOOT_AUTH_RETRIES`               | `3`                                      | boot retries for `AUTH_KEY_DUPLICATED` (deploy overlap)            |
| `BOOT_AUTH_RETRY_WAIT_SECONDS`    | `60`                                     | spacing between boot retries                                      |

`MONTHLY_BYTES_BUDGET=0` disables the budget entirely (local deployments).

## Docker / image notes

- `BASE_IMAGE` stays `node:22-slim` (the M3 benchmark winner — glibc
  `MALLOC_ARENA_MAX` support; the TRD NODE_OPTIONS line includes
  `--optimize-for-size` for cgroup-tuned JVM-style memory trimming, configured
  via compose env, not the Dockerfile).
- Non-root user owns `/data` — but on Render the disk is ephemeral, so
  `REDIS_SNAPSHOT=1` is what makes cold starts warm.

## Free-plan operational notes

- **Region: Singapore** — the TRD picks the region that minimizes Telegram DC
  RTT for the posting time zones involved; keep Telegram geometry in mind if
  you repoint the service (DC warm-touching adapts automatically).
- **Idle spin-down:** free web services sleep after ~15 min without inbound
  traffic. On wake, the boot order above runs again: Fastify first, snapshot
  restore, then Telegram. BitChord sees only normal 503 cold-start replies
  for up to 10 s — it treats them as regular flaps and falls back.
- **Cold standby with a second account:** Telegram authorizes one session per
  account, so the cheap way to keep a warm instance is a second Telegram
  account (its own string session) hosting a standby deployment. When the
  primary is asleep, BitChord's 503 fallbacks handle transfers; never share a
  `TELEGRAM_SESSION` across two live instances — that is exactly the
  `AUTH_KEY_DUPLICATED` overlap the boot retries absorb at deploy boundaries.
