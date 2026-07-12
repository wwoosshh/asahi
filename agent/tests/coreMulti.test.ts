import { describe, it, expect } from "vitest";
import { EventBus, type AgentEvent, type ConversationHint } from "../src/events/bus.js";
import { openTestDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";
import { JobsRepo } from "../src/store/jobsRepo.js";
import { AgentCore, WORKER_ONLINE_CUTOFF_MS } from "../src/core/core.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

const HOUR = 60 * 60 * 1000;
// pg-mem 의 Pool.query() 는 마이크로태스크가 아니라 매크로태스크(setImmediate) 단위로 풀린다
// (스파이크로 확인: 순수 Promise.resolve() 반복으로는 영원히 안 풀림). handleUserMessage 가
// resolveConversation·참가자 upsert·메시지 저장까지 순차 쿼리를 여러 번 거치므로, 그 홉 수만큼
// setImmediate 로 넘겨줘야 "아직 처리 전"인 중간 상태(manual 모드)를 정확히 관찰할 수 있다.
const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

async function setup(over: {
  config?: Partial<Config>; mode?: "immediate" | "manual" | "throw" | "resume-fails";
  sleep?: (ms: number) => Promise<void>; workerPollMs?: number; workerTimeoutMs?: number;
  imageFetch?: typeof fetch;
} = {}) {
  const db = await openTestDb();
  const repos = {
    users: new UsersRepo(db), conversations: new ConversationsRepo(db), participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db), summaries: new SummariesRepo(db), memories: new MemoriesRepo(db), turns: new TurnsRepo(db),
    jobs: new JobsRepo(db),
  };
  await repos.users.upsert("owner", { role: "owner" });
  await repos.users.upsert("guest", { role: "allowed" });
  await repos.users.upsert("guest2", { role: "allowed" });
  const config: Config = {
    discordToken: "t", ownerId: "owner", databaseUrl: "postgres://test", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    deployTarget: "local",
    ...over.config,
  };
  let clock = 1_000_000;
  const calls: TurnRequest[] = [];
  let nextResult: TurnResult = { text: "답변", sessionId: "s1", ok: true };
  const resolvers: Array<() => void> = [];
  const mode = over.mode ?? "immediate";
  const runTurn = (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    req.onProgress?.({ kind: "answering" }); // 코어가 onProgress 를 progress 이벤트로 발행하는지 확인용
    if (mode === "throw") return Promise.reject(new Error("SDK 프로세스 오류(테스트용)"));
    if (mode === "resume-fails") {
      // resume 을 쓴 턴은 "세션 없음"으로 실패(클라우드 컨테이너 재시작 등), 새 세션 턴은 성공.
      if (req.resume) return Promise.reject(new Error(`Claude Code returned an error result: No conversation found with session ID: ${req.resume}`));
      return Promise.resolve(nextResult);
    }
    if (mode === "immediate") return Promise.resolve(nextResult);
    return new Promise((res) => resolvers.push(() => res(nextResult)));
  };
  const bus = new EventBus();
  // 위임 폴링 기본 sleep: 실제 타이머 대신 가짜 시계를 poll 간격만큼 전진시키고 pg-mem 의
  // setImmediate 단위 완료를 흘려보낸다(flush) — 테스트가 실시간 대기 없이 폴링 루프를 구동한다.
  const defaultSleep = async (ms: number) => { clock += ms; await flush(); };
  const core = new AgentCore({
    bus, config, runTurn, now: () => clock, repos, agentCwd: "/data/agent",
    sleep: over.sleep ?? defaultSleep, workerPollMs: over.workerPollMs, workerTimeoutMs: over.workerTimeoutMs,
    fetchImpl: over.imageFetch,
  });
  core.start();
  const published: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => published.push(e));
  bus.subscribe("system_notice", (e) => published.push(e));
  bus.subscribe("progress", (e) => published.push(e));
  return {
    db, bus, core, calls, published, repos, resolvers,
    setClock: (t: number) => { clock = t; },
    setResult: (r: TurnResult) => { nextResult = r; },
    now: () => clock,
  };
}

let seq = 0;
function dmHint(userId: string, role: "owner" | "allowed"): ConversationHint {
  return { kind: "dm", discordChannelId: `dm-${userId}`, isPrivate: true, primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}` };
}
function threadHint(userId: string, channelId: string, role: "owner" | "allowed", origin: string): ConversationHint {
  return { kind: "thread", discordChannelId: channelId, originMessageId: origin, guildId: "g", parentChannelId: "p", isPrivate: false, primaryUserId: userId, userId, role, discordMessageId: `msg-${seq++}` };
}
function pub(bus: EventBus, hint: ConversationHint, text: string, ts: number): void {
  bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text, ts, hint });
}

describe("AgentCore — 멀티유저/멀티대화", () => {
  it("소유자 DM 새 세션엔 개인+공용 기억, 서버 대화엔 공용만 주입한다(프라이버시 불변식)", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "owner", scope: "user", title: "개인", content: "소유자비밀ABC" });
    await t.repos.memories.insert({ userId: "owner", scope: "shared", title: "공용", content: "공용정보XYZ" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("소유자비밀ABC");
    expect(t.calls[0].prompt).toContain("공용정보XYZ");

    pub(t.bus, threadHint("owner", "ch-1", "owner", "o1"), "서버안녕", 2);
    await t.core.drain();
    expect(t.calls[1].prompt).not.toContain("소유자비밀ABC"); // 서버엔 개인기억 미주입
    expect(t.calls[1].prompt).toContain("공용정보XYZ");
  });

  it("손님 DM 은 그 손님의 개인기억만 주입하고, 소유자 개인기억은 넣지 않는다", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님비밀G" });
    await t.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자비밀O" });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("손님비밀G");
    expect(t.calls[0].prompt).not.toContain("소유자비밀O");
  });

  it("역할이 'owner'로 부여된 손님이라도 소유자 신원이 아니면 특권(isOwner)을 갖지 않는다(프라이버시 게이트 신원화)", async () => {
    const t = await setup();
    await t.repos.users.upsert("guest", { role: "owner" }); // 손님에게 owner 역할이 부여된 상황
    pub(t.bus, dmHint("guest", "owner"), "hi", 1);     // role=owner 로 들어오지만 userId≠ownerId
    await t.core.drain();
    expect(t.calls[0].context.isOwner).toBe(false);    // 신원(userId===ownerId)이 아니므로 전원열람·특권 없음
  });

  it("턴 컨텍스트로 role/isPrivate/isOwner 를 정확히 전달한다(도구 제한 근거)", async () => {
    const t = await setup();
    pub(t.bus, threadHint("guest", "ch-1", "allowed", "g1"), "hi", 1);
    await t.core.drain();
    expect(t.calls[0].context).toMatchObject({ role: "allowed", isPrivate: false, isOwner: false, userId: "guest" });

    pub(t.bus, dmHint("owner", "owner"), "hi", 2);
    await t.core.drain();
    expect(t.calls[1].context).toMatchObject({ role: "owner", isPrivate: true, isOwner: true, userId: "owner" });
    expect(t.calls[1].cwd).toBe("/data/agent");
  });

  it("같은 대화는 직렬(재진입 금지)로 처리한다", async () => {
    const t = await setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "A1", 1);
    pub(t.bus, dmHint("owner", "owner"), "A2", 2);
    await flush();
    expect(t.calls.length).toBe(1); // A2 는 A1 이 끝날 때까지 대기
    t.resolvers.shift()!();
    await flush();
    expect(t.calls.length).toBe(2);
  });

  it("앞 메시지 턴이 진행 중이어도 같은 채널 후속 메시지가 즉시 durable 저장된다(크래시 복구 회귀 방지)", async () => {
    const t = await setup({ mode: "manual" });
    const hint = dmHint("owner", "owner");
    pub(t.bus, hint, "A", 1);
    await flush();
    expect(t.calls.length).toBe(1); // A 의 턴이 시작되어(LLM 호출) 대기 중

    pub(t.bus, hint, "B", 2);
    await flush();
    // B 의 턴은 A 뒤에 직렬(turnChains)이라 아직 시작되지 않았어야 하지만,
    // durable 저장(ingest)은 턴과 분리되어 있으므로 A·B 모두 이미 processed=false 로 저장돼 있어야 한다.
    expect(t.calls.length).toBe(1);
    const unprocessed = await t.repos.messages.unprocessedUserMessages();
    expect(unprocessed.map((m) => m.content)).toEqual(["A", "B"]);

    t.resolvers.shift()!(); // A 턴 완료 → B 턴 시작
    await flush();
    expect(t.calls.length).toBe(2);
    t.resolvers.shift()!(); // B 턴 완료
    await flush();
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0);
  });

  it("다른 대화는 병렬로 동시에 진행한다", async () => {
    const t = await setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "A", 1);
    pub(t.bus, threadHint("owner", "ch-x", "owner", "ox"), "B", 2);
    await flush();
    expect(t.calls.length).toBe(2); // 서로 다른 대화 → 둘 다 시작
  });

  it("유저별 한도를 넘으면 LLM 을 호출하지 않고 안내한다", async () => {
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1 } });
    pub(t.bus, dmHint("guest", "allowed"), "1", 1);
    await t.core.drain();
    pub(t.bus, dmHint("guest", "allowed"), "2", 2);
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("한도");
  });

  it("소유자는 유저별·전역 한도를 전혀 받지 않는다(무제한)", async () => {
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1, maxTurnsPerHourGlobal: 1 } });
    for (let i = 0; i < 4; i++) {
      pub(t.bus, dmHint("owner", "owner"), `m${i}`, i + 1);
      await t.core.drain();
    }
    expect(t.calls.length).toBe(4); // 1/1 한도를 무시하고 4번 모두 처리
  });

  it("손님 전역 상한은 globalLimit 이며, 소유자 사용량은 손님 카운트에 영향을 주지 않는다", async () => {
    const t = await setup({ config: { maxTurnsPerHourGlobal: 2, maxTurnsPerHourPerUser: 99 } });
    // 소유자가 여러 번 사용해도(무제한·카운트 제외) 손님 몫에 영향 없음
    for (let i = 0; i < 3; i++) {
      pub(t.bus, dmHint("owner", "owner"), `o${i}`, i + 1);
      await t.core.drain();
    }
    const guestCalls = () => t.calls.filter((c) => c.context.userId !== "owner").length;
    // 손님 두 명이 전역 2까지
    pub(t.bus, dmHint("guest", "allowed"), "g1", 10);
    await t.core.drain();
    pub(t.bus, dmHint("guest2", "allowed"), "g2", 11);
    await t.core.drain();
    expect(guestCalls()).toBe(2);
    // 손님 전역 상한(2) 도달 → 세 번째 손님 발화는 막힘
    pub(t.bus, dmHint("guest", "allowed"), "g3", 12);
    await t.core.drain();
    expect(guestCalls()).toBe(2);
  });

  it("resume 세션이 없으면(클라우드 재시작 등) 새 세션 + 기억 컨텍스트로 재시도한다", async () => {
    const t = await setup({ mode: "resume-fails" });
    // 첫 메시지: resume 없이 새 세션 → 성공(세션 s1 저장)
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].resume).toBeUndefined();
    // 두 번째: resume s1 시도 → "세션 없음" 실패 → 새 세션으로 재시도 성공
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect(t.calls.length).toBe(3);
    expect(t.calls[1].resume).toBe("s1");        // resume 시도(실패)
    expect(t.calls[2].resume).toBeUndefined();   // 새 세션 재시도
    expect(t.calls[2].prompt).toContain("기억 컨텍스트");
    // 최종 답변이 정상 발행되고, 오류 안내가 나가지 않는다
    expect(t.published.some((e) => e.type === "assistant_message")).toBe(true);
    expect(t.published.find((e) => e.type === "system_notice" && e.text.includes("오류"))).toBeUndefined();
  });

  it("유휴 이내면 resume, 유휴가 지나면 새 세션으로 시작한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    expect(t.calls[0].resume).toBeUndefined();
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect(t.calls[1].resume).toBe("s1");
    t.setClock(1_000_000 + 31 * 60 * 1000);
    pub(t.bus, dmHint("owner", "owner"), "3", t.now());
    await t.core.drain();
    expect(t.calls[2].resume).toBeUndefined();
    expect(t.calls[2].prompt).toContain("기억 컨텍스트");
  });

  it("대화마다 세션이 독립이다(A 의 세션으로 B 를 resume 하지 않는다)", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "A1", 1);
    await t.core.drain();
    pub(t.bus, threadHint("owner", "ch-b", "owner", "ob"), "B1", 2);
    await t.core.drain();
    expect(t.calls[1].resume).toBeUndefined(); // 새 대화 B → resume 없음
  });

  it("빈 응답이면 assistant 를 저장하지 않고 폴백 안내를 보낸다", async () => {
    const t = await setup();
    t.setResult({ text: "   ", sessionId: "s1", ok: true });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    const roles = (await t.repos.messages.recent(conv.id, 10)).map((m) => m.role);
    expect(roles).not.toContain("assistant");
    expect(t.published.find((e) => e.type === "system_notice")).toBeDefined();
  });

  it("runTurn 이 onProgress 를 호출하면 progress 이벤트가 그 대화 채널로 발행된다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const progress = t.published.find((e) => e.type === "progress");
    expect(progress).toBeDefined();
    expect(progress).toMatchObject({ type: "progress", channel: "discord", channelRef: "dm-owner", text: "답변 작성 중" });
  });

  it("턴이 실패하면 오류를 안내한다", async () => {
    const t = await setup();
    t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("오류");
  });

  it("runTurn이 예외를 던지면 system_notice를 발행하고 메시지를 완료 처리한다(유령 상태 메시지·FIFO 오염 방지)", async () => {
    const t = await setup({ mode: "throw" });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice).toBeDefined();
    expect(notice?.channelRef).toBe("dm-owner");
    // finally 의 markProcessed 는 예외 시에도 반드시 실행되어야 한다(대화 체인이 영구 정지하지 않도록).
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0);
  });

  it("부팅 시 미처리 메시지를 그 대화 문맥으로 재개한다", async () => {
    const t = await setup();
    const convId = await t.repos.conversations.create({ kind: "dm", discordChannelId: "dm-owner", primaryUserId: "owner", isPrivate: true, lastActiveTs: 1 });
    await t.repos.messages.insert({ conversationId: convId, ts: 1, role: "user", userId: "owner", content: "크래시전메시지", processed: false });
    await t.core.recoverPending();
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].prompt).toContain("크래시전메시지");
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0);
  });

  it("유휴 대화를 요약하고 세션을 닫는다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "기억해줘", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(conv.sessionId).toBe("s1");
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "인사를 나눴다.", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(await t.repos.summaries.recent(conv.id, 1)).toEqual(["인사를 나눴다."]);
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBeNull();
  });

  it("리뷰 #4(MED): 요약 시도 중 resume 세션을 못 찾아 실패해도(위임 대화 등) 요약은 건너뛰고 세션은 반드시 닫는다", async () => {
    // 위임된 대화의 세션은 워커 PC 에 있어 봇 쪽 SDK 로는 resume 이 안 된다 — summarizeAndClose 가
    // 이 실패를 그냥 던지면 compare-and-close 가 실행되지 않아 세션이 active 로 고착되고, 다음 유휴
    // 스윕마다 같은 실패를 반복하며 손님 전역 한도를 계속 갉아먹는다(회귀 확인용 mode).
    const t = await setup({ mode: "resume-fails" });
    // resume-fails 모드는 resume 없는 호출만 성공하므로, 첫 메시지로 세션을 먼저 확보한다.
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    expect(conv.sessionId).toBe("s1");

    t.setClock(1_000_000 + 31 * 60 * 1000);
    await t.core.closeIdleConversations();
    await t.core.drain();

    const after = await t.repos.conversations.getById(conv.id);
    expect(after?.sessionId).toBeNull(); // resume 실패에도 불구하고 반드시 닫힘
    expect(after?.status).toBe("idle");
    expect(await t.repos.summaries.recent(conv.id, 1)).toEqual([]); // 요약 자체는 실패했으므로 저장되지 않음
  });

  it("요약의 from_message_id 를 세션 첫 메시지로 기록한다(0 이 아님)", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "첫 메시지", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;
    const firstUserMsg = (await t.repos.messages.recent(conv.id, 10)).find((m) => m.role === "user")!;
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    const r = await t.db.query("SELECT from_message_id FROM conversation_summaries WHERE conversation_id = $1", [conv.id]);
    const row = r.rows[0] as { from_message_id: number | string };
    expect(Number(row.from_message_id)).toBe(firstUserMsg.id);
    expect(Number(row.from_message_id)).not.toBe(0);
  });

  it("유휴 정리로 닫힌 대화가 재활성되면 다음 유휴 사이클에 다시 요약된다(status 고착 방지)", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    const conv = (await t.repos.conversations.getByChannelId("dm-owner"))!;

    // 1차 유휴 정리 → 세션 닫힘
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약1", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBeNull();

    // 재활성: 새 메시지 → 새 세션 s2
    t.setResult({ text: "답", sessionId: "s2", ok: true });
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBe("s2");

    // 2차 유휴 → 다시 요약·종료되어야 한다(버그면 status='idle' 고착으로 스윕에서 누락)
    t.setClock(t.now() + 31 * 60 * 1000);
    t.setResult({ text: "요약2", sessionId: "s2", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(await t.repos.summaries.recent(conv.id, 1)).toEqual(["요약2"]);
    expect((await t.repos.conversations.getById(conv.id))!.sessionId).toBeNull();
  });
});

describe("AgentCore — 로컬 워커 위임 라우팅(하이브리드 조각3 W3)", () => {
  it("워커가 온라인이면 DM 은 로컬 대신 job 으로 위임되고, job 이 done 이 되면 assistant_message 로 발행된다", async () => {
    const t = await setup({
      // 실제 워커가 하듯: 폴링 사이(sleep) 에 pending job 을 claim 해 완료시킨다.
      sleep: async () => {
        const job = await t.repos.jobs.claimNext("owner", t.now());
        if (job) await t.repos.jobs.complete(job.id, "위임된 답변", t.now());
      },
    });
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();

    expect(t.calls.length).toBe(0); // 로컬 runTurn 은 전혀 호출되지 않음(위임됐으므로)
    expect(t.published.find((e) => e.type === "assistant_message")).toMatchObject({ text: "위임된 답변", channelRef: "dm-owner" });
    const jobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(jobRows.rows.length).toBe(1); // enqueue 됨
  });

  it("리뷰 #3(HIGH): 손님 DM 은 그 손님의 워커가 온라인이어도 위임하지 않고 이 봇이 로컬 처리한다(정책: 워커는 소유자 전용)", async () => {
    // 정책: shared DATABASE_URL 을 손님에게 주면 WORKER_USER_ID=ownerId 로 소유자를 사칭해 전권을
    // 탈취할 위험이 있어, 손님 DM 위임은 워커 온라인 여부와 무관하게 전면 비활성한다(인증 인프라 후속).
    const t = await setup();
    await t.repos.jobs.heartbeat("guest"); // 손님 몫 워커가 온라인이라고 자처해도
    pub(t.bus, dmHint("guest", "allowed"), "안녕", t.now());
    await t.core.drain();

    expect(t.calls.length).toBe(1); // 위임되지 않고 로컬 runTurn 이 호출됨
    const jobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(jobRows.rows.length).toBe(0); // job 자체가 생성되지 않음
  });

  it("손님 DM 은 위임되지 않아도 손님 시간당 한도는 기존과 동일하게 로컬 처리 경로에 적용된다", async () => {
    const t = await setup({ config: { maxTurnsPerHourPerUser: 1 } });
    await t.repos.jobs.heartbeat("guest"); // 온라인이어도 손님은 위임 대상이 아니므로 영향 없음
    pub(t.bus, dmHint("guest", "allowed"), "1", t.now());
    await t.core.drain();
    expect(t.calls.length).toBe(1);

    pub(t.bus, dmHint("guest", "allowed"), "2", t.now());
    await t.core.drain();
    expect(t.calls.length).toBe(1); // 한도 초과로 두 번째는 로컬 호출도 안 됨
    expect(t.published.filter((e) => e.type === "system_notice").some((e) => e.text.includes("한도"))).toBe(true);
    const jobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(jobRows.rows.length).toBe(0); // 손님은 애초에 위임 경로를 타지 않음
  });

  it("서버/스레드 대화는 워커가 온라인이어도 위임하지 않고 기존대로 이 봇이 로컬 처리한다", async () => {
    const t = await setup();
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, threadHint("owner", "ch-1", "owner", "o1"), "안녕", t.now());
    await t.core.drain();

    expect(t.calls.length).toBe(1); // 로컬 runTurn 이 호출됨
    const jobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(jobRows.rows.length).toBe(0); // job 은 생성되지 않음
  });

  it("워커가 오프라인(하트비트 없음)이면 DM 도 기존처럼 이 봇이 로컬 처리한다", async () => {
    const t = await setup();
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();

    expect(t.calls.length).toBe(1);
    const jobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(jobRows.rows.length).toBe(0);
  });

  it("하트비트가 컷오프보다 오래되면(오프라인 판정) 위임하지 않고 로컬 처리한다", async () => {
    const t = await setup();
    await t.repos.jobs.heartbeat("owner");
    // 리뷰 #7: isOnline 은 이제 DB 서버 시계 기준이라 앱의 가짜 시계(setClock)로는 오프라인을
    // 흉내낼 수 없다 — DB 자신의 now() 로 컷오프보다 확실히 오래된 시각을 직접 구성한다.
    await t.db.query(
      "UPDATE worker_heartbeats SET last_ts = (EXTRACT(EPOCH FROM now())*1000)::bigint - $2::bigint WHERE user_id = $1",
      ["owner", WORKER_ONLINE_CUTOFF_MS + 1000],
    );
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();

    expect(t.calls.length).toBe(1);
  });

  it("job 이 진행 중 progress 를 갱신하면 progress 이벤트로 중계되고, 완료되면 assistant_message 로 마무리된다", async () => {
    let step = 0;
    let jobId: number | null = null;
    const t = await setup({
      sleep: async () => {
        step++;
        if (step === 1) {
          const job = await t.repos.jobs.claimNext("owner", t.now());
          jobId = job!.id;
          await t.repos.jobs.setProgress(jobId, "파일 읽는 중");
        } else if (step === 2) {
          await t.repos.jobs.complete(jobId!, "완료된 답변", t.now());
        }
      },
    });
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();

    const progressTexts = t.published.filter((e) => e.type === "progress").map((e) => e.text);
    expect(progressTexts).toContain("파일 읽는 중");
    expect(t.published.find((e) => e.type === "assistant_message")?.text).toBe("완료된 답변");
  });

  it("job 이 실패로 끝나면 그 오류를 안내한다", async () => {
    const t = await setup({
      sleep: async () => {
        const job = await t.repos.jobs.claimNext("owner", t.now());
        if (job) await t.repos.jobs.fail(job.id, "워커 오류 상세", t.now());
      },
    });
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();

    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice?.text).toContain("워커 오류 상세");
    expect(t.published.some((e) => e.type === "assistant_message")).toBe(false);
  });

  it("워커가 타임아웃 동안 응답하지 않으면(계속 pending) 안내 메시지를 보낸다", async () => {
    const t = await setup({ workerPollMs: 500, workerTimeoutMs: 1500 }); // 기본 sleep: job 을 건드리지 않음(계속 pending)
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();

    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice?.text).toContain("처리 중이에요"); // 리뷰 #5a: "응답하지 않아요" → 결과를 기다리는 안내로 문구 변경
    expect(t.calls.length).toBe(0); // 로컬 처리로 폴백하지 않음
    const jobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(jobRows.rows[0].status).toBe("pending"); // job 자체는 그대로 남겨둔다
  });

  it("리뷰 #2(HIGH): 크래시로 남은 미처리 메시지가 이미 위임 job(messageId)을 갖고 있으면 recoverPending 이 중복 job 을 만들지 않는다", async () => {
    // 시나리오: 봇이 위임(enqueue)까지 마친 뒤 크래시해 그 사용자 메시지를 processed=true 로 마킹하지
    // 못했다고 가정한다(finally 가 실행되기 전 프로세스가 죽음). 재기동 후 recoverPending 이 같은
    // 메시지로 다시 위임을 시도해도, messageId 로 이미 만들어둔 job 에 합류할 뿐 새 job 을 만들지
    // 않아야 한다(중복 실행 방지).
    const t = await setup({
      sleep: async () => {
        const job = await t.repos.jobs.claimNext("owner", t.now());
        if (job) await t.repos.jobs.complete(job.id, "복구 후 위임 답변", t.now());
      },
    });
    await t.repos.jobs.heartbeat("owner");
    const convId = await t.repos.conversations.create({
      kind: "dm", discordChannelId: "dm-owner", primaryUserId: "owner", isPrivate: true, lastActiveTs: t.now(),
    });
    const messageId = await t.repos.messages.insert({
      conversationId: convId, ts: t.now(), role: "user", userId: "owner", content: "위임 대상 메시지", processed: false,
    });
    // "이전 시도"에서 이미 enqueue 까지 끝났던 상황을 직접 재현한다.
    const priorJobId = await t.repos.jobs.enqueue({
      userId: "owner", conversationId: convId, discordChannelId: "dm-owner", userMessage: "위임 대상 메시지", ts: t.now(), messageId,
    });

    await t.core.recoverPending();
    await t.core.drain();

    // 전체 행 수(필터 없이)로 검사해야 한다 — messageId 로 필터링하면 "새로 만들어진(message_id=NULL)
    // 중복 job"이 걸러지지 않고 통과해버려 회귀를 못 잡는다.
    const allJobRows = await t.db.query("SELECT * FROM worker_jobs");
    expect(allJobRows.rows.length).toBe(1); // 중복 enqueue 되지 않음(전체 테이블 기준)
    const jobRows = await t.db.query("SELECT * FROM worker_jobs WHERE message_id = $1", [messageId]);
    expect(jobRows.rows.length).toBe(1);
    expect(Number(jobRows.rows[0].id)).toBe(priorJobId);
    expect((await t.repos.messages.unprocessedUserMessages()).length).toBe(0); // 이번엔 끝까지 처리되어 마무리됨
    expect(t.published.find((e) => e.type === "assistant_message")?.text).toBe("복구 후 위임 답변");
  });
});

describe("AgentCore — 위임 결과 배달 스윕(리뷰 #5a: 타임아웃 후 유실 방지)", () => {
  it("타임아웃 후 워커가 나중에 done 으로 완료하면, 스윕이 assistant_message 를 발행하고 delivered_ts 를 남긴다", async () => {
    const t = await setup({ workerPollMs: 500, workerTimeoutMs: 1000 }); // 기본 sleep: job 을 건드리지 않음(타임아웃)
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    expect(t.published.some((e) => e.type === "system_notice" && e.text.includes("처리 중"))).toBe(true);

    const jobRows = await t.db.query("SELECT id FROM worker_jobs");
    const jobId = Number((jobRows.rows[0] as { id: number | string }).id);
    await t.repos.jobs.complete(jobId, "지연된 답변", t.now()); // 타임아웃 뒤 워커가 뒤늦게 완료

    await t.core.deliverPendingJobResults();

    expect(t.published.find((e) => e.type === "assistant_message" && e.text === "지연된 답변")).toBeDefined();
    const after = await t.repos.jobs.get(jobId);
    expect(after?.deliveredTs).not.toBeNull();
  });

  it("실패로 끝난 job 이 나중에 배달되면 system_notice 로 안내한다", async () => {
    const t = await setup({ workerPollMs: 500, workerTimeoutMs: 1000 });
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    const jobRows = await t.db.query("SELECT id FROM worker_jobs");
    const jobId = Number((jobRows.rows[0] as { id: number | string }).id);
    await t.repos.jobs.fail(jobId, "지연된 실패", t.now());

    await t.core.deliverPendingJobResults();

    const notice = t.published.filter((e) => e.type === "system_notice").find((e) => e.text.includes("지연된 실패"));
    expect(notice).toBeDefined();
  });

  it("이미 배달된(delivered_ts 있음) job 은 스윕을 두 번 돌려도 다시 발행하지 않는다(정확히 한 번 배달)", async () => {
    const t = await setup({ workerPollMs: 500, workerTimeoutMs: 1000 });
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    const jobRows = await t.db.query("SELECT id FROM worker_jobs");
    const jobId = Number((jobRows.rows[0] as { id: number | string }).id);
    await t.repos.jobs.complete(jobId, "답변1", t.now());

    await t.core.deliverPendingJobResults();
    const afterFirst = t.published.filter((e) => e.type === "assistant_message").length;
    await t.core.deliverPendingJobResults();
    const afterSecond = t.published.filter((e) => e.type === "assistant_message").length;
    expect(afterSecond).toBe(afterFirst);
  });

  it("정상 경로(타임아웃 전에 완료)로 이미 배달된 job 은 스윕이 중복 발행하지 않는다", async () => {
    const t = await setup({
      sleep: async () => {
        const job = await t.repos.jobs.claimNext("owner", t.now());
        if (job) await t.repos.jobs.complete(job.id, "정상 답변", t.now());
      },
    });
    await t.repos.jobs.heartbeat("owner");
    pub(t.bus, dmHint("owner", "owner"), "안녕", t.now());
    await t.core.drain();
    expect(t.published.filter((e) => e.type === "assistant_message")).toHaveLength(1);

    await t.core.deliverPendingJobResults();
    expect(t.published.filter((e) => e.type === "assistant_message")).toHaveLength(1); // 스윕이 중복 발행 안 함
  });
});

describe("AgentCore — 친근도(rapportStage) 주입", () => {
  it("누적 user 메시지가 적으면 소유자 프롬프트에 '서먹', 10개 이상이면 '익숙' 문구가 담긴다", async () => {
    const t = await setup();
    // 첫 대화: 이번 메시지 1개만 카운트 → stage 0(서먹)
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].systemPrompt).toMatch(/서먹/);

    // owner user 메시지를 9개 추가로 심어 다음 턴의 카운트를 10으로 만든다(9 + 이번 1 = 10)
    for (let i = 0; i < 9; i++) {
      await t.repos.messages.insert({ conversationId: 1, ts: 10 + i, role: "user", userId: "owner", content: `m${i}` });
    }
    pub(t.bus, dmHint("owner", "owner"), "또 안녕", 100);
    await t.core.drain();
    expect(t.calls[1].systemPrompt).toMatch(/익숙/);
  });
});

describe("AgentCore — DM 세션 예약어(/새세션)", () => {
  it("예약어를 받으면 세션을 리셋하고 확인만 보내며, LLM 턴·메시지 저장을 하지 않는다", async () => {
    const t = await setup();
    // 먼저 일반 대화로 세션을 하나 만든다(nextResult.sessionId = 's1').
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    const before = await t.repos.conversations.getByChannelId("dm-owner");
    expect(before?.sessionId).toBe("s1");
    const msgCountBefore = await t.repos.messages.countUserMessages("owner");

    // 예약어 전송 → 세션 리셋 + 확인, 새 턴/저장 없음.
    pub(t.bus, dmHint("owner", "owner"), "/새세션", 2);
    await t.core.drain();

    expect(t.calls).toHaveLength(1); // 새 LLM 턴이 돌지 않았다
    const after = await t.repos.conversations.getByChannelId("dm-owner");
    expect(after?.sessionId).toBeNull(); // 세션이 리셋됐다
    expect(await t.repos.messages.countUserMessages("owner")).toBe(msgCountBefore); // 명령어는 기록되지 않았다
    const notices = t.published.filter((p) => p.type === "assistant_message");
    expect(notices.some((n) => /새 세션|세션.*시작|새로/.test((n as { text: string }).text))).toBe(true);
  });
});

describe("AgentCore — 이미지 입력", () => {
  const fakeFetch = (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("img").buffer }) as Response) as unknown as typeof fetch;

  it("이미지 메시지는 마커로 저장되고, 다운로드된 이미지가 runTurn 에 전달된다", async () => {
    const t = await setup({ imageFetch: fakeFetch });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이게 뭐야", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "a.png", size: 3 }] });
    await t.core.drain();
    // runTurn 에 이미지 전달
    expect(t.calls[0].images).toHaveLength(1);
    expect(t.calls[0].images[0].base64).toBe(Buffer.from("img").toString("base64"));
    // 저장은 마커
    const conv = await t.repos.conversations.getByChannelId("dm-owner");
    const recent = await t.repos.messages.recent(conv!.id, 5);
    expect(recent.some((m) => m.role === "user" && m.content.includes("[이미지 1장: a.png]"))).toBe(true);
  });

  it("이미지가 있으면 워커가 온라인이어도 위임하지 않고 봇이 직접 처리한다", async () => {
    // 주의(브리프 명시): jobs.isOnline 은 DB 서버 시계 기준이라 pg-mem 환경에서 heartbeat 직후
    // 온라인 판정이 확실히 성립하는지 보장되지 않는다(실 Postgres 확인 필요). 그래도 핵심 단언인
    // "위임 job 이 없다(claimNext null)" + "calls===1(봇이 직접 처리)"은 온라인 판정 여부와 무관하게
    // 이미지 턴이 위임 게이트(images.length===0 조건)에서 걸러졌음을 검증한다.
    const t = await setup({ imageFetch: fakeFetch });
    await t.repos.jobs.heartbeat("owner"); // 워커 온라인으로
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "봐줘", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "a.png", size: 3 }] });
    await t.core.drain();
    expect(t.calls).toHaveLength(1); // 위임(enqueue) 아니라 직접 runTurn
    const pending = await t.repos.jobs.claimNext("owner", 999999);
    expect(pending).toBeNull(); // 위임된 job 없음
  });
});
