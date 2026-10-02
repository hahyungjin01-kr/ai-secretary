# Traders AI — 쓰는 법

수익을 보장하지 않습니다.

## PC 꺼도 서버 유지 — 무료 클라우드 (권장)

카드/Blaze 없이 **Oracle Cloud Always Free**에 올리는 방법입니다.

→ 전체 클릭 가이드: **[FREE_CLOUD.md](./FREE_CLOUD.md)**

요약:
1. Oracle 무료 계정 + Ubuntu VM 생성 (SSH 키·Public IP 저장)
2. VM에서 repo clone, 집 PC의 `.env`를 `scp`로 복사
3. `sudo bash scripts/bootstrap-free-cloud.sh`
4. 출력된 **Egress IP**를 토스 허용 IP에 등록
5. `https://<NGROK_DOMAIN>` 으로 휴대폰 알림 켜기

가입 시 카드 인증이 거절되면 FREE_CLOUD.md의「가입이 안 될 때」를 보세요.

---

## 대안 — Firebase (Blaze 결제 필요)

Cursor Cloud Agent / 집 PC는 **전원을 끄거나 세션이 끝나면 서버도 종료**됩니다.  
카드로 Blaze 등록이 가능하면 **Firebase**에 올릴 수 있습니다.

### 1) 준비
1. [Firebase Console](https://console.firebase.google.com/)에서 프로젝트 생성 (Blaze 요금제 — 외부 HTTPS/스케줄 필요)
2. Firestore Database 생성 (네이티브 모드)
3. `.firebaserc`의 `projects.default`를 프로젝트 ID로 수정
4. Firebase CLI 로그인: `npx firebase login`

### 2) 시크릿·파라미터
로컬에서 VAPID를 한 번 생성한 뒤(`npm run start` 후 `data/vapid.json`) 값을 등록합니다.

```bash
# Secrets (민감값)
firebase functions:secrets:set TOSS_CLIENT_SECRET
firebase functions:secrets:set TRADERS_API_SECRET
firebase functions:secrets:set VAPID_PRIVATE_KEY

# Params (비민감 / 또는 .env 파일로 functions에 주입)
firebase functions:config:export  # 참고용 — 아래 params 권장
# 배포 시 대화형으로 묻거나, params 기본값을 쓰려면:
# TOSS_CLIENT_ID / VAPID_PUBLIC_KEY / VAPID_SUBJECT 는
# Google Cloud Console → Cloud Functions → 환경 변수
# 또는 배포 중 defineString 프롬프트에 입력
```

권장 환경값:
- `TOSS_CLIENT_ID`
- `TOSS_CLIENT_SECRET` (secret)
- `TRADERS_API_SECRET` (secret, 16자 이상)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (secret) / `VAPID_SUBJECT`
- `STATE_BACKEND=firestore` (Functions에서 기본 적용)

### 3) 배포
```bash
cd traders-ai
npm install
npm run deploy:firebase
```

배포 후 URL: `https://<project-id>.web.app`

### 4) 휴대폰 알림
1. Firebase Hosting URL로 앱 열기
2. **휴대폰 알림 켜기** → 권한 허용
3. **테스트 알림** 확인
4. iPhone은 Safari **홈 화면 추가** 후 아이콘으로 열어 알림 설정

### 5) 토스 「허용되지 않은 IP」
Firebase Functions 출구 IP는 **회전**합니다.  
앱의 **등록할 출구 IP 보기**로 나온 주소를 토스 허용 IP에 넣고, 거부되면 다시 확인해 추가하세요.

고정 IP가 필요하면:
- GCP **Serverless VPC Access + Cloud NAT** 고정 외부 IP, 또는
- 아래 Docker VPS(고정 IP) 경로

## 대안 — 네이버 클라우드(NCP) / Docker VPS 상시 기동

국내 **네이버 클라우드 Micro Server(1년 무료)** 에 Docker로 올리면 PC를 꺼도 동작하고, 출구 IP도 토스 허용 IP에 등록하기 쉽습니다.

**자세한 단계: [docs/NCP.md](./docs/NCP.md)**

요약:
1. Classic → Micro(Ubuntu) 서버 1대 생성 + 포트포워딩(SSH)
2. SSH 접속 후 repo clone + `.env` 복사
3. `sudo bash scripts/install-always-on.sh`
4. 출력된 Egress IP를 토스 허용 IP에 등록
5. `https://<NGROK_DOMAIN>` 으로 휴대폰 알림 켜기

```bash
cd traders-ai
# .env 에 TOSS_* / NGROK_* 포함
sudo bash scripts/install-always-on.sh
```

- `restart: unless-stopped` 자동 재기동
- 모바일 URL: `.env`의 `NGROK_DOMAIN`
- VPS 출구 IP를 토스 허용 IP에 등록

## 흐름
1. **평일 17:30 KST**에 AI가 자동으로 종목 제안 생성
2. **평일 18:00 KST**에 휴대폰 알림
3. 알림의 **최종 확인** → 장중이면 즉시 주문, **장외면 다음 장(09:05 KST) 예약 주문**
4. 앱 **「예약 확인」** 패널에서 예약 여부 확인·취소

## 스케줄 (`.env` / Firebase params)
```env
DAILY_SCHEDULE_ENABLED=1
DAILY_RUN_TIME_KST=17:30
DAILY_SCHEDULE_WEEKDAYS_ONLY=1
NOTIFY_SCHEDULE_ENABLED=1
NOTIFY_TIME_KST=18:00
EXECUTE_QUEUED_TIME_KST=09:05
# TRADERS_API_SECRET=...
```

Firebase에서는 Cloud Scheduler가 위 시각에 Functions를 호출합니다 (코드: `scheduledDaily` / `scheduledNotify` / `scheduledFlush`).

## 안전장치
- mutate API는 `X-Traders-Secret` 필요 (앱이 자동 주입)
- 최종 확인 문구(`최종확인`) 없으면 주문 API 거부
- 일손실 킬스위치 / 연속 손실 시 매수 잠금
- 장외는 즉시 주문 대신 **예약**
- **매수 제안 합계 ≤ 가용 현금**
- **보유 매도가 있으면 당일은 매도만** → 체결 후 **다음날** 매수 재제안
- 영구 LIVE 무장 없음 — 최종 확인 건별 실주문만

손익은 사용자 책임입니다.
