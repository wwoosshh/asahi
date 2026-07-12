import type { Job } from "../store/jobsRepo.js";
import type { JobsRepo } from "../store/jobsRepo.js";
import type { ConversationsRepo } from "../store/conversationsRepo.js";
import type { MessagesRepo } from "../store/messagesRepo.js";
import type { SummariesRepo } from "../store/summariesRepo.js";
import type { MemoriesRepo } from "../store/memoriesRepo.js";
import type { UsersRepo } from "../store/usersRepo.js";
import type { TurnRunner, TurnContext, TurnResult, ProgressUpdate } from "../core/agent.js";
import { buildSystemPrompt, deriveRapportStage } from "../core/persona.js";
import { formatProgress } from "../core/core.js";
import { buildContextBlock, isSessionNotFound } from "../core/turnPrep.js";

// W2: 로컬 워커가 job 하나를 실행하는 핵심 로직(순수 진입점 없이 테스트 가능하도록 core.ts 의
// runConversationTurn 과 같은 모양을 잡되, 대상이 discord 이벤트가 아니라 worker_jobs 행이다).
// - 세션 처리: core.ts(봇)와 동일한 정책(열린 세션이 유휴 이내면 resume, 아니면 새 세션+기억 컨텍스트,
//   resume 세션을 SDK 가 못 찾으면 새 세션으로 폴백)을 그대로 재사용한다(buildContextBlock/isSessionNotFound
//   는 core.ts 와 공유하는 core/turnPrep.ts 에서 가져온다) — "매 job 마다 새 세션"이 아니라, 짧은 시간
//   안에 이어지는 여러 job 은 대화 맥락을 이어간다.
// - 진행 표시: onProgress → jobs.setProgress(그 자체가 W3 가 구독해 디스코드에 편집·표시할 값).
// - 결과 기록: 성공(+빈 응답 아님) → messages.insert(assistant) + conversations.setSession + jobs.complete.
//   실패(런 실패/빈 응답/대화 없음/예외) → jobs.fail.
export type JobRunnerRepos = {
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  summaries: SummariesRepo;
  memories: MemoriesRepo;
  users: UsersRepo;
  jobs: JobsRepo;
};

export type ProcessJobDeps = {
  repos: JobRunnerRepos;
  runTurn: TurnRunner;
  agentCwd: string;
  ownerId: string;         // DISCORD_OWNER_ID — isOwner(신원) 판정용
  idleMs?: number;         // 세션 resume 유휴 윈도우(기본 30분, core.ts 의 sessionIdleMinutes 와 같은 개념)
  now?: () => number;
};

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

export async function processJob(deps: ProcessJobDeps, job: Job): Promise<void> {
  const now = deps.now ?? Date.now;
  const { repos } = deps;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;

  try {
    const conv = await repos.conversations.getById(job.conversationId);
    if (!conv) {
      await repos.jobs.fail(job.id, "대화를 찾을 수 없어요.", now());
      return;
    }

    const role = await repos.users.getRole(job.userId);
    const isOwner = job.userId === deps.ownerId;

    // 세션: 열린 세션이 유휴 이내면 resume(새 메시지만), 아니면 새 세션(기억 컨텍스트 주입).
    // excludeMessageId 로 뺄 자신의 user 메시지 id 를 워커는 모른다(Job 에 messageId 가 없음 —
    // 그 메시지는 봇(W3)이 이미 messages 테이블에 저장했다고 가정한다). 없는 id(-1)를 넘겨 아무 것도
    // 제외하지 않는다 — 최악의 경우 최근 대화 기록에 이번 사용자 메시지가 한 번 더 보이는 정도로,
    // 안전한 방향의 근사다.
    const NO_EXCLUDE = -1;
    let resume: string | undefined;
    let prompt = job.userMessage;
    if (conv.sessionId && now() - conv.lastActiveTs < idleMs) {
      resume = conv.sessionId;
    } else {
      prompt = `${await buildContextBlock(repos, conv, NO_EXCLUDE)}\n\n---\n\n사용자 메시지: ${job.userMessage}`;
    }

    // ownWorkstation: true — 이 job 은 그 사용자(job.userId) 자신의 PC 에서 실행되므로 손님이라도
    // 자기 PC 전권(파일/Bash/allow_dir 류)을 연다(allowedToolsFor/canUseTool 참고). deployTarget 은
    // 항상 "local"(워커는 로컬 실행 전용) — buildSystemPrompt 에도 그대로 반영한다.
    const context: TurnContext = {
      role, isPrivate: true, isOwner, userId: job.userId, conversationId: conv.id, ownWorkstation: true,
    };
    const rapportStage = deriveRapportStage(await repos.messages.countUserMessages(job.userId));
    const systemPrompt = buildSystemPrompt({ role, isPrivate: true, isOwner, deployTarget: "local", rapportStage });
    const onProgress = (u: ProgressUpdate) => {
      void repos.jobs.setProgress(job.id, formatProgress(u)).catch((err) => {
        console.error("[worker] 진행 상태 기록 실패:", err);
      });
    };

    let result: TurnResult;
    try {
      result = await deps.runTurn({ prompt, systemPrompt, resume, cwd: deps.agentCwd, context, onProgress });
    } catch (err) {
      if (resume && isSessionNotFound(err)) {
        console.warn("[worker] resume 세션 없음 — 새 세션으로 재시도:", conv.id);
        await repos.conversations.setSession(conv.id, null, now());
        const fresh = (await repos.conversations.getById(conv.id)) ?? conv;
        const retryPrompt = `${await buildContextBlock(repos, fresh, NO_EXCLUDE)}\n\n---\n\n사용자 메시지: ${job.userMessage}`;
        result = await deps.runTurn({ prompt: retryPrompt, systemPrompt, resume: undefined, cwd: deps.agentCwd, context, onProgress });
      } else {
        throw err;
      }
    }

    if (!result.ok) {
      await repos.jobs.fail(job.id, result.text, now());
      return;
    }
    if (result.text.trim().length === 0) {
      await repos.jobs.fail(job.id, "이번엔 드릴 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.", now());
      return;
    }

    await repos.messages.insert({ conversationId: conv.id, ts: now(), role: "assistant", content: result.text });
    await repos.conversations.setSession(conv.id, result.sessionId ?? conv.sessionId, now());
    await repos.jobs.complete(job.id, result.text, now());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await repos.jobs.fail(job.id, `워커 처리 중 예기치 못한 오류: ${msg}`, now());
  }
}
