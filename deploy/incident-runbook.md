---
lastReviewed: 2026-07-13
---

# 장애 대응 런북 (증상 → 원인 → 조치)

Asahi 는 크래시·재배포·워커 단절 같은 상황에서 스스로 복구하도록 설계돼 있다. 그 복구 동작이
겉보기엔 "이상 현상"처럼 보일 수 있어서, 이 문서는 먼저 **"정상 자기치유"와 "진짜 장애"를
구분**하는 데 목적이 있다. 1절 표에 해당하면 대부분 아무 조치도 필요 없다. 2절부터는 실제로
손을 대야 하는 경우(재시작·롤백·Supabase 문제)를 다룬다.

## 1. 자기치유 동작 — 대부분 정상, 조치 불필요

| 증상 | 원인(코드) | 정상 여부 | 조치 |
|---|---|---|---|
| 재배포/재시작 직후, 그 사이 밀려 있던 사용자 메시지에 응답이 한꺼번에 온다 | 부팅 시 `recoverPending()` 1회 호출(`agent/src/index.ts` → `agent/src/core/core.ts`) — 크래시 등으로 `processed=false`로 남은 사용자 메시지를 그 대화 문맥 그대로 재개한다 | 정상 | 조치 불필요. 재배포가 유난히 잦다면 그 자체(크래시 루프)를 별도로 조사한다. |
| 로컬 워커에 위임한 작업의 결과가 최대 1분 정도 늦게 도착한다 | `deliverPendingJobResults()` — `agent/src/index.ts`의 60초 간격 `setInterval`(유휴 정리 `closeIdleConversations`와 같이 돎)이, 아직 배달되지 않은(`delivered_ts` 없음) job 결과를 대신 발행한다 | 정상 | 조치 불필요. |
| 워커를 재시작했더니 재시작 직전에 요청했던 작업이 "워커가 재시작되어 이전 작업이 유실됐어요. 다시 요청해 주세요."로 안내된다 | `failStaleRunning()` — `agent/src/worker.ts` 기동 시 1회, 지난 프로세스가 `claim`한 뒤 끝내지 못하고 죽어 `running`으로 고아가 된 job을 `failed`로 되돌린다(결과를 조용히 잃어버리지 않기 위한 안전장치) | 정상 | 조치 불필요. 안내대로 같은 요청을 다시 보내면 된다. |
| "아직 처리 중이에요. 끝나면 이어서 알려드릴게요."를 받은 뒤 한참 지나서(길게는 수 분) 실제 답이 온다 | `delegateToWorker`의 120초(`WORKER_TIMEOUT_MS`) 폴링이 타임아웃돼 먼저 안내만 보내고, 이후 워커가 실제로 끝내면 위 `deliverPendingJobResults` 스윕이 결과를 대신 배달한다(`agent/src/core/core.ts`) | 정상 | 조치 불필요. 워커가 정말 멈췄는지 의심되면 `deploy/worker-셋업.md`의 검증 절(하트비트 30초 온라인 판정)로 확인. |
| 대화가 이전 문맥을 기억 못 하고 처음부터 다시 시작한 것처럼 한 번 답한다 | `isSessionNotFound()`(`agent/src/core/turnPrep.ts`)가 SDK 응답의 `"No conversation found with session ID"` 에러를 감지 — 세션 저장소가 초기화된 경우(클라우드 컨테이너 재배포 등) 그 세션을 버리고 새 세션 + 기억/요약/최근대화 컨텍스트로 즉시 재시도한다(`core.ts`의 봇 경로, `worker/jobRunner.ts`의 워커 경로 둘 다 동일 정책) | 1회성이면 정상 | 조치 불필요. **반복적으로** 매 턴 세션을 잃는다면 아래 "반복될 때" 참고. |

## 2. 반복되거나 진짜 장애일 때

1절 동작이 **한 번이 아니라 매번 반복**되거나, 안내 메시지 없이 아예 응답이 오지 않는다면
자기치유로 흡수되지 않는 문제일 수 있다.

- **세션을 매번 새로 잃는다(위 5번 행이 반복)**: 컨테이너가 재배포 사이에 세션 저장소를
  영속시키지 못하고 있을 가능성. `/새세션`(별칭 `/새대화`, `/새로시작`, `/reset`)으로 사용자가
  직접 새 세션을 강제하고, 그래도 반복되면 3절대로 재배포 후 다시 확인한다.
- **위임 결과가 계속 60초를 넘겨도 안 온다(위 2·4번이 반복)**: 워커가 죽어 있거나
  `heartbeat`가 끊겼을 가능성 — `deploy/worker-셋업.md`의 검증 절대로 워커 콘솔·하트비트를
  확인하고 필요하면 워커 프로세스를 재기동한다.
- **응답 자체가 없고 로그도 안 찍힌다**: DB 연결 문제일 가능성이 높다 → 4절 Supabase
  트러블슈팅으로 이동.
- **`환경변수 누락: ...` 에러로 프로세스가 즉시 종료된다**: `.env`(로컬) 또는 Railway
  Variables 설정 누락 — `deploy/railway-셋업.md`(cloud), `deploy/worker-셋업.md`(워커)의
  변수 표 재확인.

## 3. 안전 재시작

### Railway(cloud, 24/7 운영)

- **코드 반영 재배포**: `git push`(main 브랜치) — Railway가 웹훅으로 감지해 자동 재빌드·재배포한다.
- **수동 재배포(코드 변경 없이 프로세스만 새로)**: 서비스 → **Deployments** 탭 → 최신 배포
  우측 메뉴 → **Redeploy**.
- 컨테이너는 stateless이므로(실제 상태는 Supabase에 있음) 재시작 자체로 데이터가 사라지지
  않는다 — 재시작 직후엔 1절의 `recoverPending`/`deliverPendingJobResults`가 자동으로 밀린
  것을 정리한다. 자세한 배포 절차는 `deploy/railway-셋업.md` 참고.

### PM2(로컬 폴백)

```powershell
pm2 restart asahi-assistant           # 재시작만(소스 변경 없을 때)
cd E:\Asahi\agent
npm run build                          # 소스를 고쳤다면 재시작 전에 반드시 빌드
pm2 restart asahi-assistant
pm2 logs asahi-assistant --lines 20    # "[discord] 로그인 완료" 확인
```

전체 명령·문제 진단 팁은 `deploy/PM2-명령어.md` 참고. **로컬 PM2와 Railway를 동시에 띄우면
디스코드 게이트웨이 세션이 충돌**하므로, 한쪽을 올릴 땐 반드시 다른 쪽을 먼저 멈춘다.

## 4. Railway 롤백(배포 직후 문제 발생 시)

새 배포 직후 에러 로그가 반복되거나 봇이 아예 못 뜨면, 코드를 되돌리기보다 먼저 **직전 정상
배포로 롤백**하는 편이 빠르다:

1. 서비스 → **Deployments** 탭에서 배포 이력을 확인한다(각 항목이 커밋에 대응).
2. 마지막으로 정상이었던(로그에 `"상주 비서가 시작되었습니다."`가 찍혔던) 배포 항목을 찾는다.
3. 그 항목의 우측 메뉴에서 **Redeploy**(또는 동일 커밋 재배포)를 선택해 그 시점 이미지로
   되돌린다.
4. 컨테이너는 stateless라 어느 배포로 롤백해도 Supabase의 데이터(유저·대화·기억)는 그대로다 —
   되돌린 뒤 원인은 로그(**View Logs**)로 별도 분석해 코드로 고친 다음 다시 `git push`한다.

## 5. Supabase 트러블슈팅 결정 트리

DB 연결 관련 증상이 보이면(로그인은 되는데 응답이 전혀 없음, 부팅 자체가 안 됨, 간헐적
타임아웃 등) 아래 순서로 좁혀 간다.

1. **무료 티어 자동 정지(pause)인가?** — 한동안 요청이 없던 Supabase 무료 프로젝트는 자동으로
   일시정지될 수 있다. Supabase 대시보드에서 프로젝트가 "Paused" 상태로 보이면 **Restore
   project**로 재개한다. 재개 직후 몇 분간은 콜드스타트로 첫 연결이 느릴 수 있다.
2. **풀 고갈(pool exhaustion)인가?** — 봇(Railway)과 로컬 워커가 **같은** `DATABASE_URL`
   (Session pooler)을 공유해서 커넥션 풀을 나눠 쓴다. 봇+워커+로컬 개발 접속이 겹치는
   시점에 간헐적으로 연결 실패/지연이 난다면 Supabase 대시보드 **Database → Connection
   pooling** 에서 현재 연결 수를 확인한다. 원인이 여기라면 불필요하게 떠 있는 워커/개발
   연결부터 정리한다.
3. **`ECONNREFUSED`/`ENETUNREACH`가 로그에 보이는가?** — `DATABASE_URL`이 **Direct
   connection**(`db.<project-ref>.supabase.co:5432`, IPv6 전용)으로 잘못 설정된 경우가
   가장 흔한 원인이다. Railway/워커 모두 IPv4 egress이므로 반드시 **Session pooler**
   (`aws-0-<region>.pooler.supabase.com:5432`) 형식으로 바꾼다 — 자세한 값 형식은
   `deploy/railway-셋업.md`의 "DATABASE_URL — 반드시 Session pooler를 쓴다" 절 참고.
4. **자격증명(비밀번호)을 회전해야 하는가?** — 유출 의심 등으로 DB 비밀번호를 바꿔야 한다면:
   1. Supabase 대시보드 → **Project Settings → Database** 에서 비밀번호를 재설정하고 새
      연결 문자열을 복사한다(비밀번호에 특수문자가 있으면 URL 인코딩됐는지 확인).
   2. Railway 서비스 **Variables**의 `DATABASE_URL`을 새 값으로 교체 → 자동 재배포.
   3. 로컬 워커/PM2를 쓰고 있다면 그 PC의 `.env`도 같은 값으로 동시에 갱신하고 재시작한다
      (`deploy/다른-PC-셋업.md`, `deploy/worker-셋업.md` 참고) — 한쪽만 갱신하면 그쪽은
      옛 비밀번호로 연결이 실패한다.
   4. `DATABASE_URL`은 소유자만 소지해야 하는 값이다 — 유출 위협 성격은
      `docs/security/risk-register.md` "1. `DATABASE_URL` 취급" 절 참고.
