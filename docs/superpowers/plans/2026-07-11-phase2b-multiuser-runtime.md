# 2B 멀티유저·멀티채널 런타임 배선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 또는 executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 1단계 런타임(소유자 DM·전역세션·파일기억)을 2A 스키마 위의 **멀티유저·멀티채널**로 교체한다: 서버 @멘션→스레드, 역할 게이트(소유자+허용), 대화별 세션+대화락, 프라이버시 스코프 기억 주입(DM=개인+공용/서버=공용), 유저별+전역 한도(turns), 그리고 기억 쓰기/읽기 도구(remember/recall)와 접근관리(manage_access).

**Architecture:** 코어를 "전역 세션 1개"에서 "**대화(conversation)별 세션 + 대화 키별 직렬락**"으로 재작성한다. 디스코드 어댑터는 DM+서버 @멘션을 감지해 대화(conversations 행)로 매핑하고 스레드를 멱등 생성한다. 기억은 2A `MemoriesRepo`에서 스코프별로 주입하고, 에이전트는 인프로세스 MCP 도구(remember/recall/manage_access)로 DB 기억을 쓴다. 도구셋(allowedTools)은 턴마다 role·is_private로 결정한다(스펙 §7.1). 파일기반 기억(1단계)은 제거한다.

**Tech Stack:** 1단계 + 2A와 동일. `@anthropic-ai/claude-agent-sdk`(인프로세스 MCP 도구·권한 훅), discord.js v14.26(스레드).

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-11-multiuser-selfaware-db-design.md`(v2). 이 계획은 §5·§6·§7(도구)·§8을 구현한다. §7 자기인지(db_query/db_schema/status)와 관측(actions/logs 훅)·백업은 **2C/2D**.
- 프라이버시 불변식(**절대 위반 금지**): 개인(`scope='user'`) 기억·전원열람은 **소유자 DM(is_private=1, primary_user_id=owner)에서만**. 서버(스레드 포함)는 **공용(shared)만** 주입. 타인 개인기억은 어떤 경로로도 미주입/미노출(§6).
- 능력 계층(§7.1): PC/파일 도구·특권 도구는 소유자 DM 턴에서만. 손님·서버 턴은 대화+본인기억(recall)만. 턴별 `allowedTools`로 집행.
- 동시성: 같은 conversation 직렬(재진입 금지), 다른 conversation 병렬. `세션읽기→턴→session_id쓰기`는 대화락 안에서 원자적.
- 한도: 매 LLM 턴을 `TurnsRepo.reserve`로 원자 예약(유저별+전역, 소유자 예약분). 초과면 안내 후 중단.
- ESM `.js` import, TS5, 실행 cwd=agent, 사용자-노출 한국어. 2A 리포 재사용, 새 코드는 store 외 계층에.
- **에이전트 cwd**는 소스가 아닌 데이터 영역(`config.dataDir` 상위)로 둔다(1단계 점검 지적: 소스 훑기 방지).

---

### Task 1: 스파이크 — Agent SDK 인프로세스 도구/권한 + discord.js 스레드 API 검증

목적: 코드 작성 전, 실제 설치 버전의 API를 확정한다(1단계에서 clientReady·SDK 필드 검증했던 것과 동일).

**Files:** Create: `docs/superpowers/notes/2b-api-spike.md` (검증 결과 기록)

- [ ] **Step 1**: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`에서 다음을 확인·기록:
  - 인프로세스 MCP 도구 정의 방법(예: `createSdkMcpServer`, `tool(name, desc, zodSchema, handler)`)과 `query` options에 등록하는 필드(`mcpServers`), 도구 이름 규칙.
  - 턴별 도구 허용/차단: `canUseTool` 콜백 또는 `allowedTools`/권한 훅 시그니처. 도구 호출 결과 형식.
  - 현재 상대 role을 handler에서 알 방법(클로저로 주입).
- [ ] **Step 2**: discord.js v14.26 타입에서 확인·기록:
  - 스레드 생성: `Message.startThread({ name, autoArchiveDuration })` 반환·권한(CreatePublicThreads/SendMessagesInThreads), 실패 예외.
  - 스레드 판별: `channel.isThread()`, `ChannelType.PublicThread`, thread.id.
  - 채널 최근 메시지: `channel.messages.fetch({ limit })`.
  - 멘션 판별: `message.mentions.has(client.user)`.
- [ ] **Step 3**: 결과를 `2b-api-spike.md`에 "확정 API" 목록으로 적고 커밋.

```bash
git add docs/superpowers/notes/2b-api-spike.md
git commit -m "docs(2b): SDK 인프로세스 도구·discord 스레드 API 스파이크"
```

> 이후 태스크의 코드는 이 스파이크에서 확정한 실제 시그니처를 사용한다. 아래 코드의 SDK 도구/스레드 호출부는 스파이크 결과에 맞춰 조정할 것.

---

### Task 2: config·게이팅 확장

**Files:** Modify: `src/config.ts`, Test: `tests/config.test.ts`(추가)

**Interfaces (Produces):** `Config`에 추가:
```typescript
maxTurnsPerHourPerUser: number; // 기본 20
maxTurnsPerHourGlobal: number;  // 기본 40
ownerReserve: number;           // 기본 10 (전역 중 소유자 몫)
```
(기존 `maxTurnsPerHour`는 하위호환 유지하되 코어는 위 3개를 사용.)

- [ ] **Step 1**: 실패 테스트 추가 — 기본값·검증(양수). 예:
```typescript
it("멀티유저 한도 기본값을 로드한다", () => {
  const c = loadConfig({ DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "o" });
  expect(c.maxTurnsPerHourPerUser).toBe(20);
  expect(c.maxTurnsPerHourGlobal).toBe(40);
  expect(c.ownerReserve).toBe(10);
});
```
- [ ] **Step 2~4**: `positiveNumberEnv`로 `MAX_TURNS_PER_HOUR_PER_USER`/`_GLOBAL`/`OWNER_RESERVE` 파싱(기본 20/40/10). `.env.example`에 3줄 추가. 테스트 통과.
- [ ] **Step 5**: 커밋 `feat(2b): config 멀티유저 한도`.

---

### Task 3: 디스코드 어댑터 — 멀티채널·스레드·게이트

**Files:** Modify(재작성): `src/adapters/discord.ts`; Test: `tests/discordRouting.test.ts`(순수 함수만)

**Interfaces (Produces):**
```typescript
// 순수 라우팅 결정(테스트 용이): 인입 메시지 → 어떤 대화로/응답할지
export type Incoming = { userId: string; channelId: string; isDM: boolean; isThread: boolean; mentionsBot: boolean; guildId?: string; parentChannelId?: string; content: string; messageId: string };
export type RouteDecision =
  | { kind: "ignore" }                                   // 게이트 탈락
  | { kind: "dm" }                                       // 그 사용자 DM 대화
  | { kind: "thread-existing" }                          // 이미 conversations 행 있는 스레드
  | { kind: "thread-create" }                            // @멘션 → 새 스레드 생성
  | { kind: "adopt-thread" };                            // 이미 스레드 안 @멘션 → 그 스레드 채택
export function decideRoute(i: Incoming, role: "owner" | "allowed" | "blocked", hasConversation: boolean): RouteDecision;
```
규칙: role∉{owner,allowed} → ignore. DM → dm. 스레드 내부이며 conversations 존재 → thread-existing. 스레드 내부 & 멘션 → adopt-thread. 채널에서 멘션 → thread-create. 그 외(멘션 없음·비대화 채널) → ignore.

- [ ] **Step 1**: 실패 테스트 — `decideRoute` 케이스(게이트/DM/스레드생성/채택/무시). role=blocked면 항상 ignore.
- [ ] **Step 2~4**: `decideRoute` 구현 + `DiscordAdapter` 재작성:
  - intents에 스레드 관련 유지, `messageCreate`에서 `Incoming` 구성(role은 UsersRepo로 조회 — 어댑터에 주입) → `decideRoute` → `user_message` 이벤트에 **대화 매핑 힌트**(channelId/isThread/mention/messageId/guildId/parentChannelId)를 실어 발행.
  - 실제 스레드 생성/전송은 어댑터가 담당하되 **멱등**(origin_message_id 존재 검사는 코어/리포가; 어댑터는 startThread 실패 시 인플레이스 폴백 + logs). 채널 컨텍스트 fetch는 **허용 사용자 발화만** 필터.
  - 전송은 **채널(channelRef)별 체인**으로 직렬화(1단계 단일체인을 per-channel 맵으로 일반화).
- [ ] **Step 5**: 테스트 통과(순수함수) + `npx tsc --noEmit`.
- [ ] **Step 6**: 커밋 `feat(2b): 디스코드 멀티채널·스레드·역할게이트·채널별 전송체인`.

> 봇 연결·스레드 생성 자체는 유닛 테스트하지 않고 Task 7 스모크로 검증(1단계 방식).

---

### Task 4: 코어 재작성 — 대화별 세션·대화락·프라이버시 주입·한도

**Files:** Modify(재작성): `src/core/core.ts`; Test: `tests/coreMulti.test.ts`

**Interfaces (Consumes):** 2A 리포 전부(`UsersRepo/ConversationsRepo/ParticipantsRepo/MessagesRepo/SummariesRepo/MemoriesRepo/TurnsRepo/SettingsRepo`), `TurnRunner`(도구·role 인자 추가, Task 5), `Config`.

핵심 동작(스펙 §5.2, 테스트가 검증):
1. `user_message`(대화 힌트 포함) → 큐. **conversation_id별 직렬락**: 같은 대화 직렬, 다른 대화 병렬(대화별 큐/mutex 맵).
2. 대화 확정/생성(DM/thread, 멱등: origin_message_id). `ParticipantsRepo.upsert`.
3. `TurnsRepo.reserve`(유저별·전역·소유자예약, now, window=1h). 실패 시 `system_notice` 안내 후 종료.
4. 세션: `conversations.session_id` 있고 유휴 이내 → resume(메시지만). 아니면 새 세션 —
   - `is_private && primary_user_id===owner` → `MemoriesRepo.forUser(owner)` (개인+공용) 주입, `private_memory_loaded=1`.
   - 그 외(서버·손님 DM은 손님 개인은 그 손님 DM에서만…): **DM(손님)**=forUser(손님), **서버**=`MemoriesRepo.sharedOnly()`. 개인기억은 DM에서만.
   - + 이 대화 요약(SummariesRepo.recent)·최근 메시지(MessagesRepo.recent).
5. `runTurn({ prompt, systemPrompt, resume, cwd: dataWorkdir, role, isPrivate, isOwner, userId, conversationId })`.
6. 성공: assistant 메시지 저장, `conversations.setSession`. 빈 결과 폴백. 실패 알림.
7. 유휴정리: 대화별로 유휴 세션 요약→종료(대화락 안에서, compare-and-delete).

- [ ] **Step 1**: 실패 테스트(가짜 runTurn 주입) — 검증 목록:
  - DM 소유자 새 세션에 **개인기억 주입**, 서버 새 세션엔 **공용만**(개인 미주입).
  - 서버에서 온 턴은 `runTurn` 인자 role/isPrivate가 손님/false로 전달(도구 제한 근거).
  - 같은 대화 두 메시지 직렬 처리, **다른 대화는 병렬**(둘 다 진행).
  - `TurnsRepo`로 유저별 한도 초과 시 미호출+안내, 전역 소유자예약 동작.
  - resume vs 새 세션(유휴 경계), 대화별 독립 세션.
  - 크래시 복구: 미처리 메시지 재개(2A `MessagesRepo.unprocessedUserMessages`).
- [ ] **Step 2~4**: 구현. 1단계 코어의 큐/락 로직을 **대화별 맵**으로 확장(대화별 processing 플래그/큐). 프라이버시 주입은 §6 규칙을 그대로.
- [ ] **Step 5**: 테스트 통과 + tsc.
- [ ] **Step 6**: 커밋 `feat(2b): 코어 재작성 — 대화별 세션·대화락·프라이버시 주입·turns 한도`.

---

### Task 5: 에이전트 도구(remember/recall/manage_access) + 턴별 도구셋

**Files:** Modify: `src/core/agent.ts`(도구·role별 allowedTools), Create: `src/core/tools.ts`(인프로세스 MCP 도구), `src/core/persona.ts`(도구 안내로 갱신); Test: `tests/tools.test.ts`(핸들러 로직 순수 검증)

**Interfaces (Produces):**
```typescript
// tools.ts — 현재 턴 컨텍스트를 클로저로 받는 도구 팩토리
export function buildTools(ctx: { repos: {...}; role: Role; isPrivate: boolean; isOwner: boolean; userId: string; conversationId: number }): SdkMcpServer;
// 도구: remember(title, content) → MemoriesRepo.insert(scope 'user', userId=ctx.userId) (손님/서버 강제 user)
//       recall(query) → MemoriesRepo.searchForUser(userId) / 소유자DM이면 all() 검색
//       manage_access(userId, role) → 소유자 DM 전용, UsersRepo.upsert (직접발화만)
// agent.ts — allowedTools = f(role, isPrivate): 소유자 DM → 파일도구+remember/recall/manage_access; 손님DM → remember/recall(본인); 서버 → recall(공용)만 or 없음.
export type TurnRequest = { prompt: string; systemPrompt: string; resume?: string; cwd: string; tools: SdkMcpServer; allowedTools: string[] };
```

- [ ] **Step 1**: 실패 테스트 — 도구 핸들러 로직(DB 주입)만 순수 검증: remember는 항상 ctx.userId·scope='user'로 저장(손님이 shared 못 씀), recall 스코프(손님=본인+공용/소유자=전원), manage_access는 isOwner&&isPrivate 아니면 거부.
- [ ] **Step 2~4**: `buildTools` 구현(스파이크의 SDK 도구 API 사용), `agent.ts`에 도구·allowedTools 배선, persona를 "기억은 remember 도구로, 먼저 간결히 답하고 정말 중요할 때만 저장"으로 갱신(1단계 점검 🔴 반영: 불필요한 도구 왕복 억제). 파일기반 기억 지시 제거.
- [ ] **Step 5**: 테스트 통과 + tsc.
- [ ] **Step 6**: 커밋 `feat(2b): 기억·접근관리 도구 + 턴별 도구셋(role·DM 게이트)`.

---

### Task 6: 진입점 배선

**Files:** Modify: `src/index.ts`; Test: 없음(스모크는 Task 7)

- [ ] **Step 1**: `openDb` 후 `migrateFromPhase1(db, { ownerId: config.ownerId, memoryDir: config.memoryDir })` 1회 호출(2A). 새 리포들 생성, 새 `AgentCore` 배선(runTurn=새 agent, 리포 주입). `DiscordAdapter`에 UsersRepo 주입. 에이전트 cwd=데이터 작업폴더. 소유자를 users(owner)로 보장. 유휴정리 타이머는 대화별 유휴정리를 호출.
- [ ] **Step 2**: `npx tsc --noEmit && npm test` 전부 통과.
- [ ] **Step 3**: 커밋 `feat(2b): 진입점 배선 — 마이그레이션·새 코어·멀티채널 어댑터`.

---

### Task 7: 통합 스모크 (사용자 수동)

- [ ] 소유자 DM 대화 정상(개인기억 회상). 
- [ ] 소유자가 "○○ 허용" → 그 사용자만 응답, 미허용자 무응답.
- [ ] 서버 채널 @멘션 → 스레드 생성 → 스레드에서 멘션 없이 대화 지속.
- [ ] **프라이버시**: 손님과 소유자가 같은 서버 스레드에 있을 때 소유자 개인기억이 노출되지 않음(서버=공용만).
- [ ] 유저별/전역 한도 도달 시 안내. 재시작 후 기억·미처리 메시지 이어짐.
- [ ] Beekeeper로 `conversations/messages/memories/turns` 확인.

## 완료 기준 (2B DoD)

1. `npm test` 전체 통과, tsc·빌드 깨끗.
2. 소유자+허용 사용자만 응답(역할 게이트). 서버 @멘션→스레드 대화.
3. 대화별 독립 세션+대화락(동시 대화 안전). 유저별+전역 한도(소유자 예약).
4. **프라이버시 불변식 성립**: 개인기억·전원열람은 소유자 DM에서만, 서버=공용만(유닛+스모크로 확인).
5. 기억을 remember/recall 도구(DB)로 관리(파일기억 제거). 손님은 PC/특권도구 불가.
6. 1단계 데이터가 마이그레이션되어 이어짐.

> **다음(2C)**: db_query/db_schema/status/my_usage 자기인지, SDK 훅으로 actions/turns 관측·에러 logs, (2D) 백업. 2B가 안정된 뒤 별도 계획.
