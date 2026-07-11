import { describe, it, expect } from "vitest";
import {
  decideProgressEditThrottle,
  formatProgressMessage,
  PROGRESS_EDIT_MIN_INTERVAL_MS,
} from "../src/adapters/discord.js";

describe("decideProgressEditThrottle", () => {
  it("이전 편집 기록이 없으면 즉시 편집", () => {
    expect(decideProgressEditThrottle(null, 1_000)).toEqual({ action: "now" });
  });

  it("최소 간격 이상 지났으면 즉시 편집", () => {
    const last = 1_000;
    const now = last + PROGRESS_EDIT_MIN_INTERVAL_MS;
    expect(decideProgressEditThrottle(last, now)).toEqual({ action: "now" });
  });

  it("최소 간격보다 더 지났어도 즉시 편집", () => {
    const last = 1_000;
    const now = last + PROGRESS_EDIT_MIN_INTERVAL_MS + 500;
    expect(decideProgressEditThrottle(last, now)).toEqual({ action: "now" });
  });

  it("최소 간격 이내면 남은 시간만큼 지연", () => {
    const last = 1_000;
    const now = last + 300;
    expect(decideProgressEditThrottle(last, now)).toEqual({
      action: "later",
      delayMs: PROGRESS_EDIT_MIN_INTERVAL_MS - 300,
    });
  });

  it("커스텀 최소 간격을 지정할 수 있다", () => {
    expect(decideProgressEditThrottle(1_000, 1_100, 500)).toEqual({
      action: "later",
      delayMs: 400,
    });
    expect(decideProgressEditThrottle(1_000, 1_600, 500)).toEqual({ action: "now" });
  });

  it("경과 시간이 0이어도(동시 호출) 지연으로 처리", () => {
    expect(decideProgressEditThrottle(1_000, 1_000)).toEqual({
      action: "later",
      delayMs: PROGRESS_EDIT_MIN_INTERVAL_MS,
    });
  });
});

describe("formatProgressMessage", () => {
  it("빈 배열이면 헤더만", () => {
    expect(formatProgressMessage([])).toBe("처리 중");
  });

  it("진행 라인들을 불릿으로 누적한다", () => {
    expect(formatProgressMessage(['recall("병원")', "recall 완료", "답변 작성 중"])).toBe(
      "처리 중\n· recall(\"병원\")\n· recall 완료\n· 답변 작성 중",
    );
  });

  it("라인이 하나면 불릿 하나", () => {
    expect(formatProgressMessage(["답변 작성 중"])).toBe("처리 중\n· 답변 작성 중");
  });
});
