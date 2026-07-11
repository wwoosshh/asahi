# 멀티유저 · 자기인지 데이터 기반 설계 (2단계 재정의) — v2 (리뷰 반영)

- **작성일**: 2026-07-11 (v2: 적대적 설계 리뷰 26건 반영)
- **상태**: 설계 확정(사용자 승인) — 구현 대기
- **선행**: 1단계 완료([설계](./2026-07-11-pc-ai-assistant-design.md), [1단계 계획](../plans/2026-07-11-phase1-core-discord.md))
- **비고**: 원래 로드맵의 2단계(파일/셸·브라우저 MCP)보다 이 작업을 앞으로 당김.

## 1. 개요와 목표

여러 사용자를 개별로 기억하고, 서버에서 사람처럼 활동하며, 자신의 상태·구조를 DB로 정확히 인지하는 비서로 확장한다.

- 소유자 + 허용 목록 사용자와 대화(DM + 서버 @멘션 → 스레드).
- 사용자를 **개별로** 기억하되 **프라이버시 경계를 구조적으로 강제**한다(§6).
- 대화·기억·로그·에러·AI작업·백업·트리거를 정규화된 SQLite 스키마로 관리.
- 비서가 자기 DB를 읽고(SELECT) 구조를 조회해 상태(예: 실시간 남은 한도)를 실측으로 안내.

## 2. 확정된 결정 사항

| 항목 | 결정 |
|---|---|
| 진행 방식 | 전체 스키마 지금 설계, 구현은 단계적(2A~2E) |
| 응답 대상 | **소유자 + 허용 목록**만. 그 외 무응답. (+ 유저별·전역 한도) |
| 기억 경계 | 소유자 전체 열람, 손님끼리 개별. 타인 사생활 미노출은 공통 전제 |
| **개인기억·특권도구 위치** | **개인(user) 기억·recall(전원)·db_query·db_schema 등 특권 도구는 소유자 DM에서만, 출력도 소유자 DM으로만.** 서버(스레드 포함)는 **공용 기억 + 그 대화 문맥만** |
| 서버 행동 | @멘션 → 스레드 생성(멱등·폴백) → 스레드에서 계속 대화 |
| 사람다움 | 반응형 + 능동형(먼저 말 걸기). 데이터모델은 지금 설계, 능동 실행은 2E |
| 손님 능력 | 대화 + 본인 DM에서의 본인 기억(remember/recall 본인·scope=user)만. **파일·셸·코드·브라우저·PC조작·db_query·shared 쓰기는 소유자 전용** |
| 스키마 접근 | 읽기(SELECT)는 소유자 DM, 쓰기는 검증된 목적별 도구로만. raw 쓰기 SQL 미제공 |
| 동시성 | **대화별 직렬 큐(대화 간 병렬, 대화 내 직렬)**. 세션 읽기→턴→쓰기 원자적. 한도는 트랜잭션 예약 |
| 참여자 | `conversation_participants`로 추적. (서버는 애초 shared-only라 개인기억 없음) |
| 소유자 예산 | 전역 한도에서 소유자 예약분 확보(손님이 소유자 몫 잠식 불가) |

## 3. 아키텍처 개요

1단계의 3층(어댑터·코어·저장소)과 이벤트 버스 유지. 확장:

- **어댑터(discord)**: DM + 서버 @멘션 감지 + 스레드 생성/추적. 트리거 메시지 외 채널 맥락이 필요하면 **허용 사용자 메시지만** 온디맨드로 fetch(§7 `read_channel_context`).
- **코어**: 전역 세션 1개 → **대화별 세션**. **대화 키(conversation_id)별 직렬 큐/락** — 같은 대화는 직렬(재진입 금지), 다른 대화는 병렬. `세션 읽기 → 턴 실행 → session_id 쓰기` 전체를 한 대화락 안에서 원자적으로 수행. 역할 게이트, 프라이버시 스코프 주입, 유저별+전역 한도(트랜잭션 예약).
- **저장소**: 정규화 스키마(§4). 관심사별 리포로 분리.
- **도구 계층(신규)**: 비서가 호출하는 인앱 도구(§7). Agent SDK 커스텀 도구(또는 인프로세스 MCP), 권한 훅으로 role·DM여부·직접발화 여부를 강제.

## 4. 데이터 모델 (SQLite, WAL + FTS5)

시각은 epoch ms(INTEGER). 디스코드 ID는 TEXT. `meta.schema_version`로 버전 마이그레이션.

### 4.1 정체성 · 대화 · 참여자 · 메시지

**users**: `id TEXT PK, role(owner|allowed|blocked), display_name, created_ts, updated_ts`

**conversations**
| 컬럼 | 설명 |
|---|---|
| id INTEGER PK | |
| kind | `dm` \| `thread` |
| discord_channel_id TEXT UNIQUE | 메시지 매핑 열쇠 |
| origin_message_id TEXT UNIQUE NULL | **스레드 생성 멱등키**(트리거 메시지) |
| guild_id, parent_channel_id | 서버·부모채널(DM은 NULL) |
| primary_user_id | 대화 개시자 |
| is_private | **1이면 개인기억 사용 가능(=소유자 DM만)**, 서버는 항상 0 |
| session_id, first_message_id | resume·요약 범위 |
| private_memory_loaded | 이 세션에 개인기억이 적재됐는지(안전 무효화용) |
| last_active_ts, status(active/idle/closed), created_ts | |

**conversation_participants** (신규)
`conversation_id, user_id, joined_ts` — 매 인입 메시지에서 upsert. 1:1/그룹 판정은 이 테이블 COUNT로. (참여자≥2면 개인기억 세션 강제 종료·재구성 — 단, 서버는 애초 shared-only라 구조적으로 개인기억이 없음)

**messages**: `id PK, conversation_id FK, ts, role(user|assistant|system), user_id NULL, discord_message_id NULL, content, processed(기본1)` + `messages_fts`(토큰별 이스케이프+접두 검색, 1단계 방식).

### 4.2 기억 · 요약

**memories**: `id PK, user_id, scope(user|shared), title, content, source_conversation_id NULL, created_ts, updated_ts`

**summaries**: `id PK, conversation_id FK, from_message_id, to_message_id, content, created_ts`

### 4.3 운영

- **logs**: `id, ts, level(debug|info|warn|error), source, message, detail(JSON)`
- **actions**: `id, ts, conversation_id, user_id, tool, input(JSON), result_summary, status(ok|error|denied), duration_ms`
- **turns**: `id, ts, user_id, conversation_id, kind(message|summary|proactive)` — 한도의 원천. **코어가 2B에서 매 runTurn 직전 트랜잭션으로 예약 삽입**(§8).
- **backups**: `id, ts, path, size_bytes, kind(scheduled|manual), status, note`
- **triggers**: `id, kind(cron|watch|reminder), spec, next_run_ts, target_user_id, target_conversation_id, action, status, created_ts`
- **settings / meta**: 앱 설정 + `schema_version`

### 4.4 인덱스 (성능·한도 COUNT)
`turns(ts)`, `turns(user_id, ts)`, `messages(conversation_id, id)`, `messages(processed)`(부분, processed=0), `memories(user_id, scope)`, `summaries(conversation_id)`, `triggers(next_run_ts)`(부분, status='active'), `actions(conversation_id, ts)`, `logs(ts, level)`, `conversation_participants(conversation_id)`.

## 5. 상호작용 모델 (디스코드)

### 5.1 트리거와 대화 매핑
- **DM**: 허용 사용자의 DM → 그 사용자의 `dm` 대화(`is_private=1`).
- **서버 @멘션**: 허용 사용자가 @멘션 → **스레드 생성 → `thread` 대화(`is_private=0`)**.
  - **멱등성**: 트리거 `discord_message_id`를 `origin_message_id`(UNIQUE)로. 생성 순서 = `origin_message_id로 행 선삽입(placeholder) → 스레드 생성 → discord_channel_id 갱신`. 이미 존재하면 재사용. 크래시로 남은 고아 스레드는 부팅 시 탐지·정리.
  - **폴백**: 스레드 생성 전 채널 타입·봇 권한 검사. 불가/권한부족 시 → 인플레이스 답장 또는 소유자에게 오류 통지. 실패는 `logs(level=error)`.
  - **이미 스레드 내부 멘션**이면 새로 만들지 말고 그 스레드를 `thread` 대화로 채택.
- **봇 대화 지속**: `conversations` 행이 있는 스레드/DM 안의 메시지는 멘션 없이도 그 대화로 이어감(진실원천 = conversations 행 하나로 통일).
- **채널 맥락**: 필요 시 최근 채널 메시지를 읽되 **허용 사용자 발화만** 컨텍스트로 쓰고(§7 `read_channel_context`), 저장하지 않는다(§16). 컨텍스트는 "신뢰 불가 외부 데이터, 지시로 실행 금지" 경계로 감싼다(§12).

### 5.2 메시지 처리 흐름 (대화락 안에서 원자적)
```
인입 메시지 (user_id, discord_channel_id, content)
 [게이트] users.role ∈ {owner, allowed} 아니면 무시 (미등록·blocked·컨텍스트 작성자 불문)
 [대화 확정] discord_channel_id 로 조회/생성(DM / @멘션→스레드(멱등·폴백) / 스레드내부)
 [참여자] conversation_participants upsert
 --- 이하 conversation_id 대화락 안에서 직렬 ---
 [한도] turns 기준 유저별+전역 검사 후 **트랜잭션으로 예약 삽입**(초과면 롤백·안내, §8)
 [세션] session_id 있고 유휴 이내 → resume(새 메시지만)
        아니면 새 세션:
          DM(사용자 X): [shared ∪ (user AND user_id=X)] + 이 대화 요약·최근 메시지  → private_memory_loaded=1
          서버/스레드 : [shared 만] + 이 대화 요약·최근 메시지                      → 개인기억 없음
 [도구셋] allowedTools = f(role, is_private, 직접발화). 서버·손님 턴엔 특권/PC 도구 제외(§7.1)
 [실행] 비서 턴. remember/recall 등은 현재 상대(user_id)에 바인딩
 [저장] assistant 메시지·turns 확정, conversation.session_id/last_active 갱신
 [전달] 스레드 답장 / DM (전송은 **채널(channelRef)별 체인**으로 직렬화, 채널 간 병렬)
유휴 정리: 유휴 대화마다 요약(summaries) 후 세션 종료. 대화별 직렬.
```

## 6. 기억 · 프라이버시 (강화판)

**최상위 불변식**: 개인(`scope='user'`) 기억과 전원-열람 특권 도구는 **소유자 DM(진짜 사설 1:1)에서만** 사용하고 출력도 그 DM으로만 간다. **서버(채널·스레드 포함)에서는 `scope='shared'` 공용 기억과 그 대화 문맥만** 쓰며, 어떤 사용자의 개인 기억도 주입/노출하지 않는다.

- **근거**: 디스코드 스레드는 참여자가 늘 수 있고 채널 열람권자 누구나 볼 수 있어 런타임에 '1:1 사설'을 보장 못 한다. DM만이 사설이다.
- **손님도 동일**: 손님 개인 기억은 그 손님의 DM에서만 사용.
- **컨텍스트 주입**(§5.2): DM은 상대의 개인+공용, 서버는 공용만. 타인의 `user` 기억은 어떤 경우에도 미주입.
- **resume 안전**: 서버 대화는 개인기억이 애초에 없으므로(불변식), resume에도 개인기억 유출이 없다. DM은 1:1이라 참여자 증가 자체가 불가.
- **소유자 전원-열람**: `recall(전원)`·`db_query`는 `conversations.is_private=1 AND primary_user_id=owner`(=소유자 DM)에서만 활성화하고 출력도 그 DM으로만. 서버에서는 소유자가 발화해도 비활성.

## 7. 도구 계층 (권한별)

각 호출은 `actions`에 로깅. 권한은 현재 상대 role + `is_private`(DM여부) + 직접발화 여부로 결정(권한 훅 강제).

**모든 허용 사용자 (본인 DM 기준)**
- `remember(title, content)` — **항상 현재 상대(user_id)·scope='user'**로만 저장. 손님은 shared 쓰기 불가.
- `recall(query)` — 본인+공용 기억(본인 DM). 
- `status()` / `my_usage()` — 본인의 남은 한도·최근 활동(DB 실측). status는 "구독 실제 한도가 아닌 **자체 보호 한도**"임을 정직히 표기(§8).

**소유자 전용 (소유자 DM에서만)**
- `db_query(sql)` — 읽기 전용 SELECT만(쓰기/DDL/PRAGMA쓰기/다중문 거부, LIMIT·타임아웃, read-only 연결). 출력은 소유자 DM으로만.
- `db_schema()` — 구조 반환.
- `recall(전원)` — 전 사용자 기억(소유자 DM에서만).
- `manage_access(user_id, role)` — **명시적 user_id(멘션 스노플레이크)로만**. 표시명 금지, 동명 다수면 실패·재확인. 소유자의 **직접 발화**로만 실행(컨텍스트 유래 호출 금지).
- `remember_shared(title, content)` / `set_setting` / `forget(any)` / `create_trigger` / `run_backup` — shared 쓰기·설정·삭제·능동·백업.

**모든 특권/파괴적 도구 공통**: 컨텍스트(관찰된 메시지)가 아니라 **현재 발화자의 직접 지시**로만 유발. 컨텍스트에서 유도된 특권 도구 호출은 권한 훅에서 차단.

### 7.1 능력 계층 — PC를 건드리는 도구는 소유자 전용 (핵심 안전 규칙)

비서는 소유자 PC에서 소유자 권한으로 실행된다. 파일 쓰기·셸·코드작업·브라우저·컴퓨터 조작 등 **PC/데이터 영향 도구는 `role='owner'` 턴에서만**, 그리고 **소유자 DM(is_private=1)에서만** 활성화. 손님·서버 턴엔 전부 제외하고 `대화 + remember/recall(본인 DM) + status`만 남긴다.

- **집행**: Agent SDK `allowedTools`(+권한 훅)를 턴마다 `role·is_private·직접발화`로 결정. owner-DM → 전체, allowed(본인 DM) → 안전 부분집합, 서버 → 공용대화 도구만, 그 외 → 무응답.
- **불변 규칙**: 이후 파일/셸/브라우저 도구가 추가돼도 유지. 새 도구는 기본 owner-DM 전용에서 시작.

## 8. 한도 (구독 보호)

- **원천 `turns`.** 매 LLM 턴(대화·요약·능동)을 기록. **코어가 2B에서 명시적으로 예약 삽입**(2C 훅은 `actions`만).
- **원자적 예약(TOCTOU 방지)**: `카운트 확인 + turns 예약 삽입`을 단일 트랜잭션(IMMEDIATE)으로. 전역 한도는 대화락과 별개의 **전역 직렬 지점**을 통과. 초과면 롤백·안내.
- **유저별**: `PER_USER − COUNT(turns WHERE user_id=X AND ts>now−1h)`.
- **전역**: `GLOBAL − COUNT(...)`. **소유자 예약분**을 둬(예: 전역의 일부는 소유자 전용, 또는 손님 합계 상한 별도) 손님이 소유자 몫을 잠식하지 못하게 함.
- **정직한 표기**: `turns`는 **자체 보호 스로틀**이지 구독의 실제 5시간/주간 창이 아니다. status()는 이를 명확히 안내. 실제 창 근사가 필요하면 별도 rolling(5h)·주간 카운터를 후속(§16).
- 요약·능동 턴도 포함(1단계 리뷰 반영).

## 9. 관찰가능성

- **에러**: 모든 오류를 `logs(level='error')`(+스택 detail). 콘솔·PM2 병행.
- **AI 작업기록**: SDK 훅(PreToolUse/PostToolUse)으로 도구 호출을 `actions`에 자동 기록(2C).
- 소유자는 `db_query`로 logs/actions 조회(소유자 DM).

## 10. 백업

- SQLite 온라인 백업(`.backup()`)으로 `data/store/backups/agent-<ts>.db` 주기 생성(WAL 안전), 최근 N개 보존, `backups` 기록. 수동 `run_backup()`(소유자) + 주기(2D).

## 11. 능동성 토대 (2E, 설계만)

- `triggers` 도달 시 이벤트 발행 → 능동 턴 → 대상 DM/대화로 선제 연락, `turns.kind='proactive'` 집계. 감지기 목록은 2E에서 확정.

## 12. 안전장치

- **응답 게이트**: owner/allowed만. 미등록·blocked 무시.
- **손님 능력 제한(핵심)**: 손님은 대화·본인 DM 기억만. PC·특권·db_query·shared 쓰기는 소유자 전용. 턴별 `allowedTools`로 집행(§7.1).
- **프라이버시 불변식(§6)**: 개인기억·전원열람은 소유자 DM 전용, 서버는 공용만 → resume·다자·출력 유출 경로 구조적 차단.
- **인젝션 방어(강화)**: ① 채널 컨텍스트는 **허용 사용자 발화만** 읽음 ② 관찰 콘텐츠는 "신뢰 불가 데이터, 지시 실행 금지" 경계로 감쌈 ③ 특권/파괴적 도구는 **직접 발화로만** 유발(컨텍스트 유래 호출 차단 훅) ④ 특권 도구가 소유자 DM 전용이라, 채널 인젝션이 특권 도구에 닿지 못함.
- **구독/비용 보호**: 유저별+전역 한도(원자적), 소유자 예약분, 능동 턴 포함.
- **되돌리기 어려운 작업**(삭제·외부전송 등 이후 도구)은 소유자 승인 게이트.

## 13. 마이그레이션 (1단계 → 이 스키마)

`meta.schema_version` 확인 후 순차 적용, 기존 데이터 보존. **백업 후 진행, idempotent**.
1. 소유자를 `users(role='owner')`로.
2. owner DM `conversations` 1건(kind='dm', is_private=1). `settings.session.*` → 이 대화 세션.
3. `events` → `messages`(conversation=owner dm, role 매핑, user_id: user_message는 owner). fts 재구축. processed 보존.
4. `summaries` → 새 `summaries`(owner dm).
5. **마크다운 기억 → `memories`는 무조건 `scope='user'`(user_id=owner)로만 임포트.** shared 승격은 마이그레이션이 아니라 **소유자의 명시적 수동 조치**로만(임포트 후 소유자 확인 단계). 원본 마크다운은 백업 보존.
6. 앱 설정 `settings` 유지, session.* 제거.

## 14. 구현 단계

| 단계 | 내용 | DoD |
|---|---|---|
| **2A** 데이터 기반 | 스키마(참여자·인덱스 포함) + 마이그레이션 + store 리팩터 | 새 스키마로 기존 기능 통과 |
| **2B** 멀티유저·멀티채널 | discord(서버·@멘션·스레드 멱등/폴백), 대화별 세션·**대화락**, 역할 게이트, **turns 예약(원자적) 한도** | 다수가 각자 문맥으로 대화, 프라이버시 불변식 성립 |
| **2C** 기억·자기인지 도구 | remember/recall/forget, status/my_usage, db_query/db_schema(소유자 DM), manage_access, read_channel_context + SDK 훅으로 **actions** 로깅, 에러 logs | "내 한도?"·"무슨 작업?"에 실측 응답 |
| **2D** 백업·관찰 마무리 | 온라인 백업 스케줄·보존, 전역 에러 로깅 | 자동 백업·오류 수집 |
| **2E** 능동성(뒤) | triggers 실행(스케줄러/감지) | 먼저 말 거는 비서 |

각 단계 독립 계획→구현→검증. 2A부터.

## 15. 테스트 전략

- **단위**: 스키마/리포 쿼리, **프라이버시 불변식**(서버=shared-only, 개인기억·db_query는 DM만, 타인기억 미주입), 게이트(role·is_private·직접발화), **한도 원자성**(동시 예약 경합에서 상한 준수), 마이그레이션(1단계→새, 마크다운=user scope), 스레드 멱등성, db_query 쓰기 거부. LLM·디스코드 모킹.
- **동시성**: 같은 대화 직렬·다른 대화 병렬, 세션 원자성.
- **통합 스모크**: 두 계정으로 스레드 대화 시 개인기억 미유출, 채널 인젝션이 특권 도구에 무력함 확인.

## 16. 미해결 / 후속

- 실제 구독 5시간/주간 창은 로컬에서 실측 불가 — `turns`는 자체 스로틀, status는 정직 안내. 근사 rolling 윈도우는 후속.
- 그룹(다자) 대화의 화자별 개인 기억은 미지원(서버=shared-only). 필요 시 후속.
- 채널 전체 메시지 저장은 기본 미보관(봇 참여 대화만). `read_channel_context`는 온디맨드 읽기만.
- raw 쓰기 SQL은 필요 시 소유자 DM 승인 게이트로만 추가.
- 도구 제공 방식(SDK 커스텀 vs 인프로세스 MCP)은 2C 계획 시 SDK API 확인 후 확정.

## 17. 설계 리뷰 반영 대장 (v1 → v2, 26건)

**프라이버시·인젝션(high)**
1. resume 참여자 미재검증 유출 → **§6 불변식(서버=shared-only, 개인기억 DM 전용)**으로 구조 차단 + `conversation_participants`.
2. 전원열람 출력이 채널로 → **§6/§7 recall전원·db_query는 소유자 DM 전용·출력도 DM**.
3. 프롬프트 인젝션(혼동된 대리인) → **§12 인젝션 방어 ①②③④**(컨텍스트=허용발화만, 신뢰경계, 직접발화만, 특권=DM전용).
4. 손님 shared 오염 → **§7 shared 쓰기 소유자 전용, 손님 remember=scope='user'만**.
5. 마이그레이션 shared 유입 → **§13-5 무조건 scope='user', shared 수동 승격**.

**스키마·동시성(high/med)**
6·7. 참여자 추적 부재 → **§4.1 conversation_participants** + upsert.
8. turns 기록 위치 모순 → **§8/§14 코어가 2B에서 예약, 2C 훅=actions만**.
9. 인덱스 미정의 → **§4.4 인덱스 목록**.
10·11. 한도 TOCTOU·대화락 부재 → **§3/§5.2/§8 대화별 직렬 큐 + 트랜잭션 예약(전역 직렬 지점)**.

**상호작용(med)**
12. manage_access 표시명 모호 → **§7 명시적 user_id·직접발화**.
13. 스레드 생성 멱등성 → **§5.1 origin_message_id UNIQUE·placeholder→생성→갱신·고아정리**.
14. 스레드 생성 실패 폴백 → **§5.1 권한검사·인플레이스/통지·logs**.
15. "봇 스레드" 모호 → **§5.1 conversations 행으로 진실원천 통일**.
16. 실행모델 모호 → **§3 대화별 독립 직렬 큐 명시**.

**한도·기타(med/low)**
17·18. 손님이 소유자 예산 잠식 → **§8 소유자 예약분**.
19. 그룹서 개인기억 쓰기 → **§6/§7 서버=shared-only, 손님=user만(본인 DM)**.
20. turns≠실제 구독한도 → **§8 정직 표기·후속 근사**.
21. read_channel_context 미정의 → **§7 도구 추가(허용발화·미보관)**.
22. 전송 head-of-line → **§5.2 채널별 전송 체인**.
23. 허용등록 UX → **§7 user_id 추출·§5.2 직접발화**.
(schema-data verify 일부는 구독 한도로 미검증 — 인덱스·마이그레이션 등 보수적으로 반영.)
