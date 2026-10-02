# 무료 클라우드 상시 기동 (Oracle Cloud Always Free)

결제(Blaze/유료 VPS) 없이 **PC를 꺼도** 서버를 돌리는 방법입니다.  
이미 있는 Docker + ngrok 구성을 **Oracle 무료 VM**에 올립니다.

> 수익을 보장하지 않습니다. 실주문은 본인 책임입니다.

## 한 줄 요약

1. Oracle에서 **무료 VM** 만들기  
2. SSH로 접속해 이 앱 설치  
3. **출구 IP**를 토스 허용 IP에 등록  
4. 휴대폰에서 ngrok 주소로 접속·알림 켜기  

예상 소요: 처음이면 콘솔 클릭 위주로 진행 (계정 심사에 하루 이상 걸릴 수 있음).

---

## 0) 카드 안내 (중요)

Oracle 가입 시 **본인 확인용 카드**를 요구하는 경우가 많습니다.

| 상황 | 결과 |
|------|------|
| 일반 체크/신용으로 인증 성공 | Always Free 한도 안에서는 **월 요금 0원**으로 유지 가능 |
| 나라사랑카드 등 거절 | Oracle 가입 실패 → 아래 **대안** 참고 |

Always Free 한도(VM 1대 등)만 쓰면 청구되지 않는 것이 정석이지만,  
한도·리전·설정 실수로 유료 자원이 만들어지면 청구될 수 있습니다.  
**Always Free 모양의 VM만** 만들고, 콘솔 청구 알림을 켜 두세요.

나라사랑카드로 실패하면:
- 가족 카드로 **인증만** 도와달라고 요청하거나
- 당분간 **집 PC를 켜 둔 채** `npm run start:always` 사용

---

## 1) Oracle 계정 · 무료 VM

1. https://www.oracle.com/cloud/free/ 접속 → **Start for free**
2. 국가 **Korea**, 이메일·비밀번호 입력 후 가입
3. 로그인 → **Create a VM instance**
4. 권장 설정:
   - **Image**: Ubuntu 22.04 (Minimal 또는 일반)
   - **Shape**: Always Free 배지 있는 것  
     - `VM.Standard.A1.Flex` (Ampere, 권장) 또는  
     - `VM.Standard.E2.1.Micro` (x86)
   - **A1 Flex**: OCPU 1~2, Memory 6~12GB 정도 (Always Free 총량 안에서)
5. **SSH 키**: 새 키 생성 또는 본인 공개키 등록 → **개인키를 꼭 저장**
6. **Assign a public IPv4 address**: Yes
7. Create 후 **Public IP** 메모

### 방화벽 (ngrok 쓸 때)

ngrok만 쓰면 **인바운드 8787 불필요** (SSH 22번만 있으면 됨).

OCI 콘솔 → Compute → Instance → Subnet → **Security List**:
- Ingress: TCP **22** (본인 IP만 허용 권장)

---

## 2) 내 PC에서 .env 준비

집 PC의 `traders-ai/.env`에 최소 아래가 있어야 합니다.

```env
TOSS_CLIENT_ID=...
TOSS_CLIENT_SECRET=...
NGROK_AUTHTOKEN=...
NGROK_DOMAIN=xxxx.ngrok-free.app
```

없으면 `.env.example`을 복사해 채웁니다.

---

## 3) VM에 코드·환경파일 올리기

집 PC 터미널 (경로는 본인 환경에 맞게):

```bash
# SSH (키 파일·IP를 본인 값으로)
ssh -i ~/경로/ssh-key.key ubuntu@PUBLIC_IP

# 접속된 VM 안에서:
sudo apt-get update -qq
sudo apt-get install -y -qq git ca-certificates curl
git clone https://github.com/hahyungjin01-kr/ai-secretary.git
cd ai-secretary/traders-ai
```

집 PC에서 `.env` 전송 (새 터미널):

```bash
scp -i ~/경로/ssh-key.key \
  /집PC에서/traders-ai/.env \
  ubuntu@PUBLIC_IP:~/ai-secretary/traders-ai/.env
```

다시 SSH 세션에서 설치:

```bash
cd ~/ai-secretary/traders-ai
sudo bash scripts/bootstrap-free-cloud.sh
```

성공 시 마지막에 출력됩니다.
- **URL**: `https://<NGROK_DOMAIN>`
- **Egress IP**: 토스에 넣을 주소

---

## 4) 토스 허용 IP

1. 위 출력의 **Egress IP** 복사  
2. 토스증권 → Open API → **허용 IP**에 등록  
3. (선택) 앱의 「등록할 출구 IP 보기」로 한 번 더 확인  

무료 VM IP는 보통 **재부팅해도 유지**됩니다(임시 IP 정책은 콘솔 확인).  
바뀌면 토스에 새 IP를 다시 등록하세요.

---

## 5) 휴대폰

1. `https://<NGROK_DOMAIN>` 열기  
2. **휴대폰 알림 켜기** → 권한 허용  
3. **테스트 알림**  
4. iPhone은 Safari **홈 화면 추가** 후 아이콘으로 열어 알림 설정  

이후 PC를 꺼도 평일 17:30 / 18:00 / 09:05 스케줄이 VM에서 동작합니다.

---

## 자주 쓰는 명령 (VM SSH)

```bash
cd ~/ai-secretary/traders-ai
docker compose --profile tunnel ps
docker compose --profile tunnel logs -f app
# 재배포
git pull
sudo bash scripts/bootstrap-free-cloud.sh
```

중지:

```bash
cd ~/ai-secretary/traders-ai
docker compose --profile tunnel down
```

---

## 가입이 안 될 때

1. **집 PC 상시**: `cd traders-ai && npm run start:always` (절전 금지)  
2. 카드 인증 가능한 계정으로 Oracle만 다시 시도  
3. Firebase Blaze는 카드 등록이 되면 그때 `USAGE.md` Firebase 절 참고  

에이전트는 사용자 대신 Oracle 가입·결제를 할 수 없습니다.  
VM Public IP와 SSH가 준비되면, 그다음 명령 오류 로그만 보내 주시면 이어서 잡아 드립니다.
