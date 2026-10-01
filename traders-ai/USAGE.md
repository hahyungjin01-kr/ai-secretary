# Traders AI — 쓰는 법

수익을 보장하지 않습니다.

## 흐름
1. **평일 08:55 KST**에 AI가 자동으로 종목 제안 생성
2. 앱에서 목록 확인 · 빼기
3. **최종 확인** 한 번 → 주문

## 스케줄 (`.env`)
```env
DAILY_SCHEDULE_ENABLED=1
DAILY_RUN_TIME_KST=08:55
DAILY_SCHEDULE_WEEKDAYS_ONLY=1
```

## 안전장치
- 일손실 킬스위치 / 연속 손실 시 매수 잠금
- 장외는 하드 차단

손익은 사용자 책임입니다.
