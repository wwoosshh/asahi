---
lastReviewed: 2026-07-13
---

# 용어집 (Glossary)

코드베이스 전반에서 반복되는 용어를 한곳에 정리한다. 정의는 모두 코드 원문
(`agent/src/**`)을 근거로 하며, 새로 합류하는 기여자가 다른 문서·코드를 읽을 때 참조하는
용도다.

## conversation vs SDK session

- **conversation**: `store/conversationsRepo.ts`의 `conversations` 테이블 행. 디스코드
  채널 하나(DM 또는 스레드)에 대응하는 영속 개념으로, `discordChannelId`가 조회 키다.
  대화 상대(`primaryUserId`), 공개 여부(`isPrivate`), 상태(`active`/`idle`/`closed`) 등을
  갖는다.
- **SDK session**: `conversation.sessionId`에 저장되는, Claude Agent SDK의 `query()`가
  관리하는 세션 식별자(`resume` 키). 열린 세션이 유휴 시간(`sessionIdleMinutes`, 기본
  30분) 안이면 그 세션을 `resume`하고, 지났으면 새 세션을 시작하며 기억 컨텍스트
  (`buildContextBlock`)를 주입한다. `resume` 대상 세션을 SDK가 찾지 못하면
  (`isSessionNotFound`) 새 세션으로 폴백한다.
- **관계**: 하나의 conversation은 시간에 따라 여러 SDK session을 거칠 수 있지만(유휴로
  닫혔다 재개되면 새 세션), 한 시점엔 최대 하나의 활성 session만 갖는다.

## ingest 체인 vs turn 체인

`AgentCore`(`core/core.ts`)는 대화 채널(`discordChannelId`)별로 두 개의 독립된 직렬 큐
(`Map<string, Promise<void>>`)를 관리한다.

- **ingest 체인**(`ingestChains`): durable 저장만 담당한다 — 대화 행 확정
  (`resolveConversation`), 참가자 upsert, 사용자 메시지를 `processed=false`로 저장. 짧게
  끝난다.
- **turn 체인**(`turnChains`): 실제 LLM 턴 실행(`runConversationTurn`)을 담당한다 — 한도
  예약, 위임 판단, SDK 턴 실행, 응답 발행, `processed=true`로 마감(`markProcessed`). 길게
  걸릴 수 있다.
- **분리 이유**: 하나의 체인으로 묶으면 앞선 메시지의 긴 LLM 턴이 끝날 때까지 뒤 메시지가
  insert조차 되지 못해, 그 사이 크래시하면 `recoverPending`이 복구할 행 자체가 없어 영구
  유실될 수 있다. 두 체인을 분리하면 durable 저장은 LLM 턴 길이와 무관하게 항상 빠르게
  끝나 크래시 복구 불변식이 유지된다.

## 위임 / heartbeat / online-cutoff

- **위임(delegation)**: 소유자 DM이고 이미지가 없는 턴을, 클라우드 봇(Railway) 대신
  소유자의 로컬 워커에서 실행하도록 넘기는 것(`AgentCore.delegateToWorker`). 이미지 없음·
  소유자 신원·DM(사적 대화)·워커 온라인, 네 조건을 **모두** 만족해야 한다.
- **heartbeat**: 로컬 워커(`worker.ts`)가 10초 간격(`HEARTBEAT_MS`)으로
  `worker_heartbeats` 테이블에 자신의 생존 신호를 기록하는 것(`JobsRepo.heartbeat`).
- **online-cutoff**: 봇이 워커의 생존 여부를 판정하는 기준. 마지막 하트비트가
  `WORKER_ONLINE_CUTOFF_MS = 30_000`(30초, `core.ts`)보다 오래됐으면 오프라인으로
  간주한다(`JobsRepo.isOnline`). 하트비트 간격(10초)의 3배 값으로, 한두 번 하트비트가
  늦어도 잘못 오프라인 판정하지 않도록 여유를 둔 것이다.

## `deployTarget`

`Config.deployTarget`(`config.ts`): 환경변수 `DEPLOY_TARGET`이 정확히 `"cloud"`일 때만
`"cloud"`, 그 외(미설정·오타 포함)는 전부 `"local"`이다. `"cloud"`면 소유자 DM이라도
파일/Bash 같은 PC 도구를 도구셋에서 제외하고(`allowedToolsFor`), `canUseTool`에서
이중 방어로 즉시 거부한다. Railway 클라우드 봇(`index.ts`)이 이 값을 그대로 쓰고, 로컬
워커(`worker.ts`)는 항상 `"local"`로 고정한다(워커는 태생적으로 로컬 실행이므로).

## `ownWorkstation`

`TurnContext.ownWorkstation`(`core/agent.ts`): 이번 턴을 그 사용자 **자신의** 로컬
워커가 실행 중임을 나타내는 플래그. 손님이라도 자기 PC에서 실행 중이면 파일/Bash 게이트
(`decidePathPermission`)의 "소유자 DM 전용" 제한을 통과시킨다(단, 경로는 여전히
`allowedDirs`로 제한된다). 클라우드 봇(`index.ts`) 경로는 항상 이 값을 생략(undefined)
한다 — 클라우드에선 결코 서지 않는다.

## `rapportStage`(0/1/2)

`persona.ts`의 `deriveRapportStage(userMessageCount)`가 그 사용자의 누적 user 메시지
수로 계산하는 친근도 3단계.

- **0**(서먹): 누적 10회 미만.
- **1**(익숙): 10회 이상.
- **2**(편함): 50회 이상.

성격·말투의 register(반말/존댓말 등)는 바꾸지 않고, 다정함의 농도만 조절한다
(`buildRelationshipBlock`). 소유자도 `messages`에 동일하게 집계되므로 예외 없이
적용된다.

## turns 예약(reserve)

`TurnsRepo.reserve()`(`store/turnsRepo.ts`)가 유저별+전역 시간당 한도
(`maxTurnsPerHourPerUser`/`maxTurnsPerHourGlobal`)를 원자적으로 검사·기록하는 것.
Postgres advisory lock(`pg_advisory_xact_lock`)으로 전역 직렬 지점을 만들어, 두 요청이
동시에 카운트를 읽고 둘 다 한도 통과로 착각하는 경합을 막는다.

소유자는 예약 자체를 생략한다(무제한 정책 — `turns` 테이블에 기록조차 되지 않아 손님
카운트에도 영향을 주지 않는다). 손님만 메시지 턴(`kind: "message"`)과 유휴 요약
(`kind: "summary"`)에 대해 예약하며, 실패하면 한도 안내 메시지 후 그 턴을 종료한다.

## owner/allowed/blocked 역할

`store/usersRepo.ts`의 `Role` 타입. 신규 사용자의 기본값은 `"blocked"`다.

- **owner**: 소유자로 등록된 사용자. 다만 실제 특권(파일/Bash/`manage_access`/DB 조회 등)
  은 역할이 아니라 **신원**(`userId === config.ownerId`)으로 판정한다 — `manage_access`로
  손님에게 `owner` 역할을 부여해도 신원이 소유자가 아니면 특권은 얻지 못한다.
- **allowed**: 대화가 허용된 손님. 대화와 본인 기억(remember/recall)은 쓸 수 있지만
  PC/DB/접근관리 도구는 없다.
- **blocked**(또는 미등록): 응답 게이트를 통과하지 못해 이벤트 자체가 처리되지 않는다
  (어댑터의 `decideRoute`와 코어의 `onUserMessage` 양쪽에서 재확인). 미등록 사용자도
  `getRole`이 `"blocked"`를 반환하므로 동일하게 취급된다.

## `allowedDirs`

`store/allowedDirsRepo.ts`의 `allowed_dirs` 테이블. 사용자별로 파일 도구
(Read/Write/Edit/Glob/Grep)·Bash가 접근을 허용받은 폴더 목록이며, `allow_dir`/
`revoke_dir`/`list_dirs` 도구로 관리한다. `canUseTool`(`core/agent.ts`)이 매 파일/Bash
호출마다 `decidePathPermission`으로 요청 경로가 이 목록 안(또는 그 하위)인지 재검사한다
— 도구셋에 노출됐다고 해서 무조건 실행이 허용되는 것은 아니다. 소유자는 자신의
`userId`(=`config.ownerId`)로, 로컬 워커를 쓰는 손님은 각자의 사용자 ID로 별도 목록을
갖는다.

## 관련 문서

- 디렉토리 책임·이벤트버스 계약: `docs/architecture/module-boundaries.md`
- 3-프로세스 토폴로지·위임 규칙 전체: `docs/architecture/overview.md`
- 메시지 하나의 전체 처리 경로: `docs/architecture/data-flow.md`
