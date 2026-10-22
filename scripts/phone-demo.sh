#!/usr/bin/env bash
# Put Pythia on a real phone over HTTPS: production build, `vite preview` on
# :5175 (which proxies /api to the local API on :8001) and a free HTTPS tunnel.
#
#   ./scripts/phone-demo.sh               # build, preview, tunnel
#   ./scripts/phone-demo.sh --skip-build  # reuse the existing apps/web/dist
#
# 1. Starts the API on :8001 unless one already answers. The tunnel URL is public,
#    so every role gets a fresh random password for this run (PYTHIA_PW_<ROLE>;
#    a non-default value you exported yourself is kept), and the script refuses
#    to open the tunnel while the API on :8001 accepts a published
#    <role>-demo-pass login.
# 2. Builds the web app with VITE_API_URL=/api, so the phone calls the API on
#    the tunnel's own origin through the preview proxy (no CORS entry needed).
# 3. Runs `vite preview --port 5175`. vite.config.js only accepts the
#    *.trycloudflare.com and *.loca.lt tunnel hosts (PYTHIA_TUNNEL_HOSTS adds more).
# 4. Opens a Cloudflare quick tunnel (`cloudflared tunnel --url`, no account).
#    Without cloudflared it prints the install hint and falls back to
#    `npx localtunnel` (its first page asks for the tunnel password: this
#    machine's public IP, shown at https://loca.lt/mytunnelpassword).
#
# On the phone open the printed https URL:
#   /driver  driver app + AR navigation (sign in: driver / printed password)
#   /xr      WebXR tabletop twin (no sign-in)
# For a stop the phone can complete, open /fleet (dispatcher / printed
# password), create an SPJ with "DEMO stop at my location" and activate it.
# Ctrl+C stops everything. For everyday development use scripts/dev.sh instead.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
preview_url="http://localhost:5175"
api_url="http://127.0.0.1:8001/api"
skip_build=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Every role in apps/api/app/core/auth.py ROLES.
roles="executive dispatcher supervisor driver auditor administrator"

password_var() {
  echo "PYTHIA_PW_$(echo "$1" | tr '[:lower:]' '[:upper:]')"
}

# Fresh random password per role for this run; the API started below inherits them.
for role in $roles; do
  var="$(password_var "$role")"
  current="${!var:-}"
  if [ -z "$current" ] || [ "$current" = "$role-demo-pass" ]; then
    export "$var=$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
  fi
done

wait_for() {
  local url="$1" tries="$2" what="$3"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  echo "$what did not answer at $url" >&2
  exit 1
}

accepts_default_login() {
  local role="$1" code
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -d "{\"username\":\"$role\",\"password\":\"$role-demo-pass\"}" \
    "$api_url/auth/login" || true)"
  [ "$code" = "200" ]
}

trap 'kill 0' EXIT

started_api=false
if ! curl -fsS "$api_url/health" >/dev/null 2>&1; then
  (cd "$root/apps/api" && PYTHIA_AI_ENGINE=on python3 -m uvicorn app.main:app \
    --host 127.0.0.1 --port 8001) &
  started_api=true
fi

if ! $skip_build; then
  VITE_API_URL=/api npm --prefix "$root/apps/web" run build
fi

(cd "$root/apps/web" && npm run preview -- --port 5175 --strictPort) &

echo "Waiting for the API (the first start loads 42 forecast models, ~1-2 min)..."
wait_for "$api_url/health" 80 "The API"
wait_for "$preview_url" 20 "vite preview"

# The tunnel puts /api on the internet: never while a published password works.
for role in $roles; do
  if accepts_default_login "$role"; then
    echo >&2
    echo "REFUSING TO OPEN THE TUNNEL: the API on :8001 accepts the published password" >&2
    echo "'$role-demo-pass' for '$role', and the tunnel URL is public." >&2
    if $started_api; then
      echo "This script started that API with random passwords; check that nothing" >&2
      echo "overrides $(password_var "$role") and rerun." >&2
    else
      echo "That API was already running before this script started. Stop it (Ctrl+C in" >&2
      echo "its terminal, or kill the uvicorn process on port 8001) and rerun: the script" >&2
      echo "then starts the API itself with fresh random passwords." >&2
    fi
    exit 1
  fi
done

echo
echo "=================================================================="
echo " WARNING: the https URL printed below is PUBLIC. Anyone who has it"
echo " reaches this API. Share it only with the demo team; Ctrl+C ends it."
echo "=================================================================="
if $started_api; then
  echo " Sign-in for this run only (username / password):"
  for role in $roles; do
    var="$(password_var "$role")"
    printf '   %-14s %s\n' "$role" "${!var}"
  done
else
  echo " The API on :8001 was already running: sign in with the PYTHIA_PW_*"
  echo " passwords it was started with (it refuses the published defaults)."
fi
echo "=================================================================="
echo
echo "On the phone open the https URL printed below, then:"
echo "  /driver  driver app + AR (sign in as driver)"
echo "  /xr      WebXR tabletop twin (no sign-in)"
echo "  /fleet   sign in as dispatcher: 'DEMO stop at my location'"
echo

if command -v cloudflared >/dev/null 2>&1; then
  cloudflared tunnel --url "$preview_url"
else
  echo "cloudflared not found. Install it for a stable quick tunnel:" >&2
  echo "  macOS: brew install cloudflared   Linux: https://pkg.cloudflare.com/  (then rerun with --skip-build)" >&2
  echo "Falling back to localtunnel; its first page asks for the tunnel password," >&2
  echo "which is this machine's public IP (see https://loca.lt/mytunnelpassword)." >&2
  npx --yes localtunnel --port 5175
fi
