---
status: Accepted
lastReviewed: 2026-07-13
---

# 0001. SQLite → Postgres 이전

## 맥락

1단계 초기 설계는 `better-sqlite3` 기반 단일 파일 DB + FTS5 가상테이블(전문 검색)을
전제로 했다. 이는 "소유자 PC에서 단일 프로세스가 상시 구동"하는 모델에서는 충분했지만,
이후 비서를 Railway 클라우드 컨테이너에서 24/7 구동하고(`docs/architecture/overview.md`),
소유자 PC의 로컬 워커와 상태를 공유해야 하는 하이브리드 구조(ADR 0002)로 나아가면서
전제가 깨졌다 — 파일 기반 SQLite는 프로세스 간·기기 간에 공유될 수 없다.

## 결정

저장소를 Postgres(Supabase)로 이전한다. `agent/src/store/db.ts`가 `pg`(node-postgres)의
`Pool`을 `Db` 타입으로 감싸고, 운영에서는 실제 Supabase 연결 문자열(`DATABASE_URL`)로,
테스트에서는 `pg-mem`이 만드는 pg 호환 `Pool`(`openTestDb`)로 동일한 `query(text, params)`
인터페이스를 쓴다.

`agent/src/store/schema.ts:3-9`의 주석대로, 기존 SQLite 스키마와 새 스키마를 하나의
`SCHEMA_SQL`로 합치며 다음을 바꿨다.

- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- 불리언 의미 컬럼(`is_private`, `processed`, `private_memory_loaded`) → `BOOLEAN`
- FTS5 가상테이블(`messages_fts`/`events_fts`)과 트리거 제거. 스키마 주석은 애초
  "검색은 이후 태스크에서 ILIKE 로 구현한다"고 적었으나(`schema.ts:7`), 실제 구현
  (`agent/src/store/messagesRepo.ts`, `agent/src/store/memoriesRepo.ts`)은
  `strpos(lower(x), lower(y)) > 0`을 쓴다 — `pg-mem` 스파이크에서 `ILIKE`의 `ESCAPE`
  절 파싱 실패와, 검색어 속 `%`/`_`가 이스케이프 없이 항상 와일드카드로 해석돼
  오매칭이 나는 문제를 발견했기 때문이다(`agent/src/store/db.ts:41-46`). `strpos`는
  순수 부분문자열 위치 검색이라 와일드카드 해석 자체가 없어 이 문제가 원천적으로
  없다.
- 1단계 호환 테이블(`events`/`summaries`)과 그 유일한 소비자였던 legacy
  `Repo`(`better-sqlite3`)는 "새로 시작" 정책(T3)에 따라 제거했다.
- 원자적 예약(rate limit 카운트-후-삽입, 위임 job 멱등 삽입)은
  `pg_advisory_xact_lock`으로 구현한다(`agent/src/store/turnsRepo.ts`의
  `RESERVE_LOCK_KEY`, `agent/src/store/jobsRepo.ts`의 `ENQUEUE_LOCK_KEY`/
  `CLAIM_LOCK_KEY`) — 단일 프로세스 SQLite에서는 필요 없던 전역 직렬 지점이,
  다중 커넥션(봇+워커)이 같은 Postgres에 동시 접속하는 구조에서는 필수가 됐다.

## 근거

- **클라우드 상시 구동**: Railway 컨테이너는 파일시스템이 재배포마다 초기화될 수 있는
  무상태(stateless) 환경이라, 대화·기억·작업 큐가 컨테이너 로컬 파일에 있으면 데이터가
  유실된다.
- **다PC 공유**: 클라우드 봇과 소유자 PC의 로컬 워커(ADR 0002)가 같은 대화·설정 상태를
  실시간으로 봐야 한다. 파일 기반 DB로는 별도 동기화 계층 없이는 불가능하지만,
  네트워크로 붙는 중앙 Postgres는 이 문제를 애초에 만들지 않는다.

## 결과

- 커밋 `cb28bea`(`feat(pg): db 계층 pg Pool + Postgres 스키마 + pg-mem 테스트 + SettingsRepo 파일럿`),
  `ffae8a0`(`feat(pg): 호출부 await 전파 + config DATABASE_URL + migrate 제거 — Postgres 이전 완료`).
- `agent/package.json`에 `pg` 의존성(`^8.22.0`) 추가.
- `pg-mem`은 `pg_advisory_xact_lock`(no-op)과 `strpos`를 직접 스텁으로 등록해야 했고
  (`db.ts:29-57`), SQL 레벨 `ROLLBACK`도 실제로 되돌리지 않는다(`db.ts:85-87`) — 이런
  차이 때문에 "동시 예약이 advisory lock으로 정말 직렬화되는지", "쓰기 트랜잭션이
  에러 시 정말 롤백되는지" 같은 보장은 유닛테스트가 아니라 실제 Postgres를 쓰는
  통합/스모크 테스트로만 검증할 수 있다.
- `SET TRANSACTION READ ONLY`도 `pg-mem`이 파싱하지 못하는 문법 중 하나다 — 자기조회
  READ ONLY 트랜잭션 방어의 검증 범위는 ADR 0004를 참고.
