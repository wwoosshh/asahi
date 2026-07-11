import { describe, it, expect } from "vitest";
import { progressFromMessage, shortToolName, summarizeToolInput, type ProgressUpdate } from "../src/core/agent.js";
import { formatProgress } from "../src/core/core.js";

describe("shortToolName — mcp__asahi__ 접두어 제거", () => {
  it("mcp__asahi__recall → recall", () => {
    expect(shortToolName("mcp__asahi__recall")).toBe("recall");
  });
  it("mcp__asahi__remember → remember", () => {
    expect(shortToolName("mcp__asahi__remember")).toBe("remember");
  });
  it("접두어 없는 파일 도구는 그대로", () => {
    expect(shortToolName("Read")).toBe("Read");
  });
});

describe("summarizeToolInput — 도구 입력 요약", () => {
  it("query 필드를 우선 뽑는다", () => {
    expect(summarizeToolInput({ query: "병원" })).toBe("병원");
  });
  it("title 필드도 뽑는다(remember)", () => {
    expect(summarizeToolInput({ title: "선호", content: "긴 내용..." })).toBe("선호");
  });
  it("문자열 입력은 그대로(트림)", () => {
    expect(summarizeToolInput("  hello  ")).toBe("hello");
  });
  it("알려진 필드가 없으면 undefined", () => {
    expect(summarizeToolInput({ foo: 1 })).toBeUndefined();
  });
  it("너무 길면 잘라낸다", () => {
    const long = "a".repeat(100);
    const out = summarizeToolInput({ query: long });
    expect(out!.length).toBeLessThan(long.length);
    expect(out).toContain("…");
  });
});

describe("progressFromMessage — SDK 메시지에서 진행 업데이트 추출(순수)", () => {
  it("assistant 의 tool_use 블록 → kind:'tool'", () => {
    const pending = new Map<string, string>();
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "mcp__asahi__recall", input: { query: "병원" } }] },
    };
    const updates = progressFromMessage(msg, pending);
    expect(updates).toEqual<ProgressUpdate[]>([{ kind: "tool", name: "recall", input: "병원" }]);
    expect(pending.get("t1")).toBe("recall");
  });

  it("assistant 의 text 블록 → kind:'answering'", () => {
    const pending = new Map<string, string>();
    const msg = { type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([{ kind: "answering" }]);
  });

  it("user 의 tool_result 블록 → kind:'tool_result', pending 에서 이름을 되찾는다", () => {
    const pending = new Map<string, string>([["t1", "recall"]]);
    const msg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "결과" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([{ kind: "tool_result", name: "recall" }]);
    expect(pending.has("t1")).toBe(false); // 소비 후 제거
  });

  it("pending 에 없는 tool_result 는 name 없이", () => {
    const pending = new Map<string, string>();
    const msg = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "결과" }] } };
    expect(progressFromMessage(msg, pending)).toEqual<ProgressUpdate[]>([{ kind: "tool_result", name: undefined }]);
  });

  it("system/result 타입 등 content 가 없는 메시지는 빈 배열", () => {
    const pending = new Map<string, string>();
    expect(progressFromMessage({ type: "system" }, pending)).toEqual([]);
    expect(progressFromMessage({ type: "result" }, pending)).toEqual([]);
  });

  it("문자열 content(예: user 메시지 replay)는 빈 배열", () => {
    const pending = new Map<string, string>();
    const msg = { type: "user", message: { content: "그냥 텍스트" } };
    expect(progressFromMessage(msg, pending)).toEqual([]);
  });
});

describe("formatProgress — 진행 업데이트를 사용자용 텍스트로", () => {
  it("tool + input → name(\"input\")", () => {
    expect(formatProgress({ kind: "tool", name: "recall", input: "병원" })).toBe('recall("병원")');
  });
  it("tool without input → name()", () => {
    expect(formatProgress({ kind: "tool", name: "Read" })).toBe("Read()");
  });
  it("tool_result with name", () => {
    expect(formatProgress({ kind: "tool_result", name: "recall" })).toContain("recall");
  });
  it("tool_result without name도 문구를 낸다", () => {
    expect(formatProgress({ kind: "tool_result" }).length).toBeGreaterThan(0);
  });
  it("answering → 답변 작성 중", () => {
    expect(formatProgress({ kind: "answering" })).toBe("답변 작성 중");
  });
});
