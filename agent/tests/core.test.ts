import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus, type AgentEvent } from "../src/events/bus.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { ensureMemoryDir } from "../src/memory/memory.js";
import { AgentCore } from "../src/core/core.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

function setup(overrides: Partial<Config> = {}) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-"));
  ensureMemoryDir(memoryDir);
  const config: Config = {
    discordToken: "t", ownerId: "o", dataDir: ":memory:", memoryDir,
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, ...overrides,
  };
  const bus = new EventBus();
  const repo = new Repo(openDb(":memory:"));
  const calls: TurnRequest[] = [];
  let nextResult: TurnResult = { text: "안녕하세요!", sessionId: "s1", ok: true };
  const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return nextResult;
  };
  let clock = 1_000_000;
  const core = new AgentCore({ bus, repo, config, runTurn, now: () => clock });
  core.start();
  const published: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => { published.push(e); });
  bus.subscribe("system_notice", (e) => { published.push(e); });
  return {
    bus, repo, core, calls, published, memoryDir,
    setClock: (t: number) => { clock = t; },
    setResult: (r: TurnResult) => { nextResult = r; },
  };
}

function userMsg(text: string, ts: number): AgentEvent {
  return { type: "user_message", channel: "discord", channelRef: "c1", text, ts };
}

describe("AgentCore", () => {
  it("메시지를 받으면 턴을 실행하고 응답을 발행·기록한다", async () => {
    const t = setup();
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].prompt).toContain("안녕");
    expect(t.published[0]).toMatchObject({ type: "assistant_message", channelRef: "c1", text: "안녕하세요!" });
    const types = t.repo.recentEvents(10).map((e) => e.type);
    expect(types).toEqual(["user_message", "assistant_message"]);
  });

  it("유휴 시간 이내의 두 번째 메시지는 resume으로 이어간다", async () => {
    const t = setup();
    t.bus.publish(userMsg("첫번째", 1));
    await t.core.drain();
    t.bus.publish(userMsg("두번째", 2));
    await t.core.drain();
    expect(t.calls[0].resume).toBeUndefined();
    expect(t.calls[1].resume).toBe("s1");
  });

  it("새 세션 시작 시 기억 컨텍스트를 주입한다", async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.memoryDir, "MEMORY.md"), "# 기억 인덱스\n- 사용자는 고양이를 키운다");
    t.repo.insertSummary({ createdTs: 1, fromEventId: 1, toEventId: 2, content: "지난번엔 여행 얘기를 했다" });
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("기억 컨텍스트");
    expect(t.calls[0].prompt).toContain("고양이를 키운다");
    expect(t.calls[0].prompt).toContain("여행 얘기");
  });

  it("유휴 시간이 지나면 resume 없이 새 세션으로 시작한다", async () => {
    const t = setup({ sessionIdleMinutes: 30 });
    t.bus.publish(userMsg("첫번째", 1));
    await t.core.drain();
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.bus.publish(userMsg("한참 뒤", 2));
    await t.core.drain();
    expect(t.calls[1].resume).toBeUndefined();
    expect(t.calls[1].prompt).toContain("기억 컨텍스트");
  });

  it("시간당 한도를 넘으면 LLM을 호출하지 않고 알린다", async () => {
    const t = setup({ maxTurnsPerHour: 1 });
    t.bus.publish(userMsg("1", 1));
    await t.core.drain();
    t.bus.publish(userMsg("2", 2));
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice?.text).toContain("한도");
  });

  it("턴 실패 시 오류를 알린다", async () => {
    const t = setup();
    t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice?.text).toContain("오류");
  });

  it("유휴 세션을 요약하고 종료한다", async () => {
    const t = setup({ sessionIdleMinutes: 30 });
    t.bus.publish(userMsg("기억해줘", 1));
    await t.core.drain();
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "사용자와 인사를 나눴다.", sessionId: "s1", ok: true });
    await t.core.closeIdleSessionIfNeeded();
    expect(t.calls).toHaveLength(2);            // 대화 턴 + 요약 턴
    expect(t.calls[1].resume).toBe("s1");       // 요약은 기존 세션에서
    expect(t.repo.recentSummaries(1)).toEqual(["사용자와 인사를 나눴다."]);
    // 세션이 지워졌으니 다음 메시지는 새 세션
    t.bus.publish(userMsg("다시 안녕", 3));
    await t.core.drain();
    expect(t.calls[2].resume).toBeUndefined();
  });

  it("부팅 시 미처리 메시지를 재개해 처리한다", async () => {
    const t = setup();
    t.repo.insertEvent({ ts: 1, type: "user_message", channel: "discord", channelRef: "c1", content: "크래시 전 메시지", processed: false });
    await t.core.recoverPending();
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].prompt).toContain("크래시 전 메시지");
    expect(t.repo.unprocessedUserMessages()).toHaveLength(0);
  });

  it("정상 처리된 메시지는 완료 표시된다", async () => {
    const t = setup();
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    expect(t.repo.unprocessedUserMessages()).toHaveLength(0);
  });
});
