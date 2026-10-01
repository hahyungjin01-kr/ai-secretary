# Traders AI

모드 기반 **AI 일일 종목 선정 → 알림 → 금액 확인 → 토스증권 주문** 앱입니다.

> 사용법 전체는 **[USAGE.md](./USAGE.md)** 를 보세요.

## 제품 흐름

1. **모드 선택**: 안전형 / 밸런스형 / 수익형
2. **AI 일일 선정**: 관심종목 없이 AI가 종목·투자방식을 고름
3. **알림**: 추천 금액·진입/손절/목표·투자 방식 제시
4. **실행**: 금액 확인 → 모드 한도 안에서 수량 결정 → **토스증권 주문**

키가 없거나 LIVE가 꺼져 있으면 로컬 모의체결로 동작합니다.

## 계좌 연동 (토스증권)

문서: [토스증권 Open API](https://developers.tossinvest.com/docs)

```bash
cp .env.example .env
# TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 입력
# 토스 Open API 설정에서 허용 IP 등록
```

| 단계 | 내용 |
|------|------|
| 1 | 토스증권 → 설정 → Open API 에서 키 발급 |
| 2 | 허용 IP 등록 |
| 3 | `.env`에 키 저장 후 서버 재시작 |
| 4 | 앱에서 잔고 동기화 |
| 5 | 실주문은 `LIVE` 입력 후에만 가능 |

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

### 모바일(데이터)에서 접속 — 고정 주소

```bash
npm run start:mobile
# 또는 ./scripts/start-mobile.sh
```

현재 고정 URL (ngrok):

```
https://supermom-overspend-numeric.ngrok-free.dev
```

`.env` 예시:

```env
NGROK_AUTHTOKEN=...
NGROK_DOMAIN=supermom-overspend-numeric.ngrok-free.dev
```

ngrok이 없으면 localtunnel(`PUBLIC_TUNNEL_SUBDOMAIN`, 기본 `traders-ai-toss`)로 대체됩니다.

자세한 사용법은 [USAGE.md](./USAGE.md)를 보세요.

## API

- `GET /api/dashboard`
- `GET /api/broker/status`
- `POST /api/broker/sync`
- `POST /api/broker/live` — `{ arm, confirm: "LIVE" }`
- `POST /api/daily/run`
- `POST /api/alerts/:id/act` — `{ amount, action }`

## 면책

투자 손실이 발생할 수 있으며 수익을 보장하지 않습니다. 실계좌 주문은 본인 책임입니다.
