import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import { buildTools, allowedToolsFor, TOOL_SERVER, type ToolCtx } from "./tools.js";

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

export type ToolRepos = { memories: MemoriesRepo; users: UsersRepo };

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
        allowedTools,
        mcpServers: { [TOOL_SERVER]: server },
        permissionMode: "dontAsk",
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
