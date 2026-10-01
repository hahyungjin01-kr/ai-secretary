# Traders AI — 쓰는 법

**계좌에 있는 돈으로 AI가 알아서 투자합니다. 매수 직전에만 허락하세요.**

## 접속
- 모바일: https://supermom-overspend-numeric.ngrok-free.dev
- PC: http://localhost:8787

## 쓰는 순서
1. **잔고 새로고침** (토스 연결 후)
2. **AI에게 맡기기**
3. 나온 제안에서 **허락하고 매수** 또는 **거절**

금액·종목은 AI가 정합니다. 사용자는 허락만 하면 됩니다.

## 성향 (선택)
안전형 / 밸런스형 / 수익형 — 여유 현금을 얼마나 쓸지 정도만 다릅니다.

## 처음 1회
1. 토스증권 Open API 키 발급 + 허용 IP
2. `traders-ai/.env`에 `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET`
3. `npm run start:mobile` (또는 서버 재시작)

허락을 누르면 토스 실계좌로 주문이 나갑니다. 수익은 보장되지 않습니다.
