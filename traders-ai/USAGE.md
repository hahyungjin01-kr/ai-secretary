# Traders AI — 쓰는 법

수익을 보장하지 않습니다.

## 흐름
1. **평일 17:30 KST**에 AI가 자동으로 종목 제안 생성
2. **평일 18:00 KST**에 휴대폰 알림
3. 알림 탭 → 앱에서 **최종 확인** 한 번 → 주문

## 휴대폰 알림 (1회 설정)
1. 휴대폰 브라우저(HTTPS/ngrok)로 앱 열기
2. **휴대폰 알림 켜기** 누르고 권한 허용
3. **테스트 알림**으로 수신 확인
4. iPhone은 Safari에서 **홈 화면에 추가**한 뒤, 홈 화면 아이콘으로 열어 알림을 켜야 합니다

## 스케줄 (`.env`)
```env
DAILY_SCHEDULE_ENABLED=1
DAILY_RUN_TIME_KST=17:30
DAILY_SCHEDULE_WEEKDAYS_ONLY=1
NOTIFY_SCHEDULE_ENABLED=1
NOTIFY_TIME_KST=18:00
```

## 안전장치
- 일손실 킬스위치 / 연속 손실 시 매수 잠금
- 장외는 하드 차단
- 알림만으로 주문되지 않음 — 최종 확인 필요

손익은 사용자 책임입니다.
