#!/usr/bin/env bash
# 현재 머신에서 Docker Compose로 상시 기동 (재부팅·크래시 후 자동 재시작).
# Cursor Cloud Agent VM은 세션 종료 시 사라지므로, PC 전원과 무관하게 돌리려면
# 고정 IP VPS에서 install-always-on.sh 를 쓰세요.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env 필요"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker가 없습니다. sudo bash scripts/install-always-on.sh 를 사용하세요."
  exit 1
fi

# Stop legacy tmux sessions so port 8787 is free
if command -v tmux >/dev/null 2>&1; then
  TMUX_CONF="/exec-daemon/tmux.portal.conf"
  if [[ -f "$TMUX_CONF" ]]; then TMUX=(tmux -f "$TMUX_CONF"); else TMUX=(tmux); fi
  for s in traders-ai-server traders-ai-tunnel-fixed; do
    "${TMUX[@]}" kill-session -t "=$s" 2>/dev/null || true
  done
fi
fuser -k 8787/tcp 2>/dev/null || true
sleep 0.5

mkdir -p data

if [[ -n "${NGROK_AUTHTOKEN:-}" && -n "${NGROK_DOMAIN:-}" ]]; then
  docker compose --profile tunnel up -d --build
  PUBLIC_URL="https://${NGROK_DOMAIN}"
else
  docker compose up -d --build
  PUBLIC_URL="http://127.0.0.1:8787"
fi

echo "$PUBLIC_URL" > data/public-url.txt
echo "Always-on URL: $PUBLIC_URL"
docker compose ps
