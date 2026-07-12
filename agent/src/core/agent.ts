import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { AllowedDirsRepo } from "../store/allowedDirsRepo.js";
import { buildTools, allowedToolsFor, TOOL_SERVER, type ToolCtx } from "./tools.js";
import { decidePathPermission, isPathGatedTool, extractCandidatePaths, resolveRealOrNearestAncestor } from "./pathPermission.js";

// 현재 턴의 상대·대화 컨텍스트. 이걸로 role·is_private 별 도구셋(allowedTools)을 정한다(§7.1).
export type TurnContext = { role: Role; isPrivate: boolean; isOwner: boolean; userId: string; conversationId: number };
// 턴 처리 중 진행 상황(판별 유니온). 표시용 텍스트로 바꾸는 건 core.ts 의 formatProgress 가 맡는다.
export type ProgressUpdate =
  | { kind: "tool"; name: string; input?: string }
  | { kind: "tool_result"; name?: string }
  | { kind: "answering" };
export type TurnRequest = { prompt: string; systemPrompt: string; resume?: string; cwd: string; context: TurnContext; onProgress?: (u: ProgressUpdate) => void };
export type TurnResult = { text: string; sessionId?: string; ok: boolean };
export type TurnRunner = (req: TurnRequest) => Promise<TurnResult>;

export type ToolRepos = { memories: MemoriesRepo; users: UsersRepo; allowedDirs: AllowedDirsRepo };

// mcp__asahi__recall → recall 처럼 인프로세스 MCP 접두어를 벗겨 짧게 만든다. 접두어가 없으면 그대로.
export function shortToolName(name: string): string {
  const parts = name.split("__");
  return name.startsWith("mcp__") && parts.length >= 3 ? parts.slice(2).join("__") : name;
}

function truncate(s: string, max = 40): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// 도구 입력 객체에서 사람이 읽을 만한 짧은 요약 하나를 뽑는다(대표 키 우선순위). 없으면 undefined.
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim().length > 0 ? truncate(input) : undefined;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["query", "title", "content", "path", "file_path", "pattern", "command", "description"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) return truncate(v);
    }
  }
  return undefined;
}

// query() 스트림 메시지 하나에서 진행 업데이트들을 뽑는 순수 함수. assistant 의 tool_use → 'tool',
// 그 뒤 user 의 tool_result → 'tool_result'(이름은 pendingToolNames 로 되찾음), text 블록 → 'answering'.
// pendingToolNames 는 호출자가 턴 하나 동안 유지하는 tool_use_id → 짧은 도구명 맵(이 함수가 채우고 소비한다).
type ProgressSourceMessage = { type: string; message?: unknown };
export function progressFromMessage(message: ProgressSourceMessage, pendingToolNames: Map<string, string>): ProgressUpdate[] {
  const inner = message.message;
  const content = inner && typeof inner === "object" ? (inner as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  const updates: ProgressUpdate[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as { type?: unknown; name?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown };
    if (block.type === "tool_use" && typeof block.name === "string") {
      const name = shortToolName(block.name);
      if (typeof block.id === "string") pendingToolNames.set(block.id, name);
      updates.push({ kind: "tool", name, input: summarizeToolInput(block.input) });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const name = pendingToolNames.get(block.tool_use_id);
      pendingToolNames.delete(block.tool_use_id);
      updates.push({ kind: "tool_result", name });
    } else if (block.type === "text") {
      updates.push({ kind: "answering" });
    }
  }
  return updates;
}

// 도구 리포를 클로저로 받아 실제 SDK 턴 러너를 만든다. 매 턴 컨텍스트로
// 인프로세스 도구(remember/recall/manage_access)와 allowedTools 를 구성한다.
export function makeRunAgentTurn(repos: ToolRepos): TurnRunner {
  return async (req) => {
    const ctx: ToolCtx = {
      repos, role: req.context.role, isPrivate: req.context.isPrivate,
      isOwner: req.context.isOwner, userId: req.context.userId, conversationId: req.context.conversationId,
    };
    const server = buildTools(ctx);
    const allowedTools = allowedToolsFor(req.context.role, req.context.isPrivate, req.context.isOwner);
    // 파일/Bash 는 canUseTool(decidePathPermission) 을 반드시 거치도록 bare 사전승인 목록에서 뺀다 —
    // SDK 는 allowedTools 에 괄호 없는 "이름 그대로" 항목이 있으면 canUseTool 을 아예 호출하지 않고
    // 통과시켜 버린다(경로 검사가 완전히 우회됨). mcp__asahi__* 도구는 그대로 bare 사전승인 유지.
    const preApprovedTools = allowedTools.filter((name) => !isPathGatedTool(name));
    // 이 턴에서 실제로 쓸 수 있는 내장 도구(Read/Write/Edit/Glob/Grep/Bash) 기본 집합을 role 별로 제한한다.
    // (query() 의 canUseTool 은 파일/Bash 가 아닌 도구는 항상 allow 하므로, 이 제한이 없으면 permissionMode
    // 를 "default" 로 바꾼 뒤 WebSearch/Task 등 기존에 쓸 수 없던 내장 도구까지 새로 열리게 된다.)
    const builtinTools = allowedTools.filter(isPathGatedTool);
    const isOwnerDm = req.context.isOwner && req.context.isPrivate;

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const allowedDirs = repos.allowedDirs.list();
      const rawPaths = extractCandidatePaths(toolName, input, options.blockedPath, req.cwd);
      const resolvedPaths = rawPaths.map(resolveRealOrNearestAncestor);
      // 보안리뷰 #2: dangerouslyDisableSandbox 로 남은 봉쇄까지 무력화하는 걸 canUseTool 이 항상 막는다.
      const dangerouslyDisableSandbox = toolName === "Bash" && input.dangerouslyDisableSandbox === true;
      const decision = decidePathPermission(toolName, resolvedPaths, { isOwnerDm, allowedDirs, dangerouslyDisableSandbox });
      return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message };
    };

    let sessionId: string | undefined;
    let text = "";
    let ok = false;
    // 턴 하나 동안 tool_use_id → 짧은 도구명(진행 이벤트용). onProgress 가 없으면 추출도 하지 않는다.
    const pendingToolNames = new Map<string, string>();

    for await (const message of query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        systemPrompt: req.systemPrompt,
        resume: req.resume,
        allowedTools: preApprovedTools,
        tools: builtinTools,
        mcpServers: { [TOOL_SERVER]: server },
        permissionMode: "default",
        canUseTool,
        additionalDirectories: isOwnerDm ? repos.allowedDirs.list() : [],
        maxTurns: 30,
      },
    })) {
      if (req.onProgress) {
        for (const update of progressFromMessage(message, pendingToolNames)) {
          req.onProgress(update);
        }
      }
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "result") {
        sessionId = message.session_id ?? sessionId;
        if (message.subtype === "success") {
          text = message.result;
          ok = true;
        } else {
          text = `(에이전트 오류: ${message.subtype})`;
          ok = false;
        }
      }
    }

    return { text, sessionId, ok };
  };
}
