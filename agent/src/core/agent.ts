import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "../store/usersRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import { buildTools, allowedToolsFor, TOOL_SERVER, type ToolCtx } from "./tools.js";

// 현재 턴의 상대·대화 컨텍스트. 이걸로 role·is_private 별 도구셋(allowedTools)을 정한다(§7.1).
export type TurnContext = { role: Role; isPrivate: boolean; isOwner: boolean; userId: string; conversationId: number };
export type TurnRequest = { prompt: string; systemPrompt: string; resume?: string; cwd: string; context: TurnContext };
export type TurnResult = { text: string; sessionId?: string; ok: boolean };
export type TurnRunner = (req: TurnRequest) => Promise<TurnResult>;

export type ToolRepos = { memories: MemoriesRepo; users: UsersRepo };

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
