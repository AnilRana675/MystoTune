#!/usr/bin/env bash
# MystoTune self-host deploy (repo ops; called by .github/workflows/deploy-server.yml
# or by hand over SSH). CI ("release") already gate-tested the exact ref this
# checks out — tests + typecheck were green on main, so the server never
# deploys a red commit.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch --force origin main
prev="$(git rev-parse --short HEAD)"
next="$(git rev-parse --short origin/main)"
echo "-- deploying ${prev} -> ${next}"
# Server copy is disposable; .env and data/ are untracked, so a hard reset is
# safe by design (secrets + index live outside git).
git reset --hard origin/main

docker compose up -d --build

# Health gate: the deploy fails loudly (workflow shows the logs) if the addon
# does not come back up within a minute of the restart.
port="$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1 | tr -d '"' | tr -d ' ')"
port="${port:-10000}"
echo "-- waiting for /healthz on :${port} ..."
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != "1" ]; then
  echo "!! healthz did NOT pass within 60 s — recent logs:" >&2
  docker compose logs --tail 60 >&2
  exit 1
fi
echo "healthz OK — MystoTune ${next} is live"
