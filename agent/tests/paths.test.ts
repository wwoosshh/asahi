import { describe, it, expect } from "vitest";
import path from "node:path";
import { isPathWithin, isPathWithinAny, normalizeDir } from "../src/core/paths.js";

describe("isPathWithin", () => {
  it("같은 경로면 true", () => {
    expect(isPathWithin("C:\\a\\b", "C:\\a\\b")).toBe(true);
  });

  it("하위 경로면 true", () => {
    expect(isPathWithin("C:\\a\\b\\c\\d.txt", "C:\\a\\b")).toBe(true);
  });

  it("접두사만 같은 형제 폴더는 false (C:\\a\\bc 는 C:\\a\\b 밖)", () => {
    expect(isPathWithin("C:\\a\\bc", "C:\\a\\b")).toBe(false);
    expect(isPathWithin("C:\\a\\bc\\d.txt", "C:\\a\\b")).toBe(false);
  });

  it("..으로 상위 탈출하면 false", () => {
    expect(isPathWithin("C:\\a\\b\\..\\..\\escape", "C:\\a\\b")).toBe(false);
    expect(isPathWithin("C:\\a\\b\\..", "C:\\a\\b")).toBe(false); // dir 자체의 부모
  });

  it("target 이 절대경로로 dir 밖을 가리키면 false", () => {
    expect(isPathWithin("C:\\other\\place", "C:\\a\\b")).toBe(false);
    expect(isPathWithin("D:\\a\\b\\c", "C:\\a\\b")).toBe(false); // 드라이브 다름
  });

  it("후행 슬래시가 있어도 정상 판정", () => {
    expect(isPathWithin("C:\\a\\b\\c", "C:\\a\\b\\")).toBe(true);
    expect(isPathWithin("C:\\a\\b\\", "C:\\a\\b")).toBe(true);
  });

  it("Windows 대소문자를 무시하고 비교한다", () => {
    expect(isPathWithin("c:\\A\\B\\c.txt", "C:\\a\\b")).toBe(true);
    expect(isPathWithin("C:\\A\\B", "c:\\a\\b")).toBe(true);
  });

  it("'..'로 시작하지만 실제로는 하위인 이름은 true (예: ..foobar 폴더)", () => {
    expect(isPathWithin("C:\\a\\b\\..foobar\\file.txt", "C:\\a\\b")).toBe(true);
  });

  it("dir 과 무관한 완전히 다른 경로는 false", () => {
    expect(isPathWithin("C:\\x\\y", "C:\\a\\b")).toBe(false);
  });
});

describe("isPathWithinAny", () => {
  it("빈 배열이면 false", () => {
    expect(isPathWithinAny("C:\\a\\b\\c", [])).toBe(false);
  });

  it("여러 dir 중 하나라도 within 이면 true", () => {
    const dirs = ["C:\\x\\y", "C:\\a\\b", "C:\\z"];
    expect(isPathWithinAny("C:\\a\\b\\c.txt", dirs)).toBe(true);
  });

  it("어느 dir 에도 속하지 않으면 false", () => {
    const dirs = ["C:\\x\\y", "C:\\z"];
    expect(isPathWithinAny("C:\\a\\b\\c.txt", dirs)).toBe(false);
  });
});

describe("normalizeDir", () => {
  it("절대경로로 정규화한다(후행 슬래시 제거)", () => {
    expect(normalizeDir("C:\\a\\b\\")).toBe(path.resolve("C:\\a\\b"));
    expect(normalizeDir("C:\\a\\b")).toBe(path.resolve("C:\\a\\b"));
  });

  it("상대경로도 절대경로로 변환한다", () => {
    expect(normalizeDir("some\\relative\\dir")).toBe(path.resolve("some\\relative\\dir"));
  });
});
