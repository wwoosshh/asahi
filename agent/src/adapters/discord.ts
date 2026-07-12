import {
  ChannelType, Client, GatewayIntentBits, Partials, ThreadAutoArchiveDuration, type Message,
} from "discord.js";
import type { EventBus, ConversationHint } from "../events/bus.js";
import type { Config } from "../config.js";
import type { UsersRepo, Role } from "../store/usersRepo.js";
import type { ConversationsRepo } from "../store/conversationsRepo.js";

export function chunkMessage(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) {
      cut = max;
      // 강제 절단이 서로게이트 쌍(이모지 등 4바이트 문자) 중간을 가르지 않도록 한 칸 앞으로 당긴다.
      const hi = rest.charCodeAt(cut - 1);
      const lo = rest.charCodeAt(cut);
      if (cut > 1 && hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

// ── 순수 라우팅 결정 (테스트 용이) ──────────────────────────────────────────
// 인입 메시지 + 발화자 role + 이 채널에 대화 행 존재여부 → 무엇을 할지.
export type Incoming = {
  userId: string; channelId: string; isDM: boolean; isThread: boolean; mentionsBot: boolean;
  guildId?: string; parentChannelId?: string; content: string; messageId: string;
};
export type RouteDecision =
  | { kind: "ignore" }            // 게이트 탈락 / 관심 없는 메시지
  | { kind: "dm" }                // 그 사용자 DM 대화
  | { kind: "thread-existing" }   // 이미 conversations 행이 있는 스레드(또는 폴백 채널)
  | { kind: "thread-create" }     // 일반 채널 @멘션 → 새 스레드 생성
  | { kind: "adopt-thread" };     // 아직 대화 아닌 스레드에서 @멘션 → 그 스레드 채택

export function decideRoute(i: Incoming, role: Role, hasConversation: boolean): RouteDecision {
  // 응답 게이트: owner/allowed 만. 미등록·blocked·컨텍스트 작성자 불문 무시.
  if (role !== "owner" && role !== "allowed") return { kind: "ignore" };
  if (i.isDM) return { kind: "dm" };
  if (i.isThread) {
    if (hasConversation) return { kind: "thread-existing" }; // 봇 대화 지속(멘션 불필요)
    if (i.mentionsBot) return { kind: "adopt-thread" };
    return { kind: "ignore" };
  }
  // 일반(비스레드) 채널
  if (hasConversation) return { kind: "thread-existing" };   // 스레드 생성 폴백으로 채택된 채널 등
  if (i.mentionsBot) return { kind: "thread-create" };
  return { kind: "ignore" };
}

// 봇이 "직접 @멘션" 되었는지만 판정한다. discord.js 의 기본 has(bot) 는 @everyone/@here·
// 역할 멘션·답장 자동멘션에도 true 를 돌려주므로, 그것들을 무시하도록 옵션을 명시한다
// (그렇지 않으면 @everyone 공지 하나에도 스레드가 생기고 LLM 턴이 소모된다).
type MentionLike = { has(target: unknown, options?: { ignoreEveryone?: boolean; ignoreRoles?: boolean; ignoreRepliedUser?: boolean }): boolean };
export function detectBotMention(mentions: MentionLike, bot: unknown): boolean {
  return mentions.has(bot, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
}

const THREAD_NAME_MAX = 90;

// ── 진행 상태 UI: 순수 로직 (테스트 용이) ──────────────────────────────────
// 처리중/완료 반응 이모지. 시스템 UI 용도이므로 답변 텍스트의 "이모티콘 금지" 정책과 무관.
export const PROCESSING_REACTION = "👀";
export const DONE_REACTION = "✅";

export const PROGRESS_EDIT_MIN_INTERVAL_MS = 800;

export type ThrottleDecision = { action: "now" } | { action: "later"; delayMs: number };

// 상태 메시지 편집을 지금 할지 미룰지 순수하게 판단한다.
// lastEditTs 가 없으면(첫 편집) 항상 즉시. 그 외엔 최소 간격을 채웠는지로 판단하고,
// 못 채웠으면 남은 시간만큼 지연시켜 트레일링 에지(마지막 상태는 반드시 반영)를 보장한다.
export function decideProgressEditThrottle(
  lastEditTs: number | null,
  now: number,
  minIntervalMs: number = PROGRESS_EDIT_MIN_INTERVAL_MS,
): ThrottleDecision {
  if (lastEditTs === null) return { action: "now" };
  const elapsed = now - lastEditTs;
  if (elapsed >= minIntervalMs) return { action: "now" };
  return { action: "later", delayMs: minIntervalMs - elapsed };
}

// 디스코드 2000자 한도 보호용: 상태 메시지엔 최근 이 개수만큼만 표시한다.
export const PROGRESS_DISPLAY_MAX_LINES = 12;

// 연속으로 반복되는 라인(특히 "답변 작성 중")을 하나로 접는다. 떨어져서 반복되는 건 각각 남긴다.
function collapseConsecutiveDuplicates(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length === 0 || out[out.length - 1] !== line) out.push(line);
  }
  return out;
}

// 누적된 진행 라인 → 상태 메시지 문자열. 무한 누적으로 2000자 한도를 넘기지 않도록
// 연속 중복을 접고 최근 N개만 표시한다(순수 함수).
export function formatProgressMessage(lines: readonly string[]): string {
  if (lines.length === 0) return "처리 중";
  const collapsed = collapseConsecutiveDuplicates(lines);
  const display = collapsed.length > PROGRESS_DISPLAY_MAX_LINES
    ? collapsed.slice(-PROGRESS_DISPLAY_MAX_LINES)
    : collapsed;
  return ["처리 중", ...display.map((line) => `· ${line}`)].join("\n");
}

// 채널(channelRef)별 진행 상태 UI 수명주기.
type ProgressState = {
  lines: string[];                               // 누적된 진행 라인
  statusMessage: Message | null;                  // 현재 턴의 상태 메시지(없으면 아직 미전송)
  lastEditTs: number | null;                       // 마지막 편집 시각(throttle 기준)
  editTimer: ReturnType<typeof setTimeout> | null; // 지연된(트레일링) 편집 타이머
  pendingTriggers: Message[];                      // 반응을 달아둔 원본 메시지들(턴 순서대로 FIFO)
};

export class DiscordAdapter {
  private client: Client;
  private bus: EventBus;
  private config: Config;
  private users: UsersRepo;
  private conversations: ConversationsRepo;
  // 전송을 채널별 체인으로 직렬화한다: 한 채널 안에서는 청크 순서를 지키고, 채널 간에는 병렬.
  private sendChains = new Map<string, Promise<void>>();
  // 상태 메시지 생성/편집/삭제를 채널별로 직렬화한다(진행 이벤트는 순서가 보장되므로 그대로 순서를 지켜 처리).
  private statusChains = new Map<string, Promise<void>>();
  private progressState = new Map<string, ProgressState>();

  constructor(deps: { bus: EventBus; config: Config; users: UsersRepo; conversations: ConversationsRepo }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.users = deps.users;
    this.conversations = deps.conversations;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,          // 채널·스레드 메타
        GatewayIntentBits.GuildMessages,   // 채널·스레드 메시지
        GatewayIntentBits.DirectMessages,  // DM
        GatewayIntentBits.MessageContent,  // 내용 읽기
      ],
      partials: [Partials.Channel], // DM 수신에 필요
    });
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message: Message) => {
      void this.onMessage(message).catch((err) => console.error("[discord] 메시지 처리 오류:", err));
    });

    this.bus.subscribe("progress", (e) => {
      this.enqueueStatus(e.channelRef, () => this.handleProgress(e.channelRef, e.text));
    });
    this.bus.subscribe("assistant_message", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      this.enqueueSendAfter(e.channelRef, statusDone, e.text);
    });
    this.bus.subscribe("system_notice", (e) => {
      const statusDone = this.enqueueStatus(e.channelRef, () => this.finishStatus(e.channelRef));
      this.enqueueSendAfter(e.channelRef, statusDone, `⚠️ ${e.text}`);
    });

    this.client.on("clientReady", () => {
      console.log(`[discord] 로그인 완료: ${this.client.user?.tag}`);
    });

    await this.client.login(this.config.discordToken);
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const bot = this.client.user;
    if (!bot) return;

    const isThread = message.channel.isThread();
    const incoming: Incoming = {
      userId: message.author.id,
      channelId: message.channelId,
      isDM: message.channel.type === ChannelType.DM,
      isThread,
      mentionsBot: detectBotMention(message.mentions, bot),
      guildId: message.guildId ?? undefined,
      parentChannelId: isThread ? message.channel.parentId ?? undefined : undefined,
      content: message.content,
      messageId: message.id,
    };

    const role = await this.users.getRole(incoming.userId);
    const existing = await this.conversations.getByChannelId(incoming.channelId);
    const decision = decideRoute(incoming, role, existing !== null);
    if (decision.kind === "ignore") return;
    if (role === "blocked") return; // 타입 좁히기용 방어(decideRoute 가 이미 걸러냄)

    // 타이핑 표시(있으면). 스레드 생성 전 원 채널에.
    if ("sendTyping" in message.channel) {
      void message.channel.sendTyping().catch(() => {});
    }

    const hint = await this.resolveHint(decision, incoming, role, message, existing?.primaryUserId);
    if (!hint) return; // 폴백조차 불가하면 조용히 종료(로그는 resolveHint 내부에서)

    this.beginTurn(hint.discordChannelId, message);

    this.bus.publish({
      type: "user_message",
      channel: "discord",
      channelRef: hint.discordChannelId,
      text: incoming.content,
      ts: Date.now(),
      hint,
    });
  }

  // 라우팅 결정을 실제 대화 매핑 힌트로 바꾼다. thread-create 만 부수효과(스레드 생성)가 있다.
  private async resolveHint(
    decision: Exclude<RouteDecision, { kind: "ignore" }>,
    i: Incoming,
    role: "owner" | "allowed",
    message: Message,
    existingPrimaryUserId?: string,
  ): Promise<ConversationHint | null> {
    const common = { guildId: i.guildId, parentChannelId: i.parentChannelId, userId: i.userId, role, discordMessageId: i.messageId };
    switch (decision.kind) {
      case "dm":
        return { ...common, kind: "dm", discordChannelId: i.channelId, isPrivate: true, primaryUserId: i.userId };
      case "thread-existing":
        // 기존 대화의 주 사용자를 유지(스레드 개설자 등). 없으면 발화자로.
        return { ...common, kind: "thread", discordChannelId: i.channelId, isPrivate: false, primaryUserId: existingPrimaryUserId ?? i.userId };
      case "adopt-thread":
        return { ...common, kind: "thread", discordChannelId: i.channelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
      case "thread-create":
        return this.createThreadHint(i, common);
    }
  }

  private async createThreadHint(
    i: Incoming,
    common: { guildId?: string; parentChannelId?: string; userId: string; role: "owner" | "allowed"; discordMessageId: string },
  ): Promise<ConversationHint | null> {
    // 멱등: 이 트리거 메시지로 이미 만든 대화가 있으면 그 스레드 재사용(스레드 재생성 금지).
    const already = await this.conversations.getByOriginMessageId(i.messageId);
    if (already) {
      return { ...common, kind: "thread", discordChannelId: already.discordChannelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
    }
    const name = i.content.trim().slice(0, THREAD_NAME_MAX) || "비서 대화";
    try {
      const thread = await this.startThread(i.channelId, i.messageId, name);
      return { ...common, kind: "thread", discordChannelId: thread.id, parentChannelId: i.channelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
    } catch (err) {
      // 폴백: 스레드 생성 불가/권한부족 → 채널 자체를 대화로 채택하고 인플레이스로 답장. 실패는 로그.
      console.error("[discord] 스레드 생성 실패 — 인플레이스 폴백:", err);
      return { ...common, kind: "thread", discordChannelId: i.channelId, originMessageId: i.messageId, isPrivate: false, primaryUserId: i.userId };
    }
  }

  private async startThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.isDMBased() || !("messages" in channel)) throw new Error("스레드를 만들 수 없는 채널");
    const message = await channel.messages.fetch(messageId);
    return message.startThread({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
  }

  // 상태 메시지 작업(생성/편집/삭제)을 채널별로 직렬화한다. 반환된 프라미스는 "이 작업까지 끝남"을
  // 나타내며, 최종 답변 전송이 상태 메시지 정리 이후에 나가도록 enqueueSendAfter 에서 대기시킨다.
  private enqueueStatus(channelRef: string, task: () => Promise<void>): Promise<void> {
    const prev = this.statusChains.get(channelRef) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => console.error("[discord] 상태 처리 오류:", err));
    this.statusChains.set(channelRef, next);
    return next;
  }

  // 기존 sendChains 직렬화에 더해, 그 채널의 상태 정리(wait)가 끝난 뒤에만 전송하도록 합류시킨다.
  private enqueueSendAfter(channelRef: string, wait: Promise<void>, text: string): void {
    const prev = this.sendChains.get(channelRef) ?? Promise.resolve();
    const next = Promise.all([prev, wait]).then(() => this.send(channelRef, text)).catch(() => {});
    this.sendChains.set(channelRef, next);
  }

  private getProgressState(channelRef: string): ProgressState {
    let state = this.progressState.get(channelRef);
    if (!state) {
      state = { lines: [], statusMessage: null, lastEditTs: null, editTimer: null, pendingTriggers: [] };
      this.progressState.set(channelRef, state);
    }
    return state;
  }

  // 게이트를 통과해 턴이 시작될 때: 원본 메시지에 처리중 반응을 달고, 그 채널의 반응 정리 순번
  // 큐(pendingTriggers)에 등록해둔다(완료 시 finishStatus 가 순서대로 꺼내 반응을 완료 표시로 바꾼다).
  private beginTurn(channelRef: string, message: Message): void {
    const state = this.getProgressState(channelRef);
    state.pendingTriggers.push(message);
    void message.react(PROCESSING_REACTION).catch((err) => console.error("[discord] 반응 추가 실패:", err));
  }

  // 그 채널의 첫 진행 이벤트면 상태 메시지를 새로 보내고, 이후엔 throttle 을 거쳐 편집한다.
  private async handleProgress(channelRef: string, text: string): Promise<void> {
    const state = this.getProgressState(channelRef);
    state.lines.push(text);
    if (!state.statusMessage) {
      try {
        const channel = await this.client.channels.fetch(channelRef);
        if (channel && channel.isSendable()) {
          state.statusMessage = await channel.send(formatProgressMessage(state.lines));
          state.lastEditTs = Date.now();
        }
      } catch (err) {
        console.error("[discord] 상태 메시지 전송 실패:", err);
      }
      return;
    }
    this.scheduleStatusEdit(state);
  }

  private scheduleStatusEdit(state: ProgressState): void {
    const decision = decideProgressEditThrottle(state.lastEditTs, Date.now());
    if (decision.action === "now") {
      this.applyStatusEdit(state);
      return;
    }
    if (state.editTimer) return; // 이미 트레일링 편집이 예약됨 — 발화 시점에 최신 lines 를 읽는다.
    state.editTimer = setTimeout(() => {
      state.editTimer = null;
      this.applyStatusEdit(state);
    }, decision.delayMs);
  }

  private applyStatusEdit(state: ProgressState): void {
    const msg = state.statusMessage;
    if (!msg) return;
    state.lastEditTs = Date.now();
    void msg.edit(formatProgressMessage(state.lines)).catch((err) => console.error("[discord] 상태 메시지 편집 실패:", err));
  }

  // 턴 종료(assistant_message/system_notice 공통): 대기 중인 편집을 취소하고 상태 메시지를 지운 뒤,
  // 이 턴을 시작시킨 원본 메시지의 반응을 처리중→완료로 바꾼다. 실패는 로그만 남기고 흐름은 계속한다.
  private async finishStatus(channelRef: string): Promise<void> {
    const state = this.progressState.get(channelRef);
    if (state) {
      if (state.editTimer) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
      if (state.statusMessage) {
        const msg = state.statusMessage;
        state.statusMessage = null;
        try {
          await msg.delete();
        } catch (err) {
          console.error("[discord] 상태 메시지 삭제 실패:", err);
        }
      }
      state.lines = [];
    }
    const trigger = state?.pendingTriggers.shift() ?? null;
    if (!trigger) return;
    try {
      // reaction.remove() 는 그 반응의 모든 사용자를 지우며 MANAGE_MESSAGES 를 요구하고 DM 에서 불가능하다.
      // users.remove()(인자 없으면 봇 자신 → .../@me) 는 자기 반응만 지우므로 권한 없이도, DM 에서도 동작한다.
      await trigger.reactions.cache.get(PROCESSING_REACTION)?.users.remove();
    } catch (err) {
      console.error("[discord] 반응 정리 실패:", err);
    }
    try {
      await trigger.react(DONE_REACTION);
    } catch (err) {
      console.error("[discord] 완료 반응 실패:", err);
    }
  }

  private async send(channelRef: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelRef);
      if (!channel || !channel.isSendable()) return;
      for (const chunk of chunkMessage(text)) {
        await channel.send(chunk);
      }
    } catch (err) {
      console.error("[discord] 전송 실패:", err);
    }
  }

  async stop(): Promise<void> {
    // 남아있는 트레일링 편집 타이머를 정리해 유령 상태 메시지 편집이 발생하지 않게 한다.
    for (const state of this.progressState.values()) {
      if (state.editTimer) {
        clearTimeout(state.editTimer);
        state.editTimer = null;
      }
    }
    // 종료 전, 모든 채널 체인(상태 정리 + 전송)에 남은 작업을 최대한 흘려보낸다(마지막 응답 유실 최소화).
    await Promise.allSettled([...this.statusChains.values(), ...this.sendChains.values()]);
    await this.client.destroy();
  }
}
