import { describe, it, expect } from "vitest";
import { EventBus, type AgentEvent, type ConversationHint } from "../src/events/bus.js";
import { openDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";
import { AgentCore } from "../src/core/core.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

const HOUR = 60 * 60 * 1000;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function setup(over: { config?: Partial<Config>; mode?: "immediate" | "manual" } = {}) {
  const db = openDb(":memory:");
  const repos = {
    users: new UsersRepo(db), conversations: new ConversationsRepo(db), participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db), summaries: new SummariesRepo(db), memories: new MemoriesRepo(db), turns: new TurnsRepo(db),
  };
  repos.users.upsert("owner", { role: "owner" });
  repos.users.upsert("guest", { role: "allowed" });
  repos.users.upsert("guest2", { role: "allowed" });
  const config: Config = {
    discordToken: "t", ownerId: "owner", dataDir: ":memory:", memoryDir: "x",
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, maxTurnsPerHourPerUser: 20, maxTurnsPerHourGlobal: 40, ownerReserve: 10,
    ...over.config,
  };
  let clock = 1_000_000;
  const calls: TurnRequest[] = [];
  let nextResult: TurnResult = { text: "답변", sessionId: "s1", ok: true };
  const resolvers: Array<() => void> = [];
  const mode = over.mode ?? "immediate";
  const runTurn = (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (mode === "immediate") return Promise.resolve(nextResult);
    return new Promise((res) => resolvers.push(() => res(nextResult)));
  };
  const bus = new EventBus();
  const core = new AgentCore({ bus, config, runTurn, now: () => clock, repos, agentCwd: "/data/agent" });
  core.start();
  const published: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => published.push(e));
  bus.subscribe("system_notice", (e) => published.push(e));
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
    const t = setup();
    t.repos.memories.insert({ userId: "owner", scope: "user", title: "개인", content: "소유자비밀ABC" });
    t.repos.memories.insert({ userId: "owner", scope: "shared", title: "공용", content: "공용정보XYZ" });
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
    const t = setup();
    t.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님비밀G" });
    t.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자비밀O" });
    pub(t.bus, dmHint("guest", "allowed"), "안녕", 1);
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("손님비밀G");
    expect(t.calls[0].prompt).not.toContain("소유자비밀O");
  });

  it("역할이 'owner'로 부여된 손님이라도 소유자 신원이 아니면 특권(isOwner)을 갖지 않는다(프라이버시 게이트 신원화)", async () => {
    const t = setup();
    t.repos.users.upsert("guest", { role: "owner" }); // 손님에게 owner 역할이 부여된 상황
    pub(t.bus, dmHint("guest", "owner"), "hi", 1);     // role=owner 로 들어오지만 userId≠ownerId
    await t.core.drain();
    expect(t.calls[0].context.isOwner).toBe(false);    // 신원(userId===ownerId)이 아니므로 전원열람·특권 없음
  });

  it("턴 컨텍스트로 role/isPrivate/isOwner 를 정확히 전달한다(도구 제한 근거)", async () => {
    const t = setup();
    pub(t.bus, threadHint("guest", "ch-1", "allowed", "g1"), "hi", 1);
    await t.core.drain();
    expect(t.calls[0].context).toMatchObject({ role: "allowed", isPrivate: false, isOwner: false, userId: "guest" });

    pub(t.bus, dmHint("owner", "owner"), "hi", 2);
    await t.core.drain();
    expect(t.calls[1].context).toMatchObject({ role: "owner", isPrivate: true, isOwner: true, userId: "owner" });
    expect(t.calls[1].cwd).toBe("/data/agent");
  });

  it("같은 대화는 직렬(재진입 금지)로 처리한다", async () => {
    const t = setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "A1", 1);
    pub(t.bus, dmHint("owner", "owner"), "A2", 2);
    await flush();
    expect(t.calls.length).toBe(1); // A2 는 A1 이 끝날 때까지 대기
    t.resolvers.shift()!();
    await flush();
    expect(t.calls.length).toBe(2);
  });

  it("다른 대화는 병렬로 동시에 진행한다", async () => {
    const t = setup({ mode: "manual" });
    pub(t.bus, dmHint("owner", "owner"), "A", 1);
    pub(t.bus, threadHint("owner", "ch-x", "owner", "ox"), "B", 2);
    await flush();
    expect(t.calls.length).toBe(2); // 서로 다른 대화 → 둘 다 시작
  });

  it("유저별 한도를 넘으면 LLM 을 호출하지 않고 안내한다", async () => {
    const t = setup({ config: { maxTurnsPerHourPerUser: 1 } });
    pub(t.bus, dmHint("guest", "allowed"), "1", 1);
    await t.core.drain();
    pub(t.bus, dmHint("guest", "allowed"), "2", 2);
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("한도");
  });

  it("소유자는 유저별·전역 한도를 전혀 받지 않는다(무제한)", async () => {
    const t = setup({ config: { maxTurnsPerHourPerUser: 1, maxTurnsPerHourGlobal: 1 } });
    for (let i = 0; i < 4; i++) {
      pub(t.bus, dmHint("owner", "owner"), `m${i}`, i + 1);
      await t.core.drain();
    }
    expect(t.calls.length).toBe(4); // 1/1 한도를 무시하고 4번 모두 처리
  });

  it("손님 전역 상한은 globalLimit 이며, 소유자 사용량은 손님 카운트에 영향을 주지 않는다", async () => {
    const t = setup({ config: { maxTurnsPerHourGlobal: 2, maxTurnsPerHourPerUser: 99 } });
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

  it("유휴 이내면 resume, 유휴가 지나면 새 세션으로 시작한다", async () => {
    const t = setup();
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
    const t = setup();
    pub(t.bus, dmHint("owner", "owner"), "A1", 1);
    await t.core.drain();
    pub(t.bus, threadHint("owner", "ch-b", "owner", "ob"), "B1", 2);
    await t.core.drain();
    expect(t.calls[1].resume).toBeUndefined(); // 새 대화 B → resume 없음
  });

  it("빈 응답이면 assistant 를 저장하지 않고 폴백 안내를 보낸다", async () => {
    const t = setup();
    t.setResult({ text: "   ", sessionId: "s1", ok: true });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    const conv = t.repos.conversations.getByChannelId("dm-owner")!;
    const roles = t.repos.messages.recent(conv.id, 10).map((m) => m.role);
    expect(roles).not.toContain("assistant");
    expect(t.published.find((e) => e.type === "system_notice")).toBeDefined();
  });

  it("턴이 실패하면 오류를 안내한다", async () => {
    const t = setup();
    t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
    pub(t.bus, dmHint("owner", "owner"), "안녕", 1);
    await t.core.drain();
    expect(t.published.find((e) => e.type === "system_notice")?.text).toContain("오류");
  });

  it("부팅 시 미처리 메시지를 그 대화 문맥으로 재개한다", async () => {
    const t = setup();
    const convId = t.repos.conversations.create({ kind: "dm", discordChannelId: "dm-owner", primaryUserId: "owner", isPrivate: true, lastActiveTs: 1 });
    t.repos.messages.insert({ conversationId: convId, ts: 1, role: "user", userId: "owner", content: "크래시전메시지", processed: false });
    await t.core.recoverPending();
    await t.core.drain();
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].prompt).toContain("크래시전메시지");
    expect(t.repos.messages.unprocessedUserMessages().length).toBe(0);
  });

  it("유휴 대화를 요약하고 세션을 닫는다", async () => {
    const t = setup();
    pub(t.bus, dmHint("owner", "owner"), "기억해줘", t.now());
    await t.core.drain();
    const conv = t.repos.conversations.getByChannelId("dm-owner")!;
    expect(conv.sessionId).toBe("s1");
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "인사를 나눴다.", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(t.repos.summaries.recent(conv.id, 1)).toEqual(["인사를 나눴다."]);
    expect(t.repos.conversations.getById(conv.id)!.sessionId).toBeNull();
  });

  it("요약의 from_message_id 를 세션 첫 메시지로 기록한다(0 이 아님)", async () => {
    const t = setup();
    pub(t.bus, dmHint("owner", "owner"), "첫 메시지", t.now());
    await t.core.drain();
    const conv = t.repos.conversations.getByChannelId("dm-owner")!;
    const firstUserMsg = t.repos.messages.recent(conv.id, 10).find((m) => m.role === "user")!;
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    const row = t.db.prepare("SELECT from_message_id FROM conversation_summaries WHERE conversation_id = ?").get(conv.id) as { from_message_id: number };
    expect(row.from_message_id).toBe(firstUserMsg.id);
    expect(row.from_message_id).not.toBe(0);
  });

  it("유휴 정리로 닫힌 대화가 재활성되면 다음 유휴 사이클에 다시 요약된다(status 고착 방지)", async () => {
    const t = setup();
    pub(t.bus, dmHint("owner", "owner"), "1", t.now());
    await t.core.drain();
    const conv = t.repos.conversations.getByChannelId("dm-owner")!;

    // 1차 유휴 정리 → 세션 닫힘
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "요약1", sessionId: "s1", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(t.repos.conversations.getById(conv.id)!.sessionId).toBeNull();

    // 재활성: 새 메시지 → 새 세션 s2
    t.setResult({ text: "답", sessionId: "s2", ok: true });
    pub(t.bus, dmHint("owner", "owner"), "2", t.now());
    await t.core.drain();
    expect(t.repos.conversations.getById(conv.id)!.sessionId).toBe("s2");

    // 2차 유휴 → 다시 요약·종료되어야 한다(버그면 status='idle' 고착으로 스윕에서 누락)
    t.setClock(t.now() + 31 * 60 * 1000);
    t.setResult({ text: "요약2", sessionId: "s2", ok: true });
    await t.core.closeIdleConversations();
    await t.core.drain();
    expect(t.repos.summaries.recent(conv.id, 1)).toEqual(["요약2"]);
    expect(t.repos.conversations.getById(conv.id)!.sessionId).toBeNull();
  });
});
