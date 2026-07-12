---
lastReviewed: 2026-07-13
---

# 로컬 워커 셋업 (하이브리드 조각3)

cloud(Railway, `DEPLOY_TARGET=cloud`)로 띄운 봇은 컨테이너 안에서 실행되므로 소유자 PC 의
파일·Bash 도구를 쓸 수 없다. **로컬 워커**(`agent/src/worker.ts`)는 소유자 자신의 PC에서 따로
띄우는 별도 프로세스로, cloud 봇이 소유자 DM에서 받은 PC 작업 요청을 이 워커에 위임
(delegate)하면 워커가 그 PC 위에서 실제로 실행한다. 디스코드 연결은 하지 않고, Postgres
(`DATABASE_URL`)에 쌓이는 `worker_jobs` 를 폴링해서 job 을 처리한다 — 자세한 위임 조건은
[deploy/railway-셋업.md](railway-셋업.md)의 "cloud 배포 시 동작 차이" 절 참고.

## 사전 요구

- **Node.js 22 이상**, 리포가 이미 클론돼 있고 `agent/` 에 `npm install` 이 끝난 상태
  (다른 PC에 새로 셋업하는 경우 [deploy/다른-PC-셋업.md](다른-PC-셋업.md) 먼저 참고).
- 봇(cloud 또는 로컬 PM2)이 쓰는 것과 **같은** `DATABASE_URL`. 워커는 이 값으로 봇과 같은
  Postgres(Supabase)를 정본 상태 저장소로 공유한다.

## .env 설정

리포 루트 `.env` (`asahi\.env`)에 다음 세 값이 필요하다 — 하나라도 비어 있으면 워커가 시작
시점에 `환경변수 누락: ...` 에러로 즉시 종료한다(`agent/src/config.ts` `loadWorkerConfig`).

| 변수 | 설명 |
|---|---|
| `DATABASE_URL` | 봇과 동일한 Supabase Session pooler 연결 문자열 |
| `DISCORD_OWNER_ID` | 소유자 본인의 디스코드 사용자 ID — 신원(`isOwner`) 판정용, 봇과 같은 값이어야 한다 |
| `WORKER_USER_ID` | 이 워커가 담당할(=job 을 claim 할) 디스코드 사용자 ID |

**중요(소유자 전용 정책): `WORKER_USER_ID`는 반드시 소유자 자신의 디스코드 ID여야 한다** —
즉 `DISCORD_OWNER_ID`와 같은 값. 손님 ID를 넣어도 동작하지 않는다: 위임 여부는 봇
(`agent/src/core/core.ts`)이 대화 상대의 신원이 `isOwner`인지로만 판단하므로, 손님 DM은 워커가
온라인이어도 절대 위임되지 않고 항상 cloud 봇이 직접 처리한다. `WORKER_SECRET`(옵션)은 현재
로드만 하며, 손님용 워커를 지원하려면 필요한 인증 인프라(WORKER_SECRET 검증·행 단위 권한)는
아직 구현돼 있지 않다.

## 실행

```powershell
cd agent
npm run build
npx tsx src/worker.ts
```

- `npm run build`(tsc)로 `dist/`를 만든 뒤에는 `node dist/worker.js`로도 띄울 수 있다.
- 지금은 `package.json`에 전용 `npm run worker` 스크립트가 아직 없다(추가 예정) — 그 전까지는
  위처럼 `npx tsx src/worker.ts`(빌드 없이 즉시 실행) 또는 빌드 후 `node dist/worker.js`를 쓴다.
- PM2로 상시구동(`asahi-worker` 앱)하는 절차도 같은 후속 작업에서 `deploy/ecosystem.config.cjs`에
  추가될 예정이며, 그때까지는 터미널에서 직접(또는 자체 PM2 설정으로) 띄워 둔다.

## 검증

1. 워커 콘솔에 `로컬 워커가 시작되었습니다 (WORKER_USER_ID=...)`가 찍히면 정상 기동이다.
2. 워커는 10초 간격으로 하트비트를 DB에 기록한다. 봇은 이 하트비트가 30초(하트비트 주기의 3배,
   `WORKER_ONLINE_CUTOFF_MS`) 안이면 그 사용자의 워커를 "온라인"으로 본다
   (`agent/src/core/core.ts`) — 워커를 막 띄운 직후에도 기동 시 즉시 1회 하트비트를 찍으므로
   곧바로 온라인으로 잡힌다.
3. 소유자 본인 계정으로 봇에 1:1 DM을 보내 PC 작업(파일 읽기·Bash 실행 등)을 요청한다. 워커가
   온라인이면 봇이 직접 처리하지 않고 이 워커에 위임(delegate)해서, 진행/결과가 워커 PC에서
   실행된 뒤 디스코드로 전달된다.
4. 워커를 내려둔 채로 같은 요청을 보내면(오프라인), cloud 봇은 위임하지 못하고 "클라우드
   실행 중이라 PC 작업은 로컬 워커 연결 후 가능해요." 안내로 대체한다 — 대화·기억 등 나머지
   기능은 그대로 동작한다.
5. 종료는 `Ctrl+C`(SIGINT). 진행 중이던 job은 마저 끝낸 뒤 DB 연결을 정리하고 종료한다.

## 보안

`DATABASE_URL`은 소유자만 소지해야 한다. 손님에게 공유하면 그 손님이 직접 워커를 띄우고
`WORKER_USER_ID`를 소유자 ID로 설정해 소유자를 사칭, PC 전권(파일/Bash)을 탈취할 수 있다 —
자세한 위협 성격과 완화책은 [docs/security/risk-register.md](../docs/security/risk-register.md)
"1. `DATABASE_URL` 취급" 절 참고.
