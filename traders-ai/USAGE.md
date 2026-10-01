# Traders AI — 짧게 쓰기

**모드만 고르면 AI가 종목·투자방식을 고릅니다. 사용자는 금액만 확인.**

## 접속
- 모바일: https://supermom-overspend-numeric.ngrok-free.dev
- PC: http://localhost:8787

## 하루 루틴
1. 모드 선택 (안전형 / 밸런스형 / 수익형)
2. 잔고 동기화
3. **오늘 AI 선정 실행**
4. 제안 읽고 금액 확인 → 실행 또는 건너뛰기

## 실주문
- 기본: 모의체결 (안전)
- 실주문: 연결 확인 후 `LIVE` 입력 → 실주문 활성화
- 끄기: 실주문 잠그기

## 처음 1회 준비
1. 토스증권 → Open API → `client_id` / `client_secret` 발급
2. 허용 IP 등록
3. `/workspace/traders-ai/.env`에 키 저장 후 재시작

```env
TOSS_CLIENT_ID=...
TOSS_CLIENT_SECRET=...
```

모바일 터널 재시작: `cd /workspace/traders-ai && npm run start:mobile`

## 한줄 FAQ
- 관심종목? → 직접 안 넣음. AI가 고름
- 진짜 주문? → LIVE 켤 때만
- IP 거부? → 토스 허용 IP에 서버 IP 전부 추가
- 수익 보장? → 없음. 손실 가능

투자 권유가 아니며, 실주문 손익은 사용자 책임입니다.
