#!/usr/bin/env node
// 문서 가드: (1) 살아있는 문서 금칙어 회귀, (2) 아카이브 front-matter status, (3) 내부 상대링크 존재.
import fs from "node:fs";
import path from "node:path";

const errors = [];

// (1) 회귀 가드: 살아있는 문서에 better-sqlite3 / agent.db 가 등장하면 실패.
const livingDocs = ["README.md", ".env.example"];
for (const d of fs.readdirSync("deploy")) if (d.endsWith(".md")) livingDocs.push(path.join("deploy", d));
const banned = /better-sqlite3|agent\.db/i;
for (const f of livingDocs) {
  if (!fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    if (banned.test(line)) errors.push(`[회귀] ${f}:${i + 1} 금칙어(better-sqlite3/agent.db): ${line.trim()}`);
  });
}

// (2) 아카이브 front-matter status 존재.
const archive = "docs/design-archive";
if (fs.existsSync(archive)) {
  for (const sub of ["specs", "plans", "notes"]) {
    const dir = path.join(archive, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 400);
      if (!/^---[\s\S]*?\bstatus:\s*(Shipped|Superseded|Accepted|Draft|Approved)/m.test(head))
        errors.push(`[front-matter] ${sub}/${f}: status 없음`);
    }
  }
}

// (3) 내부 상대 마크다운 링크 존재. (design-archive는 과거 시점 기록이라 링크 검사 제외)
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (path.normalize(p) === path.normalize(archive)) continue;
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
const linkRe = /\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g;
for (const f of walk("docs").concat(["README.md", "CONTRIBUTING.md", "SECURITY.md"].filter(fs.existsSync))) {
  const text = fs.readFileSync(f, "utf8");
  let m;
  while ((m = linkRe.exec(text))) {
    const target = m[1].trim();
    if (/^(https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(f), target);
    if (!fs.existsSync(resolved)) errors.push(`[링크] ${f}: 깨진 링크 -> ${target}`);
  }
}

if (errors.length) {
  console.error("문서 검사 실패:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("문서 검사 통과");
