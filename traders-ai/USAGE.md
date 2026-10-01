# Traders AI — 쓰는 법

수익을 보장하지 않습니다.

## 흐름
1. **평일 17:30 KST**에 AI가 자동으로 종목 제안 생성
2. **평일 18:00 KST**에 휴대폰 알림
3. 알림의 **최종 확인** → 장중이면 즉시 주문, **장외면 다음 장(09:05 KST) 예약 주문**
4. 앱 **「예약 확인」** 패널에서 예약 여부 확인·취소

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
EXECUTE_QUEUED_TIME_KST=09:05
# TRADERS_API_SECRET=...   # 없으면 data/api-secret.json 자동 생성
```

## 토스 「허용되지 않은 IP」
Cloud Agent 서버 출구 IP는 여러 개로 회전합니다.  
앱의 **등록할 출구 IP 보기**로 나온 주소를 **전부** 토스증권 Open API 허용 IP에 등록하세요.

## 안전장치
- mutate API는 `X-Traders-Secret` 필요 (앱이 자동 주입)
- 최종 확인 문구(`최종확인`) 없으면 주문 API 거부
- 일손실 킬스위치 / 연속 손실 시 매수 잠금
- 장외는 즉시 주문 대신 **예약**
- **매수 제안 합계 ≤ 가용 현금**
- **보유 매도가 있으면 당일은 매도만** → 체결 후 **다음날** 매수 재제안
- 영구 LIVE 무장 없음 — 최종 확인 건별 실주문만

손익은 사용자 책임입니다.
