#!/usr/bin/env bash
# Oracle Cloud Always Free 등 무료 Linux VM에서 Traders AI 상시 기동.
# (install-always-on.sh 래퍼 + 무료 클라우드용 안내)
#
# 사용 (VM에서):
#   cd ~/ai-secretary/traders-ai
#   # .env 에 TOSS_* / NGROK_* 준비된 상태
#   sudo bash scripts/bootstrap-free-cloud.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "========================================"
echo " Traders AI — Free Cloud bootstrap"
echo " (Oracle Always Free / 일반 Linux VPS)"
echo "========================================"
echo

if [[ ! -f .env ]]; then
  echo "ERROR: .env 가 없습니다."
  echo "  집 PC에서 scp 로 .env 를 이 폴더에 복사하세요."
  echo "  예: scp -i KEY .env ubuntu@PUBLIC_IP:~/ai-secretary/traders-ai/.env"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${TOSS_CLIENT_ID:-}" || -z "${TOSS_CLIENT_SECRET:-}" ]]; then
  echo "WARN: TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 비어 있습니다. (모의만 동작)"
fi

if [[ -z "${NGROK_AUTHTOKEN:-}" || -z "${NGROK_DOMAIN:-}" ]]; then
  echo "ERROR: 휴대폰 HTTPS/푸시를 위해 NGROK_AUTHTOKEN + NGROK_DOMAIN 이 필요합니다."
  echo "  ngrok 대시보드에서 무료 도메인·토큰을 받아 .env 에 넣으세요."
  exit 1
fi

# Ubuntu 방화벽이 켜져 있어도 ngrok(아웃바운드)만이면 SSH 외 포트 불필요.
# ufw active 시 22 허용만 확인 (실패해도 설치는 계속).
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -qi "Status: active"; then
    ufw allow OpenSSH >/dev/null 2>&1 || true
    echo "==> ufw: OpenSSH 허용 확인"
  fi
fi

bash "$ROOT/scripts/install-always-on.sh"

EGRESS="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
PUBLIC_URL="https://${NGROK_DOMAIN}"

cat <<EOF

----------------------------------------
다음 3가지만 하세요
----------------------------------------
1) 토스 Open API 허용 IP 에 등록:
     ${EGRESS:-"(IP 조회 실패 — 앱의 출구 IP 보기 사용)"}
2) 휴대폰 브라우저에서 열기:
     ${PUBLIC_URL}
3) 앱에서 「휴대폰 알림 켜기」 → 테스트 알림

상태: docker compose --profile tunnel ps
로그: docker compose --profile tunnel logs -f app
가이드: FREE_CLOUD.md
----------------------------------------
EOF
