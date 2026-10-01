#!/usr/bin/env bash
# Ubuntu/Debian VPS에 Traders AI를 Docker로 상시 기동합니다.
# PC를 꺼도 서버·스케줄·휴대폰 알림이 계속 동작합니다.
#
# 전제: 이 스크립트를 traders-ai 디렉터리에서 실행하거나,
#       ALWAYS_ON_DIR 로 설치 경로를 지정합니다.
#
# 사용 예 (VPS에서):
#   git clone <repo> && cd ai-secretary/traders-ai
#   cp /path/to/.env .env
#   sudo bash scripts/install-always-on.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "ERROR: .env 가 없습니다. .env.example 을 복사해 TOSS_* / NGROK_* 를 채우세요."
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Docker 설치/기동을 위해 root(sudo)로 다시 실행하세요."
  echo "  sudo bash scripts/install-always-on.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl docker.io docker-compose-v2
  systemctl enable --now docker || true
fi

# Load NGROK vars for compose interpolation
set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p data
chmod 700 data

echo "==> Building & starting (restart: unless-stopped)"
if [[ -n "${NGROK_AUTHTOKEN:-}" && -n "${NGROK_DOMAIN:-}" ]]; then
  docker compose --profile tunnel up -d --build
  PUBLIC_URL="https://${NGROK_DOMAIN}"
else
  docker compose up -d --build
  PUBLIC_URL="http://$(curl -fsS --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):8787"
  echo "WARN: NGROK_AUTHTOKEN/NGROK_DOMAIN 미설정 — 터널 없이 포트 8787만 엽니다."
fi

echo "$PUBLIC_URL" > data/public-url.txt

# Print egress IP for Toss whitelist (fixed VPS IP is ideal)
EGRESS="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
echo
echo "========================================"
echo " Traders AI always-on"
echo " URL : ${PUBLIC_URL}"
echo " Egress IP (토스 허용 IP에 등록): ${EGRESS:-unknown}"
echo " 상태: docker compose ps"
echo " 로그: docker compose logs -f app"
echo "========================================"
