import type { Conversation } from "../store/conversationsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";

// core.ts(봇 실시간 경로)와 워커(job 처리, worker/jobRunner.ts)가 공유하는 턴 준비 로직.
// 원래 AgentCore 의 private 메서드/지역 함수였던 것을 그대로 옮긴 것 — 동작은 완전히 동일하다.

export type ContextRepos = { memories: MemoriesRepo; summaries: SummariesRepo; messages: MessagesRepo };

// 새 세션 시작 시 주입할 기억+요약+최근대화 컨텍스트 블록.
// 프라이버시(§6): DM 은 상대(primaryUser)의 개인+공용, 서버/스레드는 공용만.
export async function buildContextBlock(repos: ContextRepos, conv: Conversation, excludeMessageId: number): Promise<string> {
  const memories = conv.isPrivate ? await repos.memories.forUser(conv.primaryUserId) : await repos.memories.sharedOnly();
  const memoryLines = memories.length > 0 ? memories.map((m) => `- [${m.title}] ${m.content}`).join("\n") : "(기억 없음)";
  const summaries = await repos.summaries.recent(conv.id, 3);
  const recentAll = await repos.messages.recent(conv.id, 21);
  const recent = recentAll.filter((m) => m.id !== excludeMessageId).slice(-20);
  const recentLines = recent
    .map((m) => `[${new Date(m.ts).toISOString()}] ${m.role === "user" ? "사용자" : m.role === "assistant" ? "비서" : "시스템"}: ${m.content}`)
    .join("\n");
  return [
    "[기억 컨텍스트 — 새 세션 시작]",
    "## 기억 (개인/공용)",
    memoryLines,
    "## 이전 대화 요약 (최신순)",
    summaries.length > 0 ? summaries.join("\n---\n") : "(요약 없음)",
    "## 최근 대화 기록",
    "(무슨 이야기를 나눴는지 파악하기 위한 참고용입니다. 아래 '비서:' 이전 답변의 말투·성격을 흉내내지 말고, 당신의 말투·성격·정체성은 반드시 위 시스템 지침의 캐릭터 설정을 따르세요.)",
    recentLines.length > 0 ? recentLines : "(기록 없음)",
  ].join("\n\n");
}

// SDK 가 resume 세션을 못 찾을 때의 에러(클라우드 컨테이너 재배포로 세션 저장소가 초기화된 경우 등).
export function isSessionNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No conversation found with session ID");
}
