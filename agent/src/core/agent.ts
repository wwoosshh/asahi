import { query } from "@anthropic-ai/claude-agent-sdk";

export type TurnRequest = { prompt: string; systemPrompt: string; resume?: string; cwd: string };
export type TurnResult = { text: string; sessionId?: string; ok: boolean };
export type TurnRunner = (req: TurnRequest) => Promise<TurnResult>;

export const runAgentTurn: TurnRunner = async (req) => {
  let sessionId: string | undefined;
  let text = "";
  let ok = false;

  for await (const message of query({
    prompt: req.prompt,
    options: {
      cwd: req.cwd,
      systemPrompt: req.systemPrompt,
      resume: req.resume,
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
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
