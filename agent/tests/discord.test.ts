import { describe, it, expect } from "vitest";
import { chunkMessage } from "../src/adapters/discord.js";

describe("chunkMessage", () => {
  it("2000자 이하면 그대로 한 조각", () => {
    expect(chunkMessage("짧은 메시지")).toEqual(["짧은 메시지"]);
  });

  it("길면 최대 길이 이하 조각들로 나눈다", () => {
    const text = "가".repeat(4500);
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("줄바꿈 경계를 우선해서 자른다", () => {
    const line = "한 줄입니다.\n"; // 8자
    const text = line.repeat(400); // 3200자 (2000 초과 → 분할 발생)
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].endsWith("한 줄입니다.")).toBe(true);
  });

  it("빈 문자열은 빈 배열", () => {
    expect(chunkMessage("")).toEqual([]);
  });
});
