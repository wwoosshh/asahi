import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMemoryDir, readMemoryIndex } from "../src/memory/memory.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-"));
}

describe("memory", () => {
  it("폴더와 MEMORY.md를 부트스트랩한다", () => {
    const dir = path.join(tmpDir(), "memory");
    ensureMemoryDir(dir);
    expect(fs.existsSync(path.join(dir, "MEMORY.md"))).toBe(true);
  });

  it("이미 있는 MEMORY.md는 덮어쓰지 않는다", () => {
    const dir = path.join(tmpDir(), "memory");
    ensureMemoryDir(dir);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# 내 기억\n- 중요한 것");
    ensureMemoryDir(dir);
    expect(readMemoryIndex(dir)).toContain("중요한 것");
  });
});
