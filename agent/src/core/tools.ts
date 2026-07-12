import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo, Memory } from "../store/memoriesRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";

// 도구 서버 이름 → 모델에는 mcp__asahi__<tool> 로 노출된다.
export const TOOL_SERVER = "asahi";
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const t = (name: string): string => `mcp__${TOOL_SERVER}__${name}`;

// 현재 턴의 상대·대화 컨텍스트를 클로저로 받는다. 도구 handler 는 이걸로 스코프를 강제한다.
export type ToolCtx = {
  repos: { memories: MemoriesRepo; users: UsersRepo; allowedDirs: AllowedDirsRepo };
  role: Role;
  isPrivate: boolean;
  isOwner: boolean;
  userId: string;
  conversationId: number;
};

// ── 순수 핸들러(테스트 대상) ────────────────────────────────────────────────
export function rememberHandler(ctx: ToolCtx, args: { title: string; content: string }): string {
  // 항상 현재 상대(userId)·scope='user' 로만 저장한다. 손님은 shared 를 쓸 수 없다.
  ctx.repos.memories.insert({ userId: ctx.userId, scope: "user", title: args.title, content: args.content, sourceConversationId: ctx.conversationId });
  return `기억했어요: "${args.title}"`;
}

export function recallHandler(ctx: ToolCtx, args: { query: string }): string {
  // 프라이버시 스코프: 소유자 DM=전원, 손님 DM=본인+공용, 서버=공용만.
  let pool: Memory[];
  if (ctx.isOwner && ctx.isPrivate) pool = ctx.repos.memories.all();
  else if (ctx.isPrivate) pool = ctx.repos.memories.forUser(ctx.userId);
  else pool = ctx.repos.memories.sharedOnly();

  const q = (args.query ?? "").trim().toLowerCase();
  const hits = pool.filter((m) => q.length === 0 || `${m.title} ${m.content}`.toLowerCase().includes(q));
  if (hits.length === 0) return "관련 기억이 없어요.";
  return hits.map((m) => `- [${m.title}] ${m.content}`).join("\n");
}

export function manageAccessHandler(ctx: ToolCtx, args: { userId: string; role: Role }): string {
  // 소유자 DM(진짜 사설 1:1)에서만. 서버·손님 턴에서는 거부.
  if (!(ctx.isOwner && ctx.isPrivate)) return "이 작업은 소유자 DM에서만 할 수 있어요.";
  // 명시적 스노플레이크(디스코드 숫자 ID)만 허용 — 표시명·동명 오작동 방지.
  if (!/^\d{5,}$/.test(args.userId)) return "사용자의 디스코드 숫자 ID(@멘션)를 정확히 지정해 주세요.";
  // 'owner' 부여는 거부한다 — 소유자는 단일 신원(config)이며, 제2 소유자 생성은 신원 게이트를 우회시킨다.
  if (!["allowed", "blocked"].includes(args.role)) return "부여할 수 있는 역할은 allowed 또는 blocked 예요. (소유자는 바꿀 수 없어요)";
  ctx.repos.users.upsert(args.userId, { role: args.role });
  return `${args.userId} 님의 접근 권한을 '${args.role}'(으)로 설정했어요.`;
}

// 원격 개발 워크플로우(Phase A): 소유자 DM 전용 게이트 — 실제 경로 제한(canUseTool)은 별도 태스크(A3)의 몫이다.
const OWNER_DM_ONLY = "이 작업은 소유자 DM에서만 할 수 있어요.";

export function allowDirHandler(ctx: ToolCtx, args: { path: string }): string {
  if (!(ctx.isOwner && ctx.isPrivate)) return OWNER_DM_ONLY;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(args.path);
  } catch {
    return `경로를 찾을 수 없어요: ${args.path}`;
  }
  if (!stat.isDirectory()) return `디렉토리가 아니에요: ${args.path}`;
  // 보안리뷰 #4: 심볼릭 링크/정션으로 등록하면 canUseTool 의 realpath 후보와 어긋나 통째로 과차단되므로,
  // statSync 로 존재를 확인한 뒤 실경로로 저장한다(normalizeDir 자체는 순수 함수로 그대로 둔다).
  const real = fs.realpathSync(args.path);
  ctx.repos.allowedDirs.add(real);
  return `허용 폴더에 추가했어요: ${path.resolve(real)}`;
}

export function revokeDirHandler(ctx: ToolCtx, args: { path: string }): string {
  if (!(ctx.isOwner && ctx.isPrivate)) return OWNER_DM_ONLY;
  ctx.repos.allowedDirs.remove(args.path);
  return `허용 폴더에서 제거했어요: ${path.resolve(args.path)}`;
}

export function listDirsHandler(ctx: ToolCtx): string {
  if (!(ctx.isOwner && ctx.isPrivate)) return OWNER_DM_ONLY;
  const dirs = ctx.repos.allowedDirs.list();
  if (dirs.length === 0) return "허용된 폴더가 없어요.";
  return dirs.map((d) => `- ${d}`).join("\n");
}

// ── 턴별 도구셋(능력 계층, §7.1) ────────────────────────────────────────────
// owner-DM → 파일 도구 + Bash + 기억 + 접근관리 + 허용폴더 관리. 손님 DM → 기억(본인)만. 서버 → recall(공용)만.
export function allowedToolsFor(role: Role, isPrivate: boolean, isOwner: boolean): string[] {
  if (isOwner && isPrivate) {
    return [
      ...FILE_TOOLS, "Bash",
      t("remember"), t("recall"), t("manage_access"),
      t("allow_dir"), t("revoke_dir"), t("list_dirs"),
    ];
  }
  if (isPrivate && (role === "owner" || role === "allowed")) return [t("remember"), t("recall")];
  return [t("recall")];
}

// ── 인프로세스 MCP 서버(SDK) — handler 는 위 순수 함수를 감싼다 ──────────────
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function buildTools(ctx: ToolCtx) {
  return createSdkMcpServer({
    name: TOOL_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "remember",
        "사용자에 대해 오래 기억할 사실·선호·결정·진행 중인 일을 저장합니다. 사소한 것은 저장하지 마세요.",
        { title: z.string().describe("짧은 제목"), content: z.string().describe("기억할 내용") },
        async (args) => textResult(rememberHandler(ctx, args)),
      ),
      tool(
        "recall",
        "저장된 기억에서 관련 내용을 찾습니다.",
        { query: z.string().describe("찾을 키워드") },
        async (args) => textResult(recallHandler(ctx, args)),
      ),
      tool(
        "manage_access",
        "(소유자 전용) 사용자의 접근 권한을 설정합니다. 디스코드 숫자 ID 로만. owner 는 부여할 수 없습니다.",
        { userId: z.string().describe("디스코드 숫자 ID"), role: z.enum(["allowed", "blocked"]).describe("부여할 역할(allowed 또는 blocked)") },
        async (args) => textResult(manageAccessHandler(ctx, args)),
      ),
      tool(
        "allow_dir",
        "(소유자 전용) 원격 개발 작업을 허용할 폴더를 등록합니다. 실제 존재하는 디렉토리여야 합니다.",
        { path: z.string().describe("허용할 폴더의 절대경로") },
        async (args) => textResult(allowDirHandler(ctx, args)),
      ),
      tool(
        "revoke_dir",
        "(소유자 전용) 등록된 허용 폴더를 해제합니다.",
        { path: z.string().describe("해제할 폴더의 경로") },
        async (args) => textResult(revokeDirHandler(ctx, args)),
      ),
      tool(
        "list_dirs",
        "(소유자 전용) 현재 허용된 폴더 목록을 보여줍니다.",
        {},
        async () => textResult(listDirsHandler(ctx)),
      ),
    ],
  });
}
