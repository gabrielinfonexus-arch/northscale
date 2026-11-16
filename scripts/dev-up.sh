#!/usr/bin/env bash
# Local dev helper for this cloud container: start Postgres (if installed as a service) and the Next dev server.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v service >/dev/null; then
  pg_state="$(service postgresql status 2>/dev/null || true)"
  if [[ "$pg_state" == *down* ]]; then service postgresql start >/dev/null; sleep 2; fi
fi
if ! curl -s -o /dev/null http://localhost:3000; then
  nohup npx next dev -p 3000 > "${DEV_LOG:-/tmp/northscale-dev.log}" 2>&1 &
  for _ in $(seq 1 40); do curl -s -o /dev/null http://localhost:3000/data && break; sleep 2; done
fi
echo "Postgres: $(service postgresql status 2>/dev/null | head -1)"; echo "App: http://localhost:3000"
