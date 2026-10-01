# Traders AI

모드 기반 **일일 자동 분석 → 알림 → 금액 입력 → 계좌 주문** 앱입니다.

## 제품 흐름

1. **모드 선택**: 안전형 / 밸런스형 / 수익형
2. **매일 자동 분석**: 관심종목 시세·차트·거래량·뉴스 조사
3. **알림**: “얼마를 투자할까요?” / “얼마를 매도할까요?”
4. **실행**: 금액 입력 → 모드 한도 안에서 수량 결정 → **Alpaca 주문**

키가 없으면 로컬 모의체결로 동작합니다.

## 계좌 연동 (Alpaca)

미국 주식용. [Alpaca](https://app.alpaca.markets)에서 API Key를 발급하세요.

```bash
cp .env.example .env
# .env 에 ALPACA_API_KEY / ALPACA_API_SECRET 입력
```

| 목적 | 설정 |
|------|------|
| 페이퍼(추천 시작) | 기본값 또는 `ALPACA_BASE_URL=https://paper-api.alpaca.markets` |
| 실계좌 | `ALPACA_LIVE=true` 또는 `ALPACA_BASE_URL=https://api.alpaca.markets` |

실계좌여도 앱에서 **LIVE** 를 입력해 잠금을 풀기 전에는 주문이 나가지 않습니다.

## 모드 차이

| 모드 | 1회 손실한도 | 종목 최대비중 | 현금 최소 | 매수 알림 |
|------|-------------|--------------|----------|----------|
| 안전형 | 0.75% | 12% | 25% | 최대 2건/일 |
| 밸런스형 | 1.5% | 22% | 15% | 최대 4건/일 |
| 수익형 | 3% | 35% | 5% | 최대 6건/일 |

## 실행

```bash
cd traders-ai
npm install
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:8787

## API

- `GET /api/dashboard`
- `GET /api/broker/status`
- `POST /api/broker/sync`
- `POST /api/broker/live` — `{ arm, confirm: "LIVE" }`
- `POST /api/daily/run`
- `POST /api/alerts/:id/act` — `{ amount, action }`

## 면책

투자 손실이 발생할 수 있으며 수익을 보장하지 않습니다. 실계좌 주문은 본인 책임입니다.
