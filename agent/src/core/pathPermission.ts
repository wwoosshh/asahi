import fs from "node:fs";
import path from "node:path";
import { isPathWithinAny } from "./paths.js";

// 원격 개발 워크플로우(Phase A) 실제 집행: canUseTool 이 경로 판정을 걸어야 하는 도구 이름 목록.
// tools.ts 의 FILE_TOOLS(+Bash) 와 동일한 이름을 미러링한다 — 도구셋 정의(tools.ts)는 건드리지 않는다.
const PATH_GATED_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);

export function isPathGatedTool(toolName: string): boolean {
  return PATH_GATED_TOOLS.has(toolName);
}

export type PathPermissionResult = { behavior: "allow" } | { behavior: "deny"; message: string };

// 순수 판정 함수(테스트 대상) — fs 접근 없이 이미 resolve/realpath 된 경로들만 검사한다.
export function decidePathPermission(
  toolName: string,
  resolvedPaths: string[],
  opts: { isOwnerDm: boolean; allowedDirs: string[] },
): PathPermissionResult {
  if (!isPathGatedTool(toolName)) return { behavior: "allow" };
  if (!opts.isOwnerDm) return { behavior: "deny", message: "PC 작업은 소유자 DM에서만 가능해요." };
  if (opts.allowedDirs.length === 0) return { behavior: "deny", message: "먼저 allow_dir 로 작업할 폴더를 허용해 주세요." };
  for (const p of resolvedPaths) {
    if (!isPathWithinAny(p, opts.allowedDirs)) {
      return { behavior: "deny", message: `허용된 폴더 밖 경로예요: ${p}` };
    }
  }
  return { behavior: "allow" };
}

// canUseTool 의 (toolName, input, {blockedPath}) 에서 검사할 후보 경로들을 뽑는다.
// Read/Write/Edit → file_path. Glob/Grep → path(있을 때만). Bash → blockedPath(있을 때만).
// 그 외 도구는 항상 빈 배열(경로 검사 대상이 아님, isPathGatedTool 이 false 이므로 어차피 allow 로 통과한다).
export function extractCandidatePaths(toolName: string, input: Record<string, unknown>, blockedPath?: string): string[] {
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const fp = input.file_path;
    return typeof fp === "string" && fp.length > 0 ? [fp] : [];
  }
  if (toolName === "Glob" || toolName === "Grep") {
    const p = input.path;
    return typeof p === "string" && p.length > 0 ? [p] : [];
  }
  if (toolName === "Bash") {
    return blockedPath ? [blockedPath] : [];
  }
  return [];
}

// 심볼릭 링크로 허용 폴더를 우회하는 걸 막기 위해 실경로로 정규화한다.
// 존재하면 fs.realpathSync 그대로. 존재하지 않으면(예: 새로 만들 파일) 존재하는 가장 가까운
// 조상 디렉토리까지 올라가 그 조상만 realpath 하고, 나머지 경로 조각을 이어붙여 돌려준다.
// 그 어떤 조상도 존재하지 않으면(드라이브/루트까지 없음) 정규화된 원본 경로로 안전하게 대체한다.
export function resolveRealOrNearestAncestor(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // 존재하지 않음 — 조상을 찾아 올라간다.
  }
  const remaining: string[] = [path.basename(resolved)];
  let dir = path.dirname(resolved);
  while (true) {
    try {
      const realDir = fs.realpathSync(dir);
      return path.join(realDir, ...remaining.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return resolved; // 루트까지 존재하는 조상이 없음 — 정규화된 원본으로 대체
      remaining.push(path.basename(dir));
      dir = parent;
    }
  }
}
