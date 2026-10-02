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

### PC 꺼도 유지 — 무료 클라우드 (권장)

결제 없이 **Oracle Cloud Always Free** VM + Docker로 상시 기동합니다.

> 단계별 가이드: **[FREE_CLOUD.md](./FREE_CLOUD.md)**

```bash
# Oracle 무료 VM에 SSH 접속한 뒤
cd ai-secretary/traders-ai   # .env 복사해 둔 상태
sudo bash scripts/bootstrap-free-cloud.sh
# 또는: npm run deploy:free-cloud
```

### 대안 — Firebase (Blaze 결제 필요)

카드 등록이 가능하면 Hosting + Functions + Firestore도 사용할 수 있습니다. → [USAGE.md](./USAGE.md)

### 임시 — 집 PC Docker

```bash
cd traders-ai
bash scripts/run-always-on.sh
```

### 모바일(데이터)에서 접속 — 임시(개발용)

```bash
npm run start:mobile
```

자세한 사용법은 [USAGE.md](./USAGE.md)를 보세요.

## API

- `GET /api/dashboard`
- `GET /api/broker/status`
- `POST /api/broker/sync`
- `POST /api/broker/live`
- `POST /api/daily/run`
- `POST /api/alerts/:id/act` — `{ amount, action, confirm }`
- `POST /api/alerts/confirm-all` — `{ confirm: "최종확인" }`

## 면책

투자 손실이 발생할 수 있으며 수익을 보장하지 않습니다. 실계좌 주문은 본인 책임입니다.
