# Self-hosting MystoTune on your own server

Stack: **docker compose + GitHub Actions (SSH deploy)**. Push to `main` → CI
test-gates it (`release` workflow) → deploy workflow SSHes in → the server
pulls, rebuilds, restarts, and health-checks itself. TLS lives in nginx,
resources are capped in compose, and your Telegram creds/index never sit in
git.

## Layout

```
/opt/mystotune/            # git clone of this repo (server copy is disposable)
├── .env                   # YOUR secrets — untracked, survives redeploys
└── data/                  # index.sqlite persists here — untracked too
```

The deploy script runs `git reset --hard origin/main`, so the repo copy must
contain nothing local; **all state lives in `.env` + `./data`** by design.

## One-time setup

```bash
# 1. Docker + clone
curl -fsSL https://get.docker.com | sh
git clone https://github.com/AnilRana675/MystoTune.git /opt/mystotune
cd /opt/mystotune

# 2. .env (see .env.example; generate the two secrets ON the server)
openssl rand -hex 16        # ADDON_SECRET
openssl rand -base64 32     # MEDIA_SIGNING_KEY
cp .env.example .env        # then fill: ADDON_SECRET, MEDIA_SIGNING_KEY, PORT=10000,
                            # DB_PATH=/data/index.sqlite, PUBLIC_BASE_URL=https://<domain>
                            # and the lean-runtime trio: LOG_LEVEL=warn,
                            # MAX_CONCURRENT_STREAMS=2, NODE_OPTIONS=--max-old-space-size=128

# 3. first boot
docker compose up -d --build
docker compose logs | grep '\[setup\]'   # one-time wizard link → login → channels → finish
```

No `REDIS_URL` needed: the disk persists, so the shared-lease/snapshot
machinery runs process-local (§4.11 rule 3 fallback) and Redis never enters
the picture on self-host.

## Deploy key + Actions wiring

```bash
# on your laptop (private key stays private):
ssh-keygen -t ed25519 -f mystotune_deploy_key -N ""
# append mystotune_deploy_key.pub to the server user's ~/.ssh/authorized_keys
```

GitHub repo → Settings → Secrets and variables → Actions → add:

| Secret     | Value                              |
| ---------- | ---------------------------------- |
| `SSH_HOST` | server IP                          |
| `SSH_USER` | SSH user                           |
| `SSH_KEY`  | full **private** key (OpenSSH fmt) |
| `SSH_PORT` | 22 (optional; default)             |

`.github/workflows/deploy-server.yml` chains **behind the `release` workflow**
(workflow_run) — the server only ever deploys refs whose tests+typecheck
passed on `main`, and the script's `/healthz` loop fails the run loudly if the
addon doesn't come back.

## nginx (TLS + streaming-safe proxy)

```nginx
server {
    listen 443 ssl;                        # certbot manages the cert lines
    server_name music.example.com;
    client_max_body_size 1m;
    location / {
        proxy_pass http://127.0.0.1:10000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;               # relay audio straight through
        proxy_read_timeout 600s;           # long-lived song streams
        proxy_send_timeout 600s;
    }
}
```

Behind any proxy the addon already trusts `X-Forwarded-For` (Fastify
`trustProxy: true`), so per-IP rate limits (§4.11) stay per-person. Binding
compose to `127.0.0.1:10000` is what makes trusting XFF safe — the port is
unreachable except through your proxy.

## Resource caps

`docker-compose.yml` carries `mem_limit: 256m` + `cpus: "1.0"`; the lean env
(LOG_LEVEL=warn, MAX_CONCURRENT_STREAMS=2,
NODE_OPTIONS=--max-old-space-size=128) keeps steady-state near ~90 MB RSS.

## Redeploy / rollback / moves

- Redeploy: push to `main` — automatic. Manual: `bash scripts/selfhost-deploy.sh`.
- Logs: `docker compose logs -f --tail 100`.
- Move servers: copy `.env` + `data/` to the new box, compose up — index and
  config survive (encrypted store is in `data/cfg-key`).
- Two instances (Render + this server): each needs its **own session string**
  — run the wizard fresh on the server; never point both boots at one session
  (`AUTH_KEY_DUPLICATED` / client logout).

## Failure modes

| Symptom | Fix |
| --- | --- |
| `AUTH_KEY_DUPLICATED` at boot | the session is logged in elsewhere — wizard for a fresh one, or stop the other instance |
| healthz fails after deploy | script prints the last 60 log lines; usually an env typo — fix `.env`, redeploy |
| `EACCES` on `/data` | only on machines where `data/` isn't owned by the compose user — `docker compose down && sudo chown -R user . && up` |
| boot crash-loop `SQLITE_READONLY` | `./data` (or `index.sqlite`) is root-owned from a first `sudo docker compose up`; the deploy's ownership preflight now fails fast with the fix: `sudo chown -R 1000:1000 data` |
| BitChord can't play | `PUBLIC_BASE_URL` must exactly match the URL BitChord uses to reach the manifest |
| curation bot silent | `BOT_TOKEN`/`BOT_ALLOWED_IDS` missing or a pre-0.7.11 image — check `/{secret}/status` → `bot.*`; the poll loop exits only when disabled |
