# 멀티유저 · 자기인지 데이터 기반 설계 (2단계 재정의)

- **작성일**: 2026-07-11
- **상태**: 설계 확정(사용자 승인) — 구현 대기
- **선행**: 1단계 완료([2026-07-11-pc-ai-assistant-design.md](./2026-07-11-pc-ai-assistant-design.md), [1단계 계획](../plans/2026-07-11-phase1-core-discord.md))
- **비고**: 원래 로드맵의 2단계(파일/셸·브라우저 MCP)보다 이 작업을 **앞으로 당김**. 파일/셸·브라우저는 이후 단계로 이동.

## 1. 개요와 목표

1단계의 "소유자 DM 전용, 전역 세션 1개, 마크다운 기억"을 넘어, **여러 사용자를 개별로 기억하고 서버에서 사람처럼 활동하며, 자신의 상태·구조를 DB로 정확히 인지하는** 비서로 확장한다.

- 소유자 + 허용 목록 사용자와 대화(DM + 서버 @멘션 → 스레드).
- 사용자를 **개별로** 기억(프라이버시 경계 강제).
- 대화·기억·로그·에러·AI작업·백업·(능동)트리거를 **정규화된 SQLite 스키마**로 관리.
- 비서가 **자기 DB를 읽고(SELECT) 구조를 조회**해 자신의 상태(예: 실시간 남은 한도)를 추측이 아닌 실측으로 안내.
- 세션이 바뀌고 재부팅해도 기억이 이어진다(1단계 원칙 유지).

## 2. 확정된 결정 사항

| 항목 | 결정 |
|---|---|
| 진행 방식 | 전체 스키마를 지금 설계, 구현은 단계적(2A~2E) |
| 응답 대상 | **소유자 + 허용 목록**만. 그 외 무응답. (+ 유저별·전역 시간당 한도) |
| 기억 경계 | **소유자는 전체 열람, 손님끼리는 개별 분리.** 대화 상대에게 타인 사생활 미노출은 공통 전제 |
| 서버 행동 | @멘션 → 그 메시지에 **스레드 생성** → 스레드 안에서 계속 대화(멘션 불필요). DM도 지원 |
| 사람다움 | 반응형 + **능동형(먼저 말 걸기)**. 데이터 모델은 지금 설계, 능동 실행은 2E |
| 스키마 접근 | **A. 정규화 관계형** (관심사별 테이블 분리) |
| 자기 DB 접근 | 읽기(SELECT)는 자유(소유자), 쓰기는 **검증된 목적별 도구**로만. raw 쓰기 SQL 미제공 |
| 손님 능력 제한 | 허용 손님은 **대화 + 본인 기억만**. 파일·셸·코드·브라우저·PC조작·`db_query`는 **소유자 전용**. 턴별 role로 `allowedTools` 결정 |

## 3. 아키텍처 개요

1단계의 3층(어댑터 · 코어 · 저장소) 구조와 이벤트 버스는 유지한다. 확장 지점:

- **어댑터(discord)**: DM만 → DM + 서버 @멘션 감지 + 스레드 생성/추적. 들어온 메시지를 `(user_id, discord_channel_id)`로 식별해 이벤트에 실어 보냄.
- **코어**: 전역 세션 1개 → **대화(conversation)별 세션**. 역할 게이트, 유저별 기억 주입(프라이버시 스코프), 유저별 한도.
- **저장소**: 최소 스키마 → 정규화 스키마(§4). store/repo를 관심사별 리포지토리로 분리.
- **도구 계층(신규)**: 비서가 호출하는 인앱 도구(§7) — 기억·자기인지·접근관리 등. Agent SDK의 커스텀 도구(또는 인프로세스 MCP)로 제공하고, 권한 훅으로 owner/allowed를 구분.

## 4. 데이터 모델 (SQLite, WAL + FTS5)

모든 시각은 epoch ms(INTEGER). 디스코드 ID는 스노플레이크라 TEXT로 저장. 스키마 버전은 `meta` 테이블로 관리하고 버전별 마이그레이션을 순차 적용한다.

### 4.1 정체성 · 대화 · 메시지

**users**
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | TEXT PK | 디스코드 사용자 ID |
| role | TEXT | `owner` \| `allowed` \| `blocked`. 응답 게이트 |
| display_name | TEXT | 마지막으로 본 이름 |
| created_ts, updated_ts | INTEGER | |

**conversations** — 하나의 대화 공간 = 하나의 세션
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| kind | TEXT | `dm` \| `thread` |
| discord_channel_id | TEXT UNIQUE | 들어온 메시지 매핑 열쇠 (DM 채널 or 스레드 ID) |
| guild_id | TEXT NULL | 서버 ID (DM이면 NULL) |
| parent_channel_id | TEXT NULL | 스레드의 부모 채널 |
| primary_user_id | TEXT | 이 대화의 주 상대 → 유저별 기억 귀속 |
| title | TEXT NULL | |
| session_id | TEXT NULL | 이 대화 전용 Agent SDK 세션(resume) |
| first_message_id | INTEGER NULL | 요약 범위 시작 |
| last_active_ts | INTEGER | |
| status | TEXT | `active` \| `idle` \| `closed` |
| created_ts | INTEGER | |

**messages** — 1단계 `events`의 일반화
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| conversation_id | INTEGER FK | |
| ts | INTEGER | |
| role | TEXT | `user` \| `assistant` \| `system` |
| user_id | TEXT NULL | 보낸 사람(비서/시스템은 NULL) |
| discord_message_id | TEXT NULL | 원본 메시지 |
| content | TEXT | |
| processed | INTEGER | 크래시 복구용(기본 1). user 메시지에만 의미 |

- `messages_fts` : FTS5(content), 1단계처럼 트리거로 동기화. 검색은 토큰별 이스케이프+접두(`"토큰"*`)로 한글 조사형·특수문자 안전(1단계 수정 반영).

### 4.2 기억 · 요약

**memories** — 유저별 큐레이션 장기 기억
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| user_id | TEXT | 누구의 기억(공용이면 소유자/시스템 표기) |
| scope | TEXT | `user`(개인) \| `shared`(공용 지식) |
| title | TEXT | 한 줄 제목(인덱스용) |
| content | TEXT | |
| source_conversation_id | INTEGER NULL | 어디서 알게 됐는지 |
| created_ts, updated_ts | INTEGER | |

**summaries** — 대화별 요약
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | INTEGER PK | |
| conversation_id | INTEGER FK | |
| from_message_id, to_message_id | INTEGER | 요약 범위 |
| content | TEXT | |
| created_ts | INTEGER | |

### 4.3 운영 (관찰가능성 · 한도 · 백업 · 능동성)

**logs** — 시스템 로그 + 에러(레벨로 구분)
`id, ts, level(debug|info|warn|error), source(core|discord|agent|scheduler|...), message, detail(TEXT JSON NULL)`

**actions** — AI 작업기록(도구 호출 단위, SDK 훅으로 자동 기록)
`id, ts, conversation_id NULL, user_id NULL, tool, input(TEXT JSON), result_summary NULL, status(ok|error|denied), duration_ms NULL`

**turns** — 한도의 원천(LLM 턴 1건 = 1행)
`id, ts, user_id NULL, conversation_id NULL, kind(message|summary|proactive)`

**backups** — 백업 이력
`id, ts, path, size_bytes, kind(scheduled|manual), status, note NULL`

**triggers** — 능동성 토대(설계만; 실행은 2E)
`id, kind(cron|watch|reminder), spec(TEXT), next_run_ts NULL, target_user_id NULL, target_conversation_id NULL, action(TEXT), status(active|paused|done), created_ts`

**settings / meta** — 앱 설정 key/value + `schema_version`(마이그레이션용)

## 5. 상호작용 모델 (디스코드)

### 5.1 트리거와 대화 매핑
- **DM**: 허용 사용자의 DM → 그 사용자의 `dm` 대화(없으면 생성).
- **서버 @멘션**: 허용 사용자가 채널에서 봇을 @멘션 → 그 메시지에 **스레드 생성** → `thread` 대화 생성 → 스레드에서 응답.
- **봇 스레드 내부**: 봇이 만든/참여한 스레드 안의 메시지는 **멘션 없이도** 그 대화로 계속 이어감.
- 채널 문맥 이해가 필요하면 최근 채널/스레드 메시지를 읽어 컨텍스트로만 사용(응답은 허용 사용자에게만).

### 5.2 메시지 처리 흐름
```
들어온 메시지 (user_id, discord_channel_id, content)
 1) 게이트: users.role ∈ {owner, allowed} 아니면 무시
     - 미등록 사용자는 무시. blocked도 무시.
     - 소유자의 "○○ 허용" 요청 → manage_access 도구로 role=allowed 등록
 2) 대화 확정: discord_channel_id 로 conversations 조회/생성
     (DM / @멘션→스레드생성 / 스레드내부)
 3) 한도: turns 기준 유저별 슬라이딩 윈도우 + 전역 상한 검사
     초과 시 안내(§8), 처리 중단
 4) 세션: conversation.session_id 있고 유휴 이내 → resume(새 메시지만)
     아니면 새 세션:
        [상대 기억(스코프) + 공용 기억] + [이 대화 최근 요약] + [이 대화 최근 메시지] + 새 메시지
 5) 비서 턴 실행: remember/recall 등 도구는 현재 상대(user_id)에 바인딩
 6) 저장: assistant 메시지 기록, turns 기록, conversation 갱신
 7) 전달: 스레드 답장 / DM (전송 직렬화·청크 분할은 1단계 방식 유지)

유휴 정리: 유휴된 대화마다 요약(summaries) 후 세션 종료. 대화별 직렬화.
```

세션이 대화별로 독립이라 여러 사람과 동시에 각자 문맥으로 대화 가능. **사람(user 기억)은 대화를 넘나들며 따라오고, 대화(스레드) 문맥은 그 스레드 안에** 유지된다.

## 6. 기억 · 프라이버시

- **컨텍스트 주입 규칙**: 상대 user_id=X와의 대화에서 새 세션 시작 시 주입되는 기억은 `scope='shared'` ∪ `(scope='user' AND user_id=X)`. **타인의 user 기억은 절대 주입하지 않는다.**
- **소유자 예외**: X가 owner면 recall 도구로 전원 기억 검색 허용(소유자 전체 열람).
- **다자 스레드**: 허용 사용자가 여럿 참여하는 스레드에서는 개인(`user`) 기억을 주입하지 않고 `shared`만 사용한다(한 참여자의 사생활이 다른 참여자에게 노출되는 것을 원천 차단). 개인 기억 주입은 DM·1:1 스레드(참여자=primary_user_id 1인)에서만. 그룹 대화의 화자별 개인 기억은 후속 과제.
- 대화 요약·최근 메시지는 **그 대화 것만** 주입(대화 격리).

## 7. 도구 계층 (권한별)

비서가 호출하는 인앱 도구. 각 호출은 `actions`에 로깅. 권한은 현재 상대의 role로 결정(권한 훅에서 강제).

**모든 허용 사용자**
- `remember(scope, title, content)` — **항상 현재 상대(user_id)** 앞으로 저장. 남 사칭 불가.
- `recall(query)` — 본인+공용 기억 검색. (소유자면 전원)
- `status()` / `my_usage()` — 본인의 남은 한도·최근 활동(DB 실측).

**소유자 전용**
- `db_query(sql)` — **읽기 전용 SELECT만**. INSERT/UPDATE/DELETE/DDL/PRAGMA(쓰기)·다중 스테이트먼트 거부. LIMIT·타임아웃 강제. 별도 read-only 연결 사용.
- `db_schema()` — 테이블·컬럼 구조 반환(비서의 자기 구조 인지).
- `manage_access(user_id, role)` — 허용/차단.
- `set_setting(key, value)` — 화이트리스트된 키만.
- `forget(id)` — 임의 기억 삭제.
- `create_trigger(...)` / `run_backup()` — 능동성·백업(각 단계에서 활성화).

### 7.1 능력 계층 — PC를 건드리는 도구는 소유자 전용 (핵심 안전 규칙)

비서는 **소유자의 PC에서 소유자 권한으로** 실행된다. 따라서 파일 쓰기·셸·코드작업·브라우저 자동화·컴퓨터 조작 등 **PC/데이터에 영향을 주는 모든 도구는 `role='owner'` 턴에서만** 활성화한다. 허용 손님(`allowed`) 턴에는 이 도구들을 **전부 제외**하고 `대화 + remember/recall(본인) + status/my_usage`만 남긴다. 즉 허용 손님은 아무리 지시해도 **소유자 PC를 건드릴 수 없다**.

- **집행 지점**: Agent SDK 호출의 `allowedTools`(및 권한 훅)를 **턴마다 발화자 role로 결정**한다. `owner` → 전체, `allowed` → 안전 부분집합, 그 외 → 애초에 무응답.
- **불변 규칙**: 이후 단계에서 파일/셸/브라우저/코드 도구가 추가돼도 이 규칙은 유지. **새 도구는 기본적으로 owner 전용에서 시작**하고, 손님에게 열려면 명시적·안전 검토를 거친다.
- `db_query`(전체 읽기)도 소유자 전용이라, 손님은 타인 기억/시스템 상태를 조회할 수 없다.

**설계 원칙**: 읽기는 자유(SELECT), 쓰기는 검증된 목적별 도구로만. `db_query`(전체 읽기)를 소유자 전용으로 둬 허용 손님이 타인 기억을 훔쳐보지 못하게 한다(프라이버시). raw 쓰기 SQL은 미제공하되, 향후 필요하면 "소유자 디스코드 승인" 게이트를 단 형태로만 추가.

## 8. 한도 (구독 보호)

- **원천은 `turns` 테이블.** 매 LLM 턴(대화·요약·능동)을 1행 기록.
- **유저별**: `MAX_TURNS_PER_HOUR_PER_USER` − COUNT(turns WHERE user_id=X AND ts>now−1h).
- **전역**: `MAX_TURNS_PER_HOUR_GLOBAL` − COUNT(turns WHERE ts>now−1h). 구독 총량 보호.
- 초과 시 `system_notice`로 남은 시간 안내. 재시작해도 정확(1단계의 메모리 방식 대체).
- 요약·능동 턴도 한도에 포함(1단계 리뷰 결함 반영).
- 비서는 `status()`로 실시간 남은 한도를 조회해 대화 중 안내 가능.

## 9. 관찰가능성

- **에러 수집**: 코어/디스코드/에이전트/스케줄러의 모든 오류를 `logs`에 `level='error'`(+스택 detail JSON). 콘솔·PM2 로그와 병행.
- **AI 작업기록**: Agent SDK 훅(PreToolUse/PostToolUse)으로 모든 도구 호출을 `actions`에 자동 기록 → "무슨 작업 했어?" 응답, 감사 추적.
- 비서는 `db_query`로 logs/actions를 조회해 자기 상태를 보고 가능(소유자).

## 10. 백업

- SQLite 온라인 백업 API(better-sqlite3 `.backup()`)로 `data/store/backups/agent-<ts>.db` 주기 생성(WAL 안전).
- 최근 N개 보존(오래된 것 정리). 매 건 `backups`에 기록.
- 수동 `run_backup()`(소유자) 및 주기 스케줄(2D). 단일 파일이라 파일 복사만으로 충분(1단계 설계 계승).

## 11. 능동성 토대 (2E, 설계만)

- `triggers`에 예약(cron)·감지(watch)·리마인더 정의. 스케줄러가 `next_run_ts` 도달 시 이벤트 발행 → 코어가 "능동 턴" 실행 → 대상 대화/DM로 선제 연락, `turns.kind='proactive'`로 한도 집계.
- 3단계 감지기 목록(파일 변화·사이트·시스템 상태 등)은 2E 계획 시 사용자와 확정.

## 12. 안전장치

- **응답 게이트**: owner/allowed만. 미등록·blocked 무시.
- **손님 능력 제한(핵심)**: 허용 손님은 대화·본인기억만. **파일·셸·코드·PC조작·브라우저·`db_query` 등 PC/데이터 영향 도구는 소유자 전용.** 턴별 role 기반 `allowedTools`로 집행 → 타인이 소유자 PC를 조작 불가(§7.1).
- **프라이버시**: 도구 계층에서 강제(remember는 상대에 바인딩, recall/ db_query 스코프·소유자 제한).
- **쓰기 최소화**: LLM에 임의 파괴적 SQL 미노출. 목적별 도구만, 각 호출 로깅.
- **인젝션 방어**: 관찰된 콘텐츠(타 사용자 메시지 등)는 데이터로만 취급. 도구 실행은 현재 상대 권한으로만.
- **구독/비용 보호**: 유저별+전역 한도, 능동 턴 포함. 개인용 구독 취지 준수(불특정 다수 서비스 아님).
- 되돌리기 어려운 작업(삭제·외부전송 등, 이후 단계 도구)은 소유자 승인 게이트.

## 13. 마이그레이션 (1단계 → 이 스키마)

`meta.schema_version` 확인 후 순차 적용. 기존 데이터 보존:
1. 소유자를 `users(role='owner')`로 등록(.env의 ID).
2. 기존 owner DM용 `conversations` 1건 생성(kind='dm', primary_user_id=owner). `settings.session.*` → 이 대화의 session_id/last_active/first_message.
3. `events` → `messages`(conversation=owner dm, role=type 매핑, user_id: user_message는 owner·나머지 NULL, processed 보존). `messages_fts` 재구축.
4. `summaries` → 새 `summaries`(conversation=owner dm).
5. **마크다운 기억**(`data/memory/MEMORY.md`+파일) → `memories`(user_id=owner, scope 판단)로 best-effort 임포트. 원본 마크다운은 백업으로 보존.
6. 앱 설정용 `settings`는 유지, session.* 키는 제거.

데이터가 적어 위험은 낮음. 마이그레이션은 idempotent하게 작성하고, 실패 시 원본 DB를 건드리지 않도록 백업 후 진행.

## 14. 구현 단계

| 단계 | 내용 | DoD |
|---|---|---|
| **2A** 데이터 기반 | 스키마 + 마이그레이션 + store/repo 리팩터(관심사별 리포). 동작 변화 없음 | 새 스키마로 기존 기능 그대로 통과 |
| **2B** 멀티유저·멀티채널 | discord 어댑터(서버·@멘션·스레드), 대화별 세션, 역할 게이트, 유저별/전역 한도(turns) | 허용 사용자 다수가 각자 문맥으로 대화, 스레드 동작 |
| **2C** 기억·자기인지 도구 | remember/recall/forget, status/my_usage, db_query/db_schema, manage_access, set_setting + SDK 훅으로 actions/turns 로깅, 에러 logs | "내 한도?"·"무슨 작업?"에 DB 실측 응답, 유저별 기억 |
| **2D** 백업·관찰 마무리 | 온라인 백업 스케줄+보존+backups, 전역 에러 로깅 정비 | 자동 백업, 오류 수집 |
| **2E** 능동성(뒤 단계) | triggers 실행(스케줄러/감지), 능동 턴 | 먼저 말 거는 비서 |

각 단계는 독립 구현 계획(plan) → 구현 → 검증 사이클. 2A부터 시작.

## 15. 테스트 전략

- **단위(vitest)**: 스키마/리포 쿼리(대화·메시지·기억·한도 계산), 게이트·프라이버시 스코프(주입 규칙), 마이그레이션(1단계 DB→새 스키마), db_query 가드(쓰기 거부), 한도 계산(turns 기반). LLM·디스코드는 모킹.
- **통합 스모크**: 각 단계 완료 시 실제 플로우 수동 검증(예: 2B — 두 계정으로 스레드 대화, 프라이버시 미유출 확인).
- 도구 권한(owner vs allowed)은 단위 테스트로 경계 고정.

## 16. 미해결 / 후속

- raw 쓰기 SQL: 필요 시 소유자 디스코드 승인 게이트로만 추가(현재는 목적별 도구로 충분).
- 한국어 형태소 검색: 접두 매칭으로 대부분 해결, 정밀 형태소 분석은 후속.
- 도구 제공 방식(Agent SDK 커스텀 도구 vs 인프로세스 MCP)은 2C 계획 시 SDK API 확인 후 확정.
- 채널 전체 메시지 저장 범위: 기본은 **봇이 참여한 대화만** 저장(불특정 다수 로깅 회피). 필요 시 옵션화.
