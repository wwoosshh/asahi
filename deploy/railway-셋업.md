# Railway로 Asahi 상시 구동하기

로컬 PC(PM2) 대신 Railway(클라우드)에서 봇을 24/7 띄우는 절차. 코드는 GitHub(`wwoosshh/asahi`)
리포를 그대로 쓰고, `agent/Dockerfile`(멀티스테이지)로 빌드한다. 실제 데이터(유저·대화·기억)는
Supabase Postgres에 있으므로 컨테이너 자체는 상태를 갖지 않는다(stateless) — 재배포돼도 데이터가
사라지지 않는다.

## 사전 확인 사항

- `agent/Dockerfile`, `agent/.dockerignore` 가 이미 리포에 있다(이 문서와 같은 커밋).
- Supabase 프로젝트가 준비돼 있고 **Session pooler** 연결 문자열을 발급받을 수 있어야 한다
  (아래 "DATABASE_URL" 항목 참고 — Direct connection 은 쓰지 않는다).
- `claude setup-token` 으로 발급한 구독 OAuth 토큰(`CLAUDE_CODE_OAUTH_TOKEN`)이 있어야 한다.

## 1. Railway 프로젝트 생성 + GitHub 연동

1. [railway.com](https://railway.com) 로그인 → **New Project** → **Deploy from GitHub repo** →
   `wwoosshh/asahi` 리포 선택(최초 1회 GitHub App 권한 승인 필요).
2. 리포가 모노레포(루트에 `agent/`, `data/`, `deploy/`, `docs/` 등이 같이 있음)이므로, 서비스가
   `agent/` 아래 코드만 보고 빌드하도록 **Root Directory** 를 지정해야 한다.
3. 생성된 서비스 카드 클릭 → **Settings** 탭 → **Source** 섹션의 **Root Directory** 에 `agent`
   입력 → 저장.
   - 이렇게 하면 빌드 컨텍스트가 `agent/` 가 되고, Railway 는 그 안에서 `Dockerfile` 을
     자동으로 찾아 쓴다(파일명이 정확히 `Dockerfile` 이어야 함 — 이미 그렇게 되어 있음).
     별도로 Dockerfile 경로를 지정할 필요가 없다.
   - **대안(Root Directory 를 안 쓰고 싶은 경우)**: Root Directory 를 비워 리포 루트로 두고,
     서비스 **Variables** 에 `RAILWAY_DOCKERFILE_PATH=agent/Dockerfile` 를 추가하는 방법도
     있다. 다만 이 경우 빌드 컨텍스트가 리포 루트가 되므로 `agent/Dockerfile` 안의 `COPY` 경로를
     전부 `agent/` 접두사를 붙이게 바꿔야 한다(현재 Dockerfile 은 컨텍스트=`agent/` 전제로
     작성됨). 특별한 이유가 없으면 **Root Directory=agent 방식을 권장**한다.
4. Builder 는 Dockerfile 이 있으면 Railway 가 자동으로 Dockerfile 빌더를 쓴다(Nixpacks 로
   바뀌어 있으면 Settings → Build → Builder 를 Dockerfile 로 바꾼다).

## 2. 환경변수(Variables) 설정

서비스 → **Variables** 탭에서 아래를 추가한다(`.env` 파일은 이미지에 넣지 않으므로 전부 여기서
직접 입력).

| 변수 | 필수 | 설명 |
|---|---|---|
| `DISCORD_TOKEN` | 예 | 디스코드 봇 토큰 (Discord Developer Portal → Bot). **로컬 PM2 봇과 같은 토큰을 그대로 쓴다면 반드시 로컬을 먼저 멈춰야 한다** — 아래 "봇은 한 번에 한 곳만" 참고. |
| `DISCORD_OWNER_ID` | 예 | 소유자(본인) 디스코드 사용자 ID |
| `DATABASE_URL` | 예 | Supabase **Session pooler** 연결 문자열. 아래 별도 설명 참고 |
| `CLAUDE_CODE_OAUTH_TOKEN` | 예(사실상) | `claude setup-token` 으로 발급한 구독 OAuth 토큰. 없으면 에이전트 SDK 가 인증 못 해 턴 처리가 실패한다 |
| `DEPLOY_TARGET` | 예 | 반드시 `cloud` 로 설정. local(기본값)로 두면 안 됨 — 아래 "cloud 배포 시 동작 차이" 참고 |
| `DISCORD_CHANNEL_ID` | 선택 | DM 외에 반응할 서버 채널 ID |
| `DATA_DIR`, `MEMORY_DIR` | 아니오(설정 금지) | Dockerfile 이 이미 `/data/store`, `/data/memory` 로 고정해 둔다. 굳이 다시 지정할 필요 없음 — 지정하면 그 값으로 덮어써지므로 컨테이너 안 실제 존재하는 절대경로가 아니면 오히려 문제가 될 수 있다 |
| `SESSION_IDLE_MINUTES`, `MAX_TURNS_PER_HOUR_PER_USER`, `MAX_TURNS_PER_HOUR_GLOBAL` 등 | 선택 | 비워두면 기본값(각각 30분/20/40). 필요할 때만 조정 |

### DATABASE_URL — 반드시 Session pooler를 쓴다

Supabase 대시보드 → **Project Settings → Database → Connection string** 에서 두 가지가 보인다:

- **Direct connection**(`db.<project-ref>.supabase.co:5432`) — **쓰지 않는다**. IPv6 전용이라
  Railway 컨테이너(IPv4 egress)에서 연결이 실패한다.
- **Session pooler**(`aws-0-<region>.pooler.supabase.com:5432`, 사용자명이
  `postgres.<project-ref>` 형태) — **이걸 쓴다**. IPv4 로 붙을 수 있고, `pg` 라이브러리의
  `Pool` 과도 호환된다(트랜잭션 풀러가 아니라 세션 풀러라 `pg_advisory_xact_lock` 등 세션 상태가
  필요한 쿼리도 문제없다).

`DATABASE_URL` 값 형태 예시(실제 값은 Supabase 에서 복사):
```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

## 3. 봇은 한 번에 한 곳만 — 반드시 지킬 것

디스코드 봇 토큰은 하나뿐이다. **로컬 PM2 봇과 Railway 봇을 동시에 실행하면 게이트웨이 세션이
충돌**한다(다른-PC-셋업.md 와 같은 제약). Railway 로 옮기기 전에 로컬을 반드시 멈춘다:

```powershell
pm2 stop asahi-assistant
```

그다음 Railway 배포를 진행한다. 되돌리고 싶으면 반대로 Railway 서비스를 멈추고(Settings →
Danger/Remove 또는 배포 일시중지) 로컬에서 `pm2 restart asahi-assistant`.

## 4. 배포 및 확인

- Root Directory·Variables 저장 후 Railway 가 자동으로 첫 빌드/배포를 시작한다(또는 **Deploy**
  버튼으로 수동 트리거).
- 서비스 → **Deployments** → 최신 배포 → **View Logs** 에서 다음을 확인:
  - 빌드 로그: `npm ci`, `npm run build`(tsc) 성공, 이미지 생성 완료.
  - 런타임 로그: `"[discord] 로그인 완료"`(또는 동일한 취지의 로그인 성공 메시지)와
    `"상주 비서가 시작되었습니다."` 가 찍히면 정상.
  - 만약 `환경변수 누락: ...` 에러가 보이면 Variables 탭 재확인, `ECONNREFUSED`/`ENETUNREACH`
    류 DB 연결 에러가 보이면 `DATABASE_URL` 이 Session pooler 형식인지, 비밀번호에 특수문자가
    URL 인코딩됐는지 확인한다.
- 재배포는 그냥 `git push`(main 브랜치 기준) — Railway 가 웹훅으로 감지해 자동 재빌드한다.
  수동으로 다시 배포하려면 Deployments 탭에서 **Redeploy**.

## cloud 배포 시 동작 차이(중요)

`DEPLOY_TARGET=cloud` 로 실행하면, 소유자와의 1:1 DM 이라도 **PC 파일·Bash(셸) 도구가
비활성화**된다(로컬 PM2 운영의 Phase A "허용 폴더 내 파일·셸" 기능). 이 상태에서 그런 작업을
요청하면 봇이 "클라우드 실행 중이라 PC 작업은 로컬 워커 연결 후 가능해요." 라고 안내한다(코드
상 이미 구현됨 — `agent/src/core/agent.ts`, `agent/src/core/persona.ts`). PC 파일 조작이 필요한
작업은 로컬 워커 연동(별도 조각, 아직 미구현) 전까지는 로컬 PM2 운영으로 처리해야 한다. 대화,
기억(메모리), 사용량 한도 등 나머지 기능은 로컬과 동일하게 동작한다.

## 컨테이너 경로 설계 메모 (참고용)

`agent/src/index.ts`, `agent/src/config.ts` 는 원래 로컬 PM2 운영 전제(cwd=`agent/`, 리포
루트가 그 부모)로 `path.resolve("..", "data", ...)` 같은 상대경로를 쓴다. 컨테이너에는 그 리포
루트 형제 디렉터리가 없으므로, `agent/Dockerfile` 이 `DATA_DIR=/data/store`,
`MEMORY_DIR=/data/memory` 를 이미지 레벨 ENV 로 고정해 그 상대참조를 절대경로로 대체한다(소스
수정 없음). `agentCwd`(에이전트 작업용 임시 디렉터리)도 `DATA_DIR` 기준으로 파생되므로 함께
해결된다. `/data` 자체에 영속 볼륨을 붙일 필요는 없다 — 실제 상태는 전부 Supabase 에 있고,
`/data` 는 재배포 시 사라져도 되는 임시 공간이다.
