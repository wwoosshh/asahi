import { describe, it, expect } from "vitest";
import { parseSessionCommand } from "../src/core/commands.js";

describe("parseSessionCommand", () => {
  it("예약어(/새세션·/새대화·/새로시작·/reset)를 reset 으로 인식한다(대소문자·앞뒤 공백 무시)", () => {
    for (const t of ["/새세션", " /새대화 ", "/새로시작", "/reset", "/RESET", "  /Reset"]) {
      expect(parseSessionCommand(t)).toBe("reset");
    }
  });

  it("슬래시가 없거나 정확히 일치하지 않는 텍스트는 null 이다(일반 대화 오작동 방지)", () => {
    for (const t of ["안녕", "새 세션 시작하자", "reset", "새세션", "/새세션 지금", "/새대화해줘", "/other", ""]) {
      expect(parseSessionCommand(t)).toBeNull();
    }
  });
});
