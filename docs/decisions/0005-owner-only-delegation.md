---
status: Accepted
lastReviewed: 2026-07-13
---

# 0005. 소유자 전용 워커 위임

## 맥락

로컬 워커 위임(ADR 0002)은 위임받은 사용자에게 자기 PC 전권(파일/Bash)을 열어준다.
봇과 워커는 같은 `DATABASE_URL`(공유 비밀)로 같은 Postgres에 접속해 `worker_jobs`를
통해 통신한다. 그런데 지금은 워커 요청이 실제로 그 워커의 정당한 소유자 것인지
확인하는 인증(`WORKER_SECRET` 검증)도, 여러 사용자의 작업 큐 행이 서로 섞이지 않게
하는 행 단위 권한 분리(RLS)도 구현돼 있지 않다(`agent/src/config.ts`의
`WorkerConfig.workerSecret`은 "지금은 로드만 한다"고 필드 주석에 명시돼 있다).

이 상태에서 손님 위임을 허용하면, 손님이 `DATABASE_URL`을 손에 넣어 자신의 워커
프로세스를 소유자 신원으로 설정하는 방식으로 소유자를 사칭해 PC 전권을 탈취할 잠재적
경로가 생긴다 — 인증 계층이 없으니 "이 job이 정말 이 워커 소유인가"를 아무도 검증하지
않기 때문이다.

## 결정

위임은 신원(`isOwner`, `userId === config.ownerId`)이 소유자일 때만 실행한다
(`agent/src/core/core.ts:219-232`, 리뷰 #3(HIGH)). `role`이 아니라 신원으로 판정하므로,
`manage_access`로 어떤 사용자에게 `role='owner'`를 부여해도 신원이 소유자와 다르면
위임 대상이 되지 않는다. 조건은 다음과 같다(모두 만족해야 위임).

```
images.length === 0 && isOwner && conv.isPrivate
  && await this.repos.jobs.isOnline(userId, WORKER_ONLINE_CUTOFF_MS)
```

손님 DM은 소유자의 워커가 온라인이더라도 항상 이 봇이 기존(cloud) 도구셋으로 직접
처리한다 — 위임 후보 자체가 되지 않는다. 서버/스레드 대화도 특정 개인 소유가
아니므로 마찬가지로 항상 봇이 처리한다(`isPrivate` 조건). 한도 예약(rate limit)은
위임/직접 두 경로로 분기하기 전에 이미 끝나므로, 손님 한도는 어느 경로든 동일하게
적용된다.

## 근거 (완화 서술)

인증 인프라(`WORKER_SECRET` 검증, RLS)가 갖춰지기 전까지는 공유 비밀
(`DATABASE_URL`) 하나에만 의존하는 신뢰 경계가 완전하지 않다. 그 공백을 코드로
메우는 대신, 정책으로 위임 대상을 소유자 한 명으로 좁혀 사칭 경로 자체를 원천
차단하는 쪽을 택했다 — 손님용 워커를 아예 지원하지 않으면 "누가 그 워커를
소유했는가"를 검증할 필요 자체가 없어진다. 정확한 사칭 절차나 재현 방법은 여기
싣지 않는다(상세는 `docs/security/risk-register.md` §1-§2의 완화 서술 참고).

## 결과

- 커밋 `10aa26d`(`fix(worker): 리뷰 반영 — owner전용 위임·ownWorkstation·job멱등·요약폴백·결과배달·stale회수·마이그레이션·DB시계`).
- `docs/security/risk-register.md` §1(`DATABASE_URL` 취급)·§2(`WORKER_SECRET`/RLS
  미구현)에 같은 위험이 완화 서술로 기록돼 있다.
- `.env.example`과 `deploy/railway-셋업.md`에도 "워커는 소유자 전용"이 명시돼 있다.
- 손님용 워커를 지원하려면 `WORKER_SECRET` 검증과 RLS 구현이 선행돼야 한다 — 별도
  보안 작업이며 현재 범위 밖이다(`docs/superpowers/specs/2026-07-13-documentation-system-design.md`
  §8 비목표).
- 이미지가 있는 턴은 소유자 DM이라도 위임하지 않는다(`images.length === 0` 조건) —
  워커 경로가 아직 멀티모달을 다루지 않기 때문으로, 이 결정과는 별개의 제약이다.
