import type { EventBus, UserMessageEvent } from "../events/bus.js";
import type { Repo } from "../store/repo.js";
import type { Config } from "../config.js";
import type { TurnRunner } from "./agent.js";
import { buildSystemPrompt } from "./persona.js";
import { readMemoryIndex } from "../memory/memory.js";

const SUMMARY_PROMPT = `이 대화 세션이 곧 종료됩니다. 나중에 다시 깨어날 너 자신을 위해 이번 대화를 요약하세요.
- 결정된 것, 사용자에 대해 새로 알게 된 것, 진행 중인 일 중심으로 10줄 이내
- 요약 텍스트만 출력 (인사말·설명 없이)`;

export class AgentCore {
  private bus: EventBus;
  private repo: Repo;
  private config: Config;
  private runTurn: TurnRunner;
  private now: () => number;
  private queue: Array<{ event: UserMessageEvent; storedId?: number }> = [];
  private processing = false;
  private turnTimestamps: number[] = [];
  private drainResolvers: Array<() => void> = [];

  constructor(deps: { bus: EventBus; repo: Repo; config: Config; runTurn: TurnRunner; now?: () => number }) {
    this.bus = deps.bus;
    this.repo = deps.repo;
    this.config = deps.config;
    this.runTurn = deps.runTurn;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.bus.subscribe("user_message", (e) => {
      this.queue.push({ event: e });
      void this.processQueue();
    });
  }

  async recoverPending(): Promise<void> {
    for (const stored of this.repo.unprocessedUserMessages()) {
      this.queue.push({
        event: {
          type: "user_message",
          channel: (stored.channel ?? "discord") as "discord",
          channelRef: stored.channelRef ?? "",
          text: stored.content,
          ts: stored.ts,
        },
        storedId: stored.id,
      });
    }
    void this.processQueue();
  }

  drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.handleUserMessage(item.event, item.storedId).catch((err) => {
          console.error("[core] 처리 오류:", err);
          this.notify(item.event.channelRef, `처리 중 오류가 발생했어요: ${String(err)}`);
        });
      }
    } finally {
      this.processing = false;
      for (const resolve of this.drainResolvers.splice(0)) resolve();
    }
  }

  private async handleUserMessage(event: UserMessageEvent, storedId?: number): Promise<void> {
    // 새 메시지는 미처리(processed=false)로 기록하고, 처리가 끝나면(성공·한도·오류·예외 모두)
    // 완료 표시한다. 크래시로 중간에 죽으면 미처리로 남아 부팅 시 recoverPending()이 재개한다.
    const eventId = storedId ?? this.repo.insertEvent({
      ts: event.ts, type: "user_message", channel: event.channel, channelRef: event.channelRef, content: event.text, processed: false,
    });

    try {
      if (!this.checkRateLimit()) {
        this.notify(event.channelRef, "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.");
        return;
      }

      const session = this.currentSession();
      let prompt = event.text;
      let resume: string | undefined;

      if (session && this.now() - session.lastActiveTs < this.idleMs()) {
        resume = session.id;
      } else {
        prompt = `${this.buildContextBlock()}\n\n---\n\n사용자 메시지: ${event.text}`;
        this.repo.setSetting("session.firstEventId", String(eventId));
      }

      this.turnTimestamps.push(this.now());
      const result = await this.runTurn({
        prompt,
        systemPrompt: buildSystemPrompt(this.config.memoryDir),
        resume,
        cwd: process.cwd(),
      });

      if (!result.ok) {
        this.notify(event.channelRef, `비서 처리 중 오류가 있었어요: ${result.text}`);
        return;
      }

      if (result.text.trim().length === 0) {
        // 성공했지만 최종 텍스트가 비어 있음(모델이 도구 호출만 하고 끝낸 경우 등).
        // 빈 메시지를 저장/발행하지 않고 소유자에게 무응답을 표면화한다.
        this.notify(event.channelRef, "이번엔 드릴 답을 만들지 못했어요. 다시 한 번 말씀해 주세요.");
        return;
      }

      if (result.sessionId) {
        this.repo.setSetting("session.id", result.sessionId);
        this.repo.setSetting("session.lastActiveTs", String(this.now()));
      }

      this.repo.insertEvent({
        ts: this.now(), type: "assistant_message", channel: event.channel, channelRef: event.channelRef, content: result.text,
      });
      this.bus.publish({ type: "assistant_message", channel: event.channel, channelRef: event.channelRef, text: result.text, ts: this.now() });
    } finally {
      this.repo.markProcessed(eventId);
    }
  }

  async closeIdleSessionIfNeeded(): Promise<void> {
    // 메시지 처리 중이면 이번 틱은 건너뛴다(다음 호출에서 재시도). 큐와 직렬화해
    // 요약 턴이 handleUserMessage 와 인터리브되어 세션 상태가 꼬이는 것을 막는다.
    if (this.processing) return;
    const session = this.currentSession();
    if (!session) return;
    if (this.now() - session.lastActiveTs < this.idleMs()) return;

    this.processing = true;
    try {
      // 요약도 실제 LLM 호출이므로 시간당 한도에 포함한다. 한도 초과면 요약을 건너뛰되
      // 세션은 반드시 정리해 유휴 세션이 매 분 재시도되며 예산을 계속 쓰지 않게 한다.
      if (!this.checkRateLimit()) {
        this.clearSession();
        return;
      }
      const firstEventId = Number(this.repo.getSetting("session.firstEventId") ?? 0);
      const toEventId = this.repo.recentEvents(1)[0]?.id ?? firstEventId; // await 이전에 범위 캡처
      this.turnTimestamps.push(this.now());
      const result = await this.runTurn({
        prompt: SUMMARY_PROMPT,
        systemPrompt: buildSystemPrompt(this.config.memoryDir),
        resume: session.id,
        cwd: process.cwd(),
      });
      if (result.ok && result.text.trim().length > 0) {
        this.repo.insertSummary({
          createdTs: this.now(), fromEventId: firstEventId, toEventId, content: result.text.trim(),
        });
      }
      // compare-and-delete: 요약 대상이던 세션이 그대로일 때만 정리(동시 생성된 새 세션 보호).
      if (this.repo.getSetting("session.id") === session.id) {
        this.clearSession();
      }
    } finally {
      this.processing = false;
      void this.processQueue(); // 요약 중 큐에 쌓였을 메시지 처리 + drain 대기자 해제
    }
  }

  private clearSession(): void {
    this.repo.deleteSetting("session.id");
    this.repo.deleteSetting("session.lastActiveTs");
    this.repo.deleteSetting("session.firstEventId");
  }

  private currentSession(): { id: string; lastActiveTs: number } | null {
    const id = this.repo.getSetting("session.id");
    const lastActiveTs = this.repo.getSetting("session.lastActiveTs");
    if (!id || !lastActiveTs) return null;
    return { id, lastActiveTs: Number(lastActiveTs) };
  }

  private idleMs(): number {
    return this.config.sessionIdleMinutes * 60 * 1000;
  }

  private checkRateLimit(): boolean {
    const oneHourAgo = this.now() - 60 * 60 * 1000;
    this.turnTimestamps = this.turnTimestamps.filter((t) => t > oneHourAgo);
    return this.turnTimestamps.length < this.config.maxTurnsPerHour;
  }

  private buildContextBlock(): string {
    const memoryIndex = readMemoryIndex(this.config.memoryDir);
    const summaries = this.repo.recentSummaries(3);
    const recent = this.repo.recentEvents(20);
    const recentLines = recent
      .map((e) => `[${new Date(e.ts).toISOString()}] ${e.type === "user_message" ? "사용자" : "비서"}: ${e.content}`)
      .join("\n");
    return [
      "[기억 컨텍스트 — 새 세션 시작]",
      "## 장기 기억 인덱스 (MEMORY.md)",
      memoryIndex,
      "## 이전 대화 요약 (최신순)",
      summaries.length > 0 ? summaries.join("\n---\n") : "(요약 없음)",
      "## 최근 대화 기록",
      recentLines.length > 0 ? recentLines : "(기록 없음)",
    ].join("\n\n");
  }

  private notify(channelRef: string, text: string): void {
    this.repo.insertEvent({ ts: this.now(), type: "system_notice", channel: "discord", channelRef, content: text });
    this.bus.publish({ type: "system_notice", channel: "discord", channelRef, text, ts: this.now() });
  }
}
