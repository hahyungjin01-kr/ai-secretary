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

### PC 꺼도 유지 — Firebase (권장)

집 PC/Cloud Agent는 꺼지면 스케줄·푸시도 멈춥니다. **Firebase Hosting + Functions + Firestore + Scheduler**로 상시 기동합니다.

```bash
cd traders-ai
# .firebaserc 에 프로젝트 ID 설정
# Firebase 시크릿/파라미터 등록 (USAGE.md 참고)
npm run deploy:firebase
```

- Hosting: UI (`https://<project>.web.app`)
- Functions: `/api/**` + 평일 17:30 분석 / 18:00 푸시 / 09:05 예약체결
- Firestore: 상태·푸시 구독 영속화
- **토스 허용 IP**: Functions 출구 IP는 회전합니다. 앱의「등록할 출구 IP 보기」로 확인하거나, 고정 IP가 필요하면 VPC Connector + Cloud NAT / Docker VPS를 쓰세요.

### 대안 — Docker 상시 기동 (고정 IP VPS)

```bash
cd traders-ai
sudo bash scripts/install-always-on.sh
# 또는
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
