---
lastReviewed: 2026-07-13
---

# 리뷰 원장 (Review Ledger)

코드 여러 곳이 `리뷰 #N` / `보안리뷰 #N` 형태로 과거 적대적(opus) 코드 리뷰 라운드를
인용한다(예: `agent/src/core/core.ts:222`의 "리뷰 #3(HIGH)"). 지금까지 이 번호들이
가리키는 원본 리뷰 문서가 리포에 없었다 — 이 파일이 그 정본 인덱스다. 아래 두 라운드는
각각 하나의 커밋으로 한 번에 반영됐으므로, 번호별 항목은 그 커밋의 부분집합이다.

## 리뷰 #1–#7 — 하이브리드 조각3(사용자별 로컬 워커) 리뷰

커밋 `10aa26d` `fix(worker): 리뷰 반영 — owner전용 위임·ownWorkstation·job멱등·요약폴백·결과배달·stale회수·마이그레이션·DB시계`.
로컬 워커 위임 설계(ADR 0002)에 대한 적대적 리뷰에서 나온 확정 결함 7건(HIGH 3·MED 3·
LOW 2)을 TDD(pg-mem)로 고친 라운드다.

| # | 심각도 | 요약 | 코드 위치 |
| --- | --- | --- | --- |
| 1 | HIGH | `makeRunAgentTurn`의 컨텍스트 변환이 인라인 리터럴이라 `ownWorkstation` 필드를 빠뜨림 — 워커가 손님 자신의 PC에서 턴을 실행 중이어도 `allow_dir` 등 PC 관리 도구가 "소유자 DM 전용"으로 오거부됐다. `buildToolCtx` 순수 함수로 분리해 회귀 테스트로 고정. | `agent/src/core/agent.ts:95-104`(`buildToolCtx`) |
| 2 | HIGH | 위임 job을 그 트리거 메시지(`message_id`)로 멱등화. 부분 유니크 인덱스 + advisory lock으로 "조회 후 삽입"을 직렬화 — 봇 크래시 후 `recoverPending`이 같은 메시지를 재위임해도 기존 job에 합류할 뿐 중복 실행되지 않는다. | `agent/src/store/jobsRepo.ts:20,82`; `agent/src/store/schema.ts:173-176`; `agent/src/core/core.ts:319` |
| 3 | HIGH | 위임은 `isOwner`(신원)일 때만 — 손님이 자기 워커를 소유자 ID로 설정해 사칭할 위험을 정책으로 차단. → ADR 0005. | `agent/src/core/core.ts:219-232` |
| 4 | MED | `summarizeAndClose`의 요약 시도를 `try/catch`로 감싸 resume 실패해도 요약만 건너뛰고 compare-and-close는 항상 실행 — 위임 대화가 세션 고착으로 영원히 안 닫히는 문제 해결. | `agent/src/core/core.ts:414` |
| 5a | MED | `worker_jobs.delivered_ts` + `deliverPendingJobResults` 배달 스윕(부팅 1회 + 유휴정리 주기)으로, 타임아웃 뒤 뒤늦게 끝난 job도 결과가 유실되지 않고 compare-and-set으로 정확히 한 번만 발행. | `agent/src/store/jobsRepo.ts:183`; `agent/src/core/core.ts:335,352,356`; `agent/src/index.ts:66`; `agent/src/store/schema.ts:177-179` |
| 5b | MED | `failStaleRunning` — 워커 재기동 시, 지난 프로세스가 claim만 하고 끝내지 못한 자기 고아 `running` job을 `failed`로 회수(5a의 배달 스윕과 맞물려 사용자에게 실패 안내가 감). | `agent/src/worker.ts:57-61`; `agent/src/store/jobsRepo.ts:202` |
| 6 | LOW | `backfillLegacyAllowedDirs` — `allowed_dirs` 테이블 도입 전 `owner.allowedDirs` 단일 settings 키에 있던 소유자 허용 폴더를 멱등 이전. | `agent/src/index.ts:50-52`; `agent/src/store/allowedDirsMigration.ts:6` |
| 7 | LOW | `heartbeat`/`isOnline`이 앱(Node) 시계 대신 DB 서버 시계(`now()`) 기준으로 동작 — 봇/워커 서버 간 클럭 스큐가 온라인 판정에 새지 않는다. | `agent/src/worker.ts:64-65`; `agent/src/store/jobsRepo.ts:154` |

## 보안리뷰 #1–#4 — Phase A(원격 개발 워크플로우) 경로 게이팅 리뷰

커밋 `f3a2d14` `fix(phaseA): 보안리뷰 반영 — Glob pattern 경로집행·cwd 검사·Bash 봉쇄 정직화·심링크 허용폴더`.
소유자 DM의 파일/Bash 도구가 허용 폴더(`allowedDirs`) 밖으로 새는 경로를 막는 경로
게이팅(`docs/security/capability-model.md` "경로 게이팅" 절)에 대한 리뷰다.

| # | 요약 | 코드 위치 |
| --- | --- | --- |
| 1 | `extractCandidatePaths`가 `Glob`의 `pattern` 문자열에서 첫 glob 메타문자 이전까지의 "리터럴 경로 접두"를 후보에 추가 — glob 구현체가 `pattern`에 절대경로나 `..`를 그대로 받아들여 허용 폴더 밖을 열거할 수 있는 우회를 막는다. | `agent/src/core/pathPermission.ts:37-50`(`literalPrefixOfGlobPattern`, `extractCandidatePaths`) |
| 2 | Bash 호출의 `dangerouslyDisableSandbox=true`는 소유자 DM·허용 폴더 상태와 무관하게 무조건 거부 — 이 옵션은 남은 봉쇄(허용 폴더 검사) 자체를 무력화하므로 예외를 두지 않는다. | `agent/src/core/pathPermission.ts:22-26`; `agent/src/core/agent.ts:149` |
| 3 | 후보 경로가 하나도 안 나오면(`Glob`/`Grep`의 `path` 생략, `Bash`의 `blockedPath` 없음 등) `cwd`를 후보로 대신 넣어 검사 — "빈 배열=허용"이라는 과도한 신뢰를 제거. | `agent/src/core/pathPermission.ts:53-54,83-85` |
| 4 | `allowDirHandler`가 폴더 등록 전 `fs.realpathSync`로 실경로화해 저장 — 심볼릭 링크/정션으로 등록하면 `canUseTool`의 realpath 후보와 어긋나 통째로 과차단되던 문제 해결. | `agent/src/core/tools.ts:84-88` |

## 그 외 적대적 리뷰 라운드 (번호 없음)

위 두 라운드처럼 코드 주석에 개별 번호가 남아 있지는 않지만, 같은 성격(opus 기반
적대적 다중에이전트 리뷰 → 확정 결함 수정)의 커밋들이다. 참고용으로만 기록한다.

| 커밋 | 제목 |
| --- | --- |
| `15907fb` | `fix(persona): 최종리뷰 반영 — messages(user_id,role) 인덱스 + 테스트파일 정리 + 스펙 정정` |
| `b939679` | `fix(pg): 리뷰 반영 — 크래시복구(ingest/turn 분리)·어댑터 순서직렬화·검색 오매칭·미사용 의존성` |
| `8457e8a` | `fix: 코드리뷰 반영 — 예외 시 종료이벤트 보장·봇 반응만 제거·상태라인 상한` |
| `fcf7e5f` | `fix(2b): 적대적 코드리뷰 확정 4건 반영` |
| `2fa2f81` | `docs: 설계 v2 — 적대적 리뷰 26건 반영 (프라이버시 불변식·동시성·인젝션 방어)` |
| `7a91258` | `fix: 적대적 리뷰 검증 결함 11건 수정 (동시성/FTS/엣지케이스)` |

## 관련 문서

- 능력 계층·경로 게이팅·READ ONLY SQL 가드 전체 그림: `docs/security/capability-model.md`
- 알려진 한계(완화 서술): `docs/security/risk-register.md`
- 이 라운드들이 뒷받침하는 결정: `docs/decisions/0002-railway-local-worker-hybrid.md`,
  `docs/decisions/0005-owner-only-delegation.md`
