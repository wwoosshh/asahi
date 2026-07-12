import path from "node:path";

// 경로 판정 순수 함수 — fs 접근 없이 문자열만으로 target 이 dir 안(같거나 하위)인지 판정한다.
// 심볼릭 링크 realpath 해석은 이 함수의 범위 밖이다(호출측이 fs 로 처리).
export function isPathWithin(target: string, dir: string): boolean {
  let d = path.resolve(dir);
  let t = path.resolve(target);
  // Windows 는 파일시스템이 대소문자를 구분하지 않는다 — 비교 시 대소문자를 무시한다.
  if (process.platform === "win32") {
    d = d.toLowerCase();
    t = t.toLowerCase();
  }
  if (d === t) return true;
  const rel = path.relative(d, t);
  // rel 이 ".." 로 시작하는지 여부는 정확히 ".."(부모 자신) 이거나 ".."+구분자 로 시작하는 경우만 확인한다.
  // 단순 rel.startsWith("..") 는 "..foobar" 같은(부모 탈출이 아닌) 이름을 오판할 수 있어 제외한다.
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

export function isPathWithinAny(target: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => isPathWithin(target, dir));
}

// 저장·비교 일관성을 위해 절대경로로 정규화한다.
export function normalizeDir(p: string): string {
  return path.resolve(p);
}
