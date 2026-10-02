# 네이버 클라우드(NCP)에 Traders AI 올리기

Micro Server 1년 무료 + 기존 Docker 상시 기동 스크립트를 사용합니다.

## A. 콘솔에서 서버 만들기

1. https://console.ncloud.com 로그인
2. **Classic** 환경 선택 (Micro 무료는 Classic 기준)
3. **Server** → **서버 생성**
4. 설정:
   - 서버 이미지: **Ubuntu 22.04** (또는 최신 Ubuntu LTS)
   - 서버 타입: **Micro** (무료 배지 확인)
   - 요금제: 월 요금제
   - 개수: 1
   - 이름: `traders-ai` 등
5. 인증키: 새로 생성 → **`.pem` 파일 즉시 저장** (다시 못 받음)
6. ACG(방화벽):
   - 새 ACG 또는 기존에 **TCP 22** (내 IP 또는 0.0.0.0/0) 허용
   - ngrok만 쓸 거면 **8787은 열지 않아도 됨** (더 안전)
7. 생성 완료 후 **서버 → 포트 포워딩 설정**
   - 외부 포트: 예) `12022`
   - 내부 포트: `22`
   - (공인 IP를 새로 사지 말고, **포트 포워딩용 접속 IP**를 쓰세요. 공인 IP 신청은 과금될 수 있음)

서버 목록에서 **관리자 비밀번호 확인** → `.pem`으로 복호화해 비밀번호 확보.

## B. SSH 접속

맥/리눅스/WSL:

```bash
chmod 400 ~/Downloads/인증키이름.pem
ssh -i ~/Downloads/인증키이름.pem root@포트포워딩접속IP -p 12022
```

(우분투 이미지가 `ncloud` 사용자인 경우 `root` 대신 `ncloud` + `sudo`)

## C. 서버에 앱 설치

서버 안에서:

```bash
# 1) 저장소 clone (본인 GitHub 주소)
git clone https://github.com/hahyungjin01-kr/ai-secretary.git
cd ai-secretary/traders-ai

# 2) .env 만들기 — PC에 있던 값을 그대로 넣기
nano .env
```

`.env`에 최소 이것만 있으면 됩니다:

```env
TOSS_CLIENT_ID=...
TOSS_CLIENT_SECRET=...
NGROK_AUTHTOKEN=...
NGROK_DOMAIN=...
DAILY_SCHEDULE_ENABLED=1
DAILY_RUN_TIME_KST=17:30
NOTIFY_SCHEDULE_ENABLED=1
NOTIFY_TIME_KST=18:00
EXECUTE_QUEUED_TIME_KST=09:05
```

```bash
# 3) Docker 설치 + 상시 기동
sudo bash scripts/install-always-on.sh
```

끝나면 화면에 나옵니다:
- **URL**: `https://<NGROK_DOMAIN>`
- **Egress IP**: 토스 허용 IP에 등록할 주소

## D. 토스 + 휴대폰

1. 토스증권 Open API → **허용 IP**에 위에서 나온 Egress IP 등록
2. 휴대폰으로 `https://<NGROK_DOMAIN>` 접속
3. **휴대폰 알림 켜기** → 테스트 알림

## E. 상태 확인 / 중지

```bash
cd ~/ai-secretary/traders-ai   # 설치 경로에 맞게
docker compose ps
docker compose logs -f app
```

중지:

```bash
docker compose --profile tunnel down
```

## 요금 주의

| 항목 | 주의 |
|------|------|
| Micro Server | 1년 무료 → 만료 전 **반납** 아니면 유료 |
| 공인 IP | 신청만 해도 과금될 수 있음 → 가능하면 포트포워딩만 |
| 추가 디스크/LB | 만들지 말 것 |
| 트래픽 | 개인 알림·API 수준이면 보통 문제 없음 |

## 문제 해결

- SSH 거부: ACG 22번, 포트포워딩 외부포트, `.pem` 권한(`chmod 400`) 확인
- 토스 IP 거부: `curl -s https://api.ipify.org` 결과를 허용 IP에 다시 등록
- 알림 안 옴: HTTPS(ngrok)로 접속했는지, 알림 권한, iPhone은 홈화면 추가 후 재시도
