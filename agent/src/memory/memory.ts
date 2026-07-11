import fs from "node:fs";
import path from "node:path";

const STARTER = `# 기억 인덱스

여기는 비서의 장기 기억 목차입니다. 기억 파일 하나를 만들 때마다 아래에 한 줄 요약을 추가하세요.

- (아직 기억 없음)
`;

export function ensureMemoryDir(memoryDir: string): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const indexPath = path.join(memoryDir, "MEMORY.md");
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, STARTER, "utf8");
  }
}

export function readMemoryIndex(memoryDir: string): string {
  ensureMemoryDir(memoryDir);
  return fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
}
