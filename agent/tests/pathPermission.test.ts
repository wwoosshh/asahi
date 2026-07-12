import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decidePathPermission, isPathGatedTool, extractCandidatePaths, resolveRealOrNearestAncestor,
} from "../src/core/pathPermission.js";

describe("isPathGatedTool — 경로 집행 대상 판정", () => {
  it("파일계열·Bash 는 대상이다", () => {
    expect(isPathGatedTool("Read")).toBe(true);
    expect(isPathGatedTool("Write")).toBe(true);
    expect(isPathGatedTool("Edit")).toBe(true);
    expect(isPathGatedTool("Glob")).toBe(true);
    expect(isPathGatedTool("Grep")).toBe(true);
    expect(isPathGatedTool("Bash")).toBe(true);
  });

  it("mcp 도구·기타 도구는 대상이 아니다", () => {
    expect(isPathGatedTool("mcp__asahi__remember")).toBe(false);
    expect(isPathGatedTool("mcp__asahi__recall")).toBe(false);
    expect(isPathGatedTool("WebSearch")).toBe(false);
    expect(isPathGatedTool("Task")).toBe(false);
  });
});

describe("decidePathPermission — 순수 판정 함수", () => {
  it("파일도구·허용폴더 내부 경로면 allow", () => {
    const result = decidePathPermission("Read", ["C:\\proj\\a\\file.txt"], {
      isOwnerDm: true,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result).toEqual({ behavior: "allow" });
  });

  it("파일도구·허용폴더 밖 경로면 deny(경로를 메시지에 포함)", () => {
    const result = decidePathPermission("Write", ["C:\\other\\file.txt"], {
      isOwnerDm: true,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("C:\\other\\file.txt");
  });

  it("여러 경로 중 하나라도 밖이면 deny", () => {
    const result = decidePathPermission("Edit", ["C:\\proj\\a\\ok.txt", "C:\\proj\\b\\bad.txt"], {
      isOwnerDm: true,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result.behavior).toBe("deny");
  });

  it("허용폴더가 비어있으면(파일도구) deny", () => {
    const result = decidePathPermission("Read", ["C:\\proj\\a\\file.txt"], {
      isOwnerDm: true,
      allowedDirs: [],
    });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("allow_dir");
  });

  it("손님 DM(isOwnerDm=false) 이면 허용폴더·경로 상관없이 deny", () => {
    const result = decidePathPermission("Read", ["C:\\proj\\a\\file.txt"], {
      isOwnerDm: false,
      allowedDirs: ["C:\\proj\\a"],
    });
    expect(result.behavior).toBe("deny");
    expect((result as { message: string }).message).toContain("소유자 DM");
  });

  it("비파일·비Bash 도구(mcp__asahi__remember 등)는 항상 allow", () => {
    expect(decidePathPermission("mcp__asahi__remember", [], { isOwnerDm: false, allowedDirs: [] }))
      .toEqual({ behavior: "allow" });
    expect(decidePathPermission("WebSearch", ["C:\\anything"], { isOwnerDm: true, allowedDirs: [] }))
      .toEqual({ behavior: "allow" });
  });

  describe("Bash", () => {
    it("소유자 DM·허용폴더 있음·경로가 허용폴더 내부면 allow", () => {
      const result = decidePathPermission("Bash", ["C:\\proj\\a\\sub"], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
      });
      expect(result).toEqual({ behavior: "allow" });
    });

    it("경로 없이(빈 배열) 소유자 DM·허용폴더 있음이면 allow(cwd 내부로 간주)", () => {
      const result = decidePathPermission("Bash", [], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
      });
      expect(result).toEqual({ behavior: "allow" });
    });

    it("blockedPath 가 허용폴더 밖이면 deny", () => {
      const result = decidePathPermission("Bash", ["C:\\other"], {
        isOwnerDm: true,
        allowedDirs: ["C:\\proj\\a"],
      });
      expect(result.behavior).toBe("deny");
    });

    it("허용폴더가 비어있으면 경로 유무와 상관없이 deny", () => {
      expect(decidePathPermission("Bash", [], { isOwnerDm: true, allowedDirs: [] }).behavior).toBe("deny");
      expect(decidePathPermission("Bash", ["C:\\proj\\a"], { isOwnerDm: true, allowedDirs: [] }).behavior).toBe("deny");
    });

    it("소유자 DM 이 아니면 경로 유무와 상관없이 deny", () => {
      expect(decidePathPermission("Bash", [], { isOwnerDm: false, allowedDirs: ["C:\\proj\\a"] }).behavior).toBe("deny");
    });
  });
});

describe("extractCandidatePaths — canUseTool 입력에서 경로 추출", () => {
  it("Read/Write/Edit 는 file_path 를 뽑는다", () => {
    expect(extractCandidatePaths("Read", { file_path: "C:\\a\\b.txt" })).toEqual(["C:\\a\\b.txt"]);
    expect(extractCandidatePaths("Write", { file_path: "C:\\a\\b.txt", content: "x" })).toEqual(["C:\\a\\b.txt"]);
    expect(extractCandidatePaths("Edit", { file_path: "C:\\a\\b.txt" })).toEqual(["C:\\a\\b.txt"]);
  });

  it("Glob/Grep 는 path 가 있으면 뽑고 없으면 빈 배열", () => {
    expect(extractCandidatePaths("Glob", { pattern: "*.ts", path: "C:\\a" })).toEqual(["C:\\a"]);
    expect(extractCandidatePaths("Grep", { pattern: "foo" })).toEqual([]);
  });

  it("Bash 는 blockedPath 가 있으면 뽑고 없으면 빈 배열", () => {
    expect(extractCandidatePaths("Bash", { command: "ls" }, "C:\\a")).toEqual(["C:\\a"]);
    expect(extractCandidatePaths("Bash", { command: "ls" })).toEqual([]);
  });

  it("그 외 도구는 항상 빈 배열", () => {
    expect(extractCandidatePaths("mcp__asahi__remember", { title: "t", content: "c" })).toEqual([]);
  });
});

describe("resolveRealOrNearestAncestor — 심볼릭 링크 우회 방지용 realpath 정규화", () => {
  let tmp: string;

  it("존재하는 경로는 realpathSync 그대로 반환한다", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realpath-"));
    const real = resolveRealOrNearestAncestor(tmp);
    expect(real).toBe(fs.realpathSync(tmp));
  });

  it("존재하지 않는 파일 경로는 가장 가까운 조상을 realpath 하고 나머지를 이어붙인다", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realpath-"));
    const target = path.join(tmp, "new-file.txt");
    const result = resolveRealOrNearestAncestor(target);
    expect(result).toBe(path.join(fs.realpathSync(tmp), "new-file.txt"));
  });

  it("존재하지 않는 중첩 디렉토리도 존재하는 조상까지 올라가 realpath 한다", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realpath-"));
    const target = path.join(tmp, "sub", "deeper", "new-file.txt");
    const result = resolveRealOrNearestAncestor(target);
    expect(result).toBe(path.join(fs.realpathSync(tmp), "sub", "deeper", "new-file.txt"));
  });
});
