import { describe, it, expect } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { JobsRepo } from "../src/store/jobsRepo.js";
import { processJob, type ProcessJobDeps } from "../src/worker/jobRunner.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

const OWNER_ID = "owner-1";

async function setup() {
  const db = await openTestDb();
  const users = new UsersRepo(db);
  const conversations = new ConversationsRepo(db);
  const messages = new MessagesRepo(db);
  const summaries = new SummariesRepo(db);
  const memories = new MemoriesRepo(db);
  const jobs = new JobsRepo(db);
  await users.upsert(OWNER_ID, { role: "owner" });
  await users.upsert("guest-1", { role: "allowed" });

  const convId = await conversations.create({
    kind: "dm", discordChannelId: "dm-guest-1", primaryUserId: "guest-1", isPrivate: true, lastActiveTs: 1000,
  });

  const repos = { conversations, messages, summaries, memories, users, jobs };

  const calls: TurnRequest[] = [];
  let nextResult: TurnResult = { text: "완료했어요", sessionId: "s1", ok: true };
  let impl: ((req: TurnRequest) => Promise<TurnResult>) | undefined;
  const runTurn = (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    if (impl) return impl(req);
    return Promise.resolve(nextResult);
  };

  let clock = 5000;
  const deps: ProcessJobDeps = { repos, runTurn, agentCwd: "/data/agent-cwd", ownerId: OWNER_ID, now: () => clock };

  return {
    db, repos, convId, calls, deps,
    setResult: (r: TurnResult) => { nextResult = r; },
    setImpl: (fn: (req: TurnRequest) => Promise<TurnResult>) => { impl = fn; },
    setClock: (t: number) => { clock = t; },
  };
}

describe("processJob — 워커의 job 처리 핵심(순수 로직, runTurn 은 가짜)", () => {
  it("대화가 없으면 즉시 jobs.fail 로 기록한다", async () => {
    const t = await setup();
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: 999999, discordChannelId: "dm-guest-1", userMessage: "안녕", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await processJob(t.deps, job);
    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("찾을 수 없어요");
    expect(t.calls).toHaveLength(0);
  });

  it("새 세션(conv.sessionId 없음): 기억/요약/최근대화 컨텍스트를 프롬프트에 주입하고 성공 시 jobs.complete·assistant 메시지 저장·세션 기록", async () => {
    const t = await setup();
    await t.repos.memories.insert({ userId: "guest-1", scope: "user", title: "선호", content: "손님비밀ABC" });
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "파일 좀 봐줘", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;

    await processJob(t.deps, job);

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].prompt).toContain("손님비밀ABC");
    expect(t.calls[0].prompt).toContain("파일 좀 봐줘");
    expect(t.calls[0].resume).toBeUndefined();

    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("done");
    expect(after?.result).toBe("완료했어요");

    const conv = await t.repos.conversations.getById(t.convId);
    expect(conv?.sessionId).toBe("s1");

    const recent = await t.repos.messages.recent(t.convId, 10);
    expect(recent.some((m) => m.role === "assistant" && m.content === "완료했어요")).toBe(true);
  });

  it("열린 세션이 유휴 이내면 resume 만 하고(새 컨텍스트 블록 없이) 사용자 메시지 그대로 프롬프트로 쓴다", async () => {
    const t = await setup();
    await t.repos.conversations.setSession(t.convId, "existing-session", 4000);
    t.setClock(5000); // lastActiveTs=4000, idleMs 기본 30분 이내
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "이어서 계속", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;

    await processJob(t.deps, job);

    expect(t.calls[0].resume).toBe("existing-session");
    expect(t.calls[0].prompt).toBe("이어서 계속");
    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("done");
  });

  it("context.ownWorkstation=true, isPrivate=true 로 턴을 실행한다(자기 PC 전권)", async () => {
    const t = await setup();
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "hi", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await processJob(t.deps, job);
    expect(t.calls[0].context).toMatchObject({ ownWorkstation: true, isPrivate: true, isOwner: false, userId: "guest-1" });
    void id;
  });

  it("job.userId === ownerId 이면 context.isOwner=true", async () => {
    const t = await setup();
    const ownerConvId = await t.repos.conversations.create({ kind: "dm", discordChannelId: "dm-owner", primaryUserId: OWNER_ID, isPrivate: true, lastActiveTs: 1000 });
    await t.repos.jobs.enqueue({ userId: OWNER_ID, conversationId: ownerConvId, discordChannelId: "dm-owner", userMessage: "hi", ts: 100 });
    const job = (await t.repos.jobs.claimNext(OWNER_ID, 100))!;
    await processJob(t.deps, job);
    expect(t.calls[0].context.isOwner).toBe(true);
  });

  it("onProgress 는 jobs.setProgress 로 기록된다(formatProgress 그대로)", async () => {
    const t = await setup();
    t.setImpl(async (req) => {
      req.onProgress?.({ kind: "tool", name: "Read", input: "a.txt" });
      req.onProgress?.({ kind: "answering" });
      return { text: "완료", sessionId: "s2", ok: true };
    });
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "hi", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await processJob(t.deps, job);
    // setProgress 는 매 onProgress 마다 갱신하므로 최종 값은 마지막 호출(answering)의 문구다.
    const after = await t.repos.jobs.get(id);
    expect(after?.progress).toBe("답변 작성 중");
  });

  it("resume 세션을 SDK 가 못 찾으면(isSessionNotFound) 새 세션으로 재시도해 성공시킨다", async () => {
    const t = await setup();
    await t.repos.conversations.setSession(t.convId, "stale-session", 4000);
    t.setClock(5000);
    let calls = 0;
    t.setImpl(async (req) => {
      calls++;
      if (req.resume) {
        throw new Error("Claude Code returned an error result: No conversation found with session ID: stale-session");
      }
      return { text: "새 세션으로 완료", sessionId: "s3", ok: true };
    });
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "재시도해줘", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await processJob(t.deps, job);

    expect(calls).toBe(2);
    expect(t.calls[0].resume).toBe("stale-session");
    expect(t.calls[1].resume).toBeUndefined();
    expect(t.calls[1].prompt).toContain("재시도해줘");

    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("done");
    expect(after?.result).toBe("새 세션으로 완료");

    const conv = await t.repos.conversations.getById(t.convId);
    expect(conv?.sessionId).toBe("s3");
  });

  it("result.ok=false 면 jobs.fail(result.text) 로 기록한다", async () => {
    const t = await setup();
    t.setResult({ text: "(에이전트 오류: error)", ok: false });
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "hi", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await processJob(t.deps, job);
    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("(에이전트 오류: error)");
  });

  it("결과 텍스트가 빈 문자열이면 jobs.fail 로 기록한다(성공했지만 빈 응답)", async () => {
    const t = await setup();
    t.setResult({ text: "   ", ok: true, sessionId: "s1" });
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "hi", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await processJob(t.deps, job);
    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("failed");
  });

  it("runTurn 이 예기치 못한 예외를 던지면(세션 없음 폴백 대상이 아님) jobs.fail 로 기록하고 전파하지 않는다", async () => {
    const t = await setup();
    t.setImpl(async () => {
      throw new Error("예상 못한 오류");
    });
    const id = await t.repos.jobs.enqueue({ userId: "guest-1", conversationId: t.convId, discordChannelId: "dm-guest-1", userMessage: "hi", ts: 100 });
    const job = (await t.repos.jobs.claimNext("guest-1", 100))!;
    await expect(processJob(t.deps, job)).resolves.toBeUndefined();
    const after = await t.repos.jobs.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("예상 못한 오류");
  });
});

describe("processJob — 친근도(rapportStage) 주입", () => {
  it("소유자 PC작업 턴에 소유자 반말 관계 블록과 친근도 문구가 담긴다", async () => {
    const t = await setup();
    // 소유자 전용 DM 대화 생성
    const ownerConv = await t.repos.conversations.create({
      kind: "dm", discordChannelId: "dm-owner", primaryUserId: OWNER_ID, isPrivate: true, lastActiveTs: 1000,
    });
    // owner user 메시지 10개 심어 stage 1(익숙)로 만든다
    for (let i = 0; i < 10; i++) {
      await t.repos.messages.insert({ conversationId: ownerConv, ts: 10 + i, role: "user", userId: OWNER_ID, content: `m${i}` });
    }
    const id = await t.repos.jobs.enqueue({ userId: OWNER_ID, conversationId: ownerConv, discordChannelId: "dm-owner", userMessage: "파일 봐줘", ts: 100 });
    const job = (await t.repos.jobs.claimNext(OWNER_ID, 100))!;

    await processJob(t.deps, job);

    expect(t.calls[0].systemPrompt).toMatch(/반말/);
    expect(t.calls[0].systemPrompt).toMatch(/익숙/);
  });
});
