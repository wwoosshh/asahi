# 자기인지 — 자기 구조·데이터 조회(DB introspection) 설계

- 날짜: 2026-07-12
- 상태: 설계 승인 대기 (브레인스토밍 산출물)
- 관련: `agent/src/core/tools.ts`, `agent/src/core/agent.ts`, `agent/src/store/db.ts`, `agent/src/core/persona.ts`, `agent/src/index.ts`, `agent/src/worker/jobRunner.ts`
- 선행: 인격체화 테마(캐릭터 완료). 자기인지 축의 **1순위 = 자기 구조·능력 인지**(사용자 강조: "자기가 어떻게 만들어졌는지 알아야 뭘 할 수 있는지 알고 안내한다"). 뒤이어 B(작업 관찰)·A(사용량)·미래 소스(로그·GitHub).

## 1. 개요·목표

Asahi가 자기 자신의 데이터 구조와 실제 내용을 **직접 읽어** 사실 기반으로 답하게 한다. "너 나에 대해 뭘 알아?", "대화 몇 번 했지?", "내 기억에 뭐가 있어?" 같은 질문에 추측이 아니라 실측으로 답하고, 자기가 무엇을 할 수 있고 없는지 정직히 안내한다. DB 읽기를 앵커로 삼되, 나중에 서버 로그·GitHub 등 다른 읽기 소스가 같은 패턴으로 붙을 수 있게 깔끔히 분리한다.

성공 기준:
- 소유자 DM에서 "내 기억 목록 보여줘"·"대화 통계"·"이 테이블 구조" 등에 db_schema/db_query로 실측 응답.
- 읽기 전용이 다층으로 보장되어 어떤 경우에도 쓰기가 일어나지 않는다.
- 소유자 신원 전용 — 손님·서버·(워커의 손님 turn)에는 절대 노출되지 않는다.
- **자기 런타임 사양을 안다**: "너 어떤 모델로 돌아가?"에 실측/설정값으로 답한다(모델·SDK 버전·배포 대상·한도).
- **실행 모델을 Opus 4.8로 고정**(env `ANTHROPIC_MODEL`로 재정의 가능).

## 2. 배경·현재 상태

- 인프로세스 MCP 도구는 `tools.ts`의 `buildTools(ctx)`가 만들고, 턴별 노출은 `allowedToolsFor(role, isPrivate, isOwner, deployTarget, ownWorkstation)`가 정한다. 특권 도구(recall-all·manage_access)는 **역할이 아니라 소유자 신원**(`ctx.isOwner`, `userId===ownerId`)으로 핸들러에서 재확인한다(프라이버시 불변식 §6).
- 소유자 DM turn 은 워커가 온라인이면 **워커**가, 아니면 **클라우드 봇**이 처리한다(core.ts 위임 게이트). 따라서 소유자 DM 도구는 **봇·워커 양쪽**에서 동작해야 한다.
- 저장계층은 `pg`(Supabase Postgres). `db.ts`에 `Pool`, `withTx`가 있다. 비밀값(토큰)은 DB가 아니라 env 에 있으므로, DB 자체엔 소유자가 못 볼 비밀은 없다(소유자는 시스템 운영자).

## 3. 도구 정의 (인프로세스 MCP · 소유자 신원 전용)

### 3.1 `db_schema()`
- 인자 없음. `information_schema.columns`(public 스키마)를 조회해 **테이블별 컬럼·타입** 목록을 텍스트로 반환.
- 용도: "나는 이런 데이터(테이블/컬럼)로 이루어져 있다"를 AI가 정확히 앎.

### 3.2 `db_query(sql: string)`
- 인자: 읽기 전용 SELECT 한 문장.
- 실행 후 결과 행을 표 형태 텍스트로 반환(행수·셀 길이 제한, 초과 시 "…외 N행" 안내).
- 용도: 실제 데이터 조회("내 기억 목록", "최근 대화 수", 임의 통계).

### 3.3 `runtime_info()`
- 인자 없음. 자기 런타임 사양을 텍스트로 반환: **모델**(설정값 `config.model`, 그리고 가능하면 SDK init 메시지에서 캡처한 실제 모델), **SDK 버전**, **배포 대상**(local/cloud), **maxTurns(30)**, **한도**(손님 유저별/전역, 소유자 무제한).
- 용도: "너 어떤 모델·설정으로 돌아가?"에 정직히 응답. 자기 능력의 한 축(어떤 엔진·제약으로 동작하는지).

## 3.5 모델 구성 (Opus 4.8 고정)
- `config.model`: env `ANTHROPIC_MODEL`, **기본 `claude-opus-4-8`**. `query()` 옵션의 `model`로 전달(현재는 미지정이라 구독 기본값으로 돎).
- 봇(index.ts)·워커(jobRunner) 공용 러너(`makeRunAgentTurn`)에 모델을 전달해 **양쪽 동일**하게 적용.
- 주의: 구독(OAuth 토큰) 플랜이 Opus 접근을 허용해야 실제로 Opus 4.8로 돈다. 미허용/미인식 시 SDK 동작은 실 배포 스모크로 확인(필요 시 env로 alias `opus` 또는 다른 모델로 조정). Opus 는 응답이 느리고 구독 사용량 소모가 큼(운영상 감안).

## 4. 안전 모델 (다층 방어 — 하나만 뚫려도 다음이 막음)

1. **순수 사전검사** `assertReadOnlySql(sql)`:
   - 주석·공백 정리 후 **단일 문장**만 허용(세미콜론으로 구분된 다중문 거부, 문자열 리터럴 밖의 `;` 금지).
   - 첫 키워드가 `SELECT` 또는 `WITH`(그리고 그 CTE가 최종적으로 SELECT)만 허용.
   - `INSERT/UPDATE/DELETE/MERGE/CREATE/ALTER/DROP/TRUNCATE/GRANT/REVOKE/COPY/CALL/DO/SET` 등 쓰기·부작용 키워드가 문장 최상위에 있으면 거부.
   - 통과/거부를 명확한 메시지로. (완벽한 SQL 파서는 아니며, 진짜 방어선은 2번이다.)
2. **Postgres READ ONLY 트랜잭션**(핵심 방어): 전용 클라이언트에서 `BEGIN; SET TRANSACTION READ ONLY;` 후 실행 → 사전검사를 우회한 어떤 쓰기도 DB가 거부한다. 끝나면 `ROLLBACK`.
3. **statement_timeout**: `SET LOCAL statement_timeout = '5000ms'`로 폭주 쿼리 차단.
4. **결과 상한**: 앱에서 반환 행을 최대 N행(예: 100)으로 절단, 긴 셀 값도 절단(예: 500자). "…외 M행 더 있음" 표기.
5. **소유자 신원 전용**: `allowedToolsFor`가 소유자 DM 브랜치에만 노출 + 핸들러가 `ctx.isOwner` 재확인(recall-all·manage_access와 동일 특권 티어). 손님·서버·(워커의 손님 turn)에는 목록에도, 실행에도 없음.

## 5. 스코프·프라이버시

- **소유자 신원 전용**(`userId===ownerId`)·**비공개(DM)**에서만. 소유자는 시스템 운영자이므로 모든 테이블(다른 사용자 기억·메시지 포함)을 조회할 수 있다 — 이는 의도된 운영 특권이며, 애초에 손님에겐 이 도구가 없어 크로스유저 유출 경로가 아니다.
- 소유자 DM turn 은 봇/워커 어디서 처리되든 동일하게 이 도구를 갖는다(§2). 따라서 `allowedToolsFor`의 **소유자 DM cloud·local 두 브랜치 모두**에 추가하고, 봇(index.ts)·워커(jobRunner) 양쪽에 조회 리포를 배선한다.

## 6. 능력 안내 (persona)

- 소유자 DM 능력 블록에 한 줄 추가(요지): "db_schema/db_query 로 네 구조와 데이터를 직접 조회해 **추측 대신 실측으로** 답하고, 네가 할 수 있는 것/아직 못 하는 것을 정직히 안내하라. 대량·모호한 요청은 먼저 db_schema 로 구조를 확인하라." 캐릭터 톤 유지, 이모지 금지 유지.

## 7. 아키텍처

### 7.1 새/수정 요소
- **`agent/src/core/sqlGuard.ts`(신규)**: `assertReadOnlySql(sql: string): void`(위반 시 `throw new Error(메시지)`) — 순수, 유닛 테스트 대상.
- **`agent/src/store/introspectRepo.ts`(신규)**: `IntrospectRepo(db)`:
  - `schema(): Promise<string>` — information_schema 조회 → 텍스트.
  - `readOnlyQuery(sql: string, opts?): Promise<{ rows: Record<string, unknown>[]; truncatedRows: number }>` — READ ONLY 트랜잭션 + timeout + 행 상한.
- **`agent/src/config.ts`**: `model: string` 필드 추가(env `ANTHROPIC_MODEL`, 기본 `claude-opus-4-8`).
- **`agent/src/core/agent.ts`**: `ToolRepos`에 `introspect: IntrospectRepo` 추가(ToolCtx 로 전달). `makeRunAgentTurn(repos, deployTarget, model, sdkVersion)` 로 확장 → `query()` 옵션에 `model` 전달. init 메시지(`subtype:"init"`)에서 실제 `model` 을 캡처해 `TurnResult`(또는 ToolCtx 경유)로 넘겨 runtime_info 가 실측 모델을 보고할 수 있게 한다(불가하면 최소한 console 로깅하고 runtime_info 는 설정값 보고).
- **`agent/src/core/tools.ts`**: `buildTools`에 `db_schema`·`db_query`·`runtime_info` 도구·핸들러 추가(db_* 핸들러는 `ctx.isOwner` 확인 후 `assertReadOnlySql` → `ctx.repos.introspect.*`; runtime_info 는 주입된 런타임 사양 반환). `allowedToolsFor` 의 소유자 DM(cloud·local) 브랜치에 세 도구 추가.
- **`agent/src/core/persona.ts`**: 소유자 DM 능력 블록에 능력 안내 한 줄(자기 구조·런타임을 조회해 실측으로 답하라).
- **`agent/src/index.ts`·`agent/src/worker/jobRunner.ts`(및 worker.ts)**: `introspect: new IntrospectRepo(db)` 배선 + `makeRunAgentTurn` 에 `config.model` 전달(워커도 동일 모델).

### 7.2 데이터 흐름
소유자 DM turn → allowedToolsFor 가 db_query 노출 → 모델이 db_query(sql) 호출 → 핸들러가 isOwner 확인 → assertReadOnlySql → IntrospectRepo.readOnlyQuery(READ ONLY tx) → 행 절단 후 텍스트 반환.

## 8. 데이터 영향
- **새 스키마 없음.** 기존 테이블을 읽기만 한다.
- 신규 코드: sqlGuard(순수) + IntrospectRepo(2 메서드) + 도구 2개 + 배선.

## 9. 테스트 전략
- **`assertReadOnlySql` 순수 유닛(강함)**: 허용(단순 SELECT, WITH…SELECT, 개행·주석 포함) / 거부(INSERT/UPDATE/DELETE/DDL, 세미콜론 다중문, `SELECT … ; DROP …`, 대소문자·선행 공백 변형, 빈 문자열).
- **핸들러 유닛**: 손님/서버 ctx 에서 도구가 노출되지 않음(allowedToolsFor), 소유자 아닌 ctx 에서 핸들러가 거부, 결과 행 상한·셀 절단.
- **pg-mem 한계 주의**: pg-mem 이 `SET TRANSACTION READ ONLY`·`statement_timeout`·`information_schema` 를 완전히 흉내내지 못할 수 있다. READ ONLY 강제·schema 조회의 **실제 동작은 실 Supabase 스모크로 검증**(쓰기 시도 거부·information_schema 반환·timeout). 계획 단계에서 작은 스파이크로 pg-mem 지원 범위를 먼저 확인하고, 미지원이면 그 경로는 실 Postgres 전용으로 표시.
- **실 Supabase 스모크**: db_schema 반환, 정상 SELECT, 쓰기 SQL 이 READ ONLY tx 로 거부, timeout 동작.
- **runtime_info·모델**: runtime_info 가 설정 모델/SDK/배포/한도를 반환하는지 유닛. `config.model` 기본값(`claude-opus-4-8`)·env 재정의 유닛. **실제 Opus 4.8 구동은 배포 스모크로 확인**(init 모델 로깅·"어떤 모델?" 응답).

## 10. 범위·비범위
**포함**: db_schema·db_query·runtime_info 도구 + 다층 안전 + 소유자 전용 배선(봇·워커) + persona 능력 안내 + **모델 구성(Opus 4.8 기본, env 재정의)** + init 실측 모델 캡처(가능 시).

**비범위(후속)**:
- B(작업 관찰: actions 로깅 + recent_actions) — 이미 설계됨, 다음 사이클.
- A(사용량·상태: status/my_usage).
- 다른 읽기 소스: `read_logs`(운영 서버 로그)·`read_github`(레포 브랜치·커밋·작업) 등 — 같은 "읽기 소스" 계열로 별도 스펙. 이번엔 db_* 만 깔끔히 두어 그 확장을 준비.
- 쓰기 SQL·raw 실행 — 하지 않는다(읽기 전용 고정).

## 11. 리스크·미결
- **assertReadOnlySql 는 완전한 파서가 아님** → 진짜 방어는 READ ONLY tx. 사전검사는 UX(빠른 거부 메시지)·심층방어용. 이 관계를 코드 주석·스펙에 명확히.
- **정보 노출 범위**: 소유자가 모든 데이터 조회 가능(설계상 허용). 문서화.
- **pg-mem 검증 공백**: READ ONLY 강제·information_schema·timeout 은 실 Postgres 에서만 확실 → 스모크 필수.
- **대량 결과**: 행 상한·셀 절단·timeout 으로 방어. 그래도 넓은 쿼리는 느릴 수 있음(소유자 전용이라 남용 위험은 낮음).
- **Opus 4.8 가용성·비용**: 구독 플랜이 Opus 접근을 허용해야 함. 미허용 시 SDK 동작(에러/폴백)을 배포 스모크로 확인하고 env 로 조정. Opus 는 지연↑·구독 사용량 소모↑ — 상주 봇 특성상 감안(필요 시 손님 턴은 다른 모델 등 후속 최적화 여지, 이번 범위 밖).
- **런타임 인지 정확도**: runtime_info 가 설정값을 보고할 때 실제 실행 모델과 다를 수 있음(구독 폴백 등) → init 실측 모델 캡처로 최대한 실제값 보고, 불가 시 "설정상" 명시.

## 12. 다음 단계
1. 이 스펙 사용자 리뷰.
2. writing-plans 로 구현 계획(TDD: sqlGuard 순수 → IntrospectRepo → 도구·게이팅 → 배선(봇·워커) → persona → 실 Supabase 스모크).
3. 구현·리뷰·병합 후 소유자 스모크(schema 조회·정상 SELECT·쓰기 거부).
4. 후속: B(작업 관찰) → A(사용량) → 읽기 소스 확장(로그·GitHub).
