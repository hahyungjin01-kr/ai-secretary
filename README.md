# ai-secretary

## Traders AI

모드형 일일 트레이딩 앱은 [`traders-ai/`](./traders-ai/)에 있습니다.

```bash
cd traders-ai && npm install && npm run dev
```

- 모드: 안전형 / 밸런스형 / 수익형
- 매일 자동으로 시세·차트·뉴스 분석 후 알림
- 사용자는 투자/매도 금액만 입력 → Alpaca로 주문 (키 없으면 로컬 모의)
- 실계좌는 `ALPACA_LIVE=true` + 앱에서 `LIVE` 확인 후에만 주문
