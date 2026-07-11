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
  private queue: UserMessageEvent[] = [];
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
      this.queue.push(e);
      void this.processQueue();
    });
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
        const event = this.queue.shift()!;
        await this.handleUserMessage(event).catch((err) => {
          console.error("[core] 처리 오류:", err);
          this.notify(event.channelRef, `처리 중 오류가 발생했어요: ${String(err)}`);
        });
      }
    } finally {
      this.processing = false;
      for (const resolve of this.drainResolvers.splice(0)) resolve();
    }
  }

  private async handleUserMessage(event: UserMessageEvent): Promise<void> {
    const eventId = this.repo.insertEvent({
      ts: event.ts, type: "user_message", channel: event.channel, channelRef: event.channelRef, content: event.text,
    });

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

    if (result.sessionId) {
      this.repo.setSetting("session.id", result.sessionId);
      this.repo.setSetting("session.lastActiveTs", String(this.now()));
    }

    this.repo.insertEvent({
      ts: this.now(), type: "assistant_message", channel: event.channel, channelRef: event.channelRef, content: result.text,
    });
    this.bus.publish({ type: "assistant_message", channel: event.channel, channelRef: event.channelRef, text: result.text, ts: this.now() });
  }

  async closeIdleSessionIfNeeded(): Promise<void> {
    const session = this.currentSession();
    if (!session) return;
    if (this.now() - session.lastActiveTs < this.idleMs()) return;

    const firstEventId = Number(this.repo.getSetting("session.firstEventId") ?? 0);
    const result = await this.runTurn({
      prompt: SUMMARY_PROMPT,
      systemPrompt: buildSystemPrompt(this.config.memoryDir),
      resume: session.id,
      cwd: process.cwd(),
    });
    if (result.ok && result.text.trim().length > 0) {
      const lastEvent = this.repo.recentEvents(1)[0];
      this.repo.insertSummary({
        createdTs: this.now(), fromEventId: firstEventId, toEventId: lastEvent?.id ?? firstEventId, content: result.text.trim(),
      });
    }
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
