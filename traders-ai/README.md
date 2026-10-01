# Traders AI

**계좌 현금으로 AI가 알아서 투자**하고, **매수 직전에만 허락**받는 앱입니다.

> 사용법: **[USAGE.md](./USAGE.md)**

## 제품 흐름

1. 토스증권 계좌 잔고 동기화
2. **AI에게 맡기기** → 종목·금액 자동 선정
3. 사용자가 **허락**하면 토스 주문 / **거절**하면 취소

키가 없으면 로컬 모의체결로 동작합니다.

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
| 4 | 앱에서 잔고 새로고침 → AI에게 맡기기 → 허락 |

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
