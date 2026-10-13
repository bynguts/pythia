#!/usr/bin/env bash
# Run Pythia locally: API on :8001, web app on :5175 and, with --whatsapp,
# the WhatsApp gateway on :2785. Ctrl+C stops everything.
#
#   ./scripts/dev.sh               # API + web app
#   ./scripts/dev.sh --whatsapp    # also the WhatsApp gateway
#   ./scripts/dev.sh --install     # install Python and npm dependencies first
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
whatsapp=false
install=false
for arg in "$@"; do
  case "$arg" in
    --whatsapp) whatsapp=true ;;
    --install) install=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if $install; then
  python3 -m pip install -r "$root/apps/api/requirements.txt"
  npm --prefix "$root/apps/web" install
  if $whatsapp; then npm --prefix "$root/apps/wa-gateway" install; fi
fi

trap 'kill 0' EXIT

# The AI engine (auto-reroute, landfill queue predictor) only runs when enabled.
(cd "$root/apps/api" && PYTHIA_AI_ENGINE=on python3 -m uvicorn app.main:app \
  --host 127.0.0.1 --port 8001 --reload) &
(cd "$root/apps/web" && npm run dev -- --port 5175 --strictPort) &
if $whatsapp; then (cd "$root/apps/wa-gateway" && node server.js) & fi

echo "Waiting for the API (the first start loads 42 forecast models, ~1-2 min)..."
for _ in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:8001/api/health >/dev/null 2>&1; then
    echo "Pythia is up: http://localhost:5175 — sign in as dispatcher / dispatcher-demo-pass"
    break
  fi
  sleep 3
done
wait
