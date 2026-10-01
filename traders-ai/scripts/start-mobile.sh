#!/usr/bin/env bash
# Start Traders AI on 0.0.0.0:8787 and expose a stable-ish public URL.
# Default: localtunnel fixed subdomain (no signup)
# Better: set NGROK_AUTHTOKEN (+ optional NGROK_DOMAIN) for a permanent free ngrok URL
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
SUBDOMAIN="${PUBLIC_TUNNEL_SUBDOMAIN:-traders-ai-toss}"
TMUX_CONF="/exec-daemon/tmux.portal.conf"
SERVER_SESSION="traders-ai-server"
TUNNEL_SESSION="traders-ai-tunnel-fixed"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -f "$TMUX_CONF" ]]; then
  TMUX=(tmux -f "$TMUX_CONF")
else
  TMUX=(tmux)
fi

ensure_session() {
  local name="$1"
  "${TMUX[@]}" has-session -t "=$name" 2>/dev/null || \
    "${TMUX[@]}" new-session -d -s "$name" -c "$ROOT" -- "${SHELL:-bash}" -l
}

echo "==> Building UI"
npm run build

echo "==> Starting app on ${HOST}:${PORT}"
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 0.5
ensure_session "$SERVER_SESSION"
"${TMUX[@]}" send-keys -t "$SERVER_SESSION:0.0" C-c || true
sleep 0.3
"${TMUX[@]}" send-keys -t "$SERVER_SESSION:0.0" "HOST=${HOST} PORT=${PORT} npx tsx server/index.ts" C-m

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    break
  fi
  sleep 0.5
done

ensure_session "$TUNNEL_SESSION"
"${TMUX[@]}" send-keys -t "$TUNNEL_SESSION:0.0" C-c || true
sleep 0.3

PUBLIC_URL=""
if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "==> Starting ngrok (fixed domain)"
  /tmp/ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null
  if [[ -n "${NGROK_DOMAIN:-}" ]]; then
    "${TMUX[@]}" send-keys -t "$TUNNEL_SESSION:0.0" "/tmp/ngrok http --domain=${NGROK_DOMAIN} ${PORT}" C-m
    PUBLIC_URL="https://${NGROK_DOMAIN}"
  else
    "${TMUX[@]}" send-keys -t "$TUNNEL_SESSION:0.0" "/tmp/ngrok http ${PORT}" C-m
    sleep 3
    PUBLIC_URL="$(curl -sf http://127.0.0.1:4040/api/tunnels | python3 -c 'import sys,json; t=json.load(sys.stdin)["tunnels"]; print(next((x["public_url"] for x in t if x["public_url"].startswith("https")),""))' 2>/dev/null || true)"
  fi
else
  echo "==> Starting localtunnel subdomain: ${SUBDOMAIN}"
  "${TMUX[@]}" send-keys -t "$TUNNEL_SESSION:0.0" "npx --yes localtunnel --port ${PORT} --subdomain ${SUBDOMAIN}" C-m
  PUBLIC_URL="https://${SUBDOMAIN}.loca.lt"
fi

echo "$PUBLIC_URL" > "$ROOT/data/public-url.txt"
echo
echo "Mobile URL (fixed): $PUBLIC_URL"
echo "Saved to data/public-url.txt"
