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

export class DiscordAdapter {
  private client: Client;
  private bus: EventBus;
  private config: Config;
  private users: UsersRepo;
  private conversations: ConversationsRepo;
  // 전송을 채널별 체인으로 직렬화한다: 한 채널 안에서는 청크 순서를 지키고, 채널 간에는 병렬.
  private sendChains = new Map<string, Promise<void>>();

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

    this.bus.subscribe("assistant_message", (e) => this.enqueueSend(e.channelRef, e.text));
    this.bus.subscribe("system_notice", (e) => this.enqueueSend(e.channelRef, `⚠️ ${e.text}`));

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

    const role = this.users.getRole(incoming.userId);
    const existing = this.conversations.getByChannelId(incoming.channelId);
    const decision = decideRoute(incoming, role, existing !== null);
    if (decision.kind === "ignore") return;
    if (role === "blocked") return; // 타입 좁히기용 방어(decideRoute 가 이미 걸러냄)

    // 타이핑 표시(있으면). 스레드 생성 전 원 채널에.
    if ("sendTyping" in message.channel) {
      void message.channel.sendTyping().catch(() => {});
    }

    const hint = await this.resolveHint(decision, incoming, role, message, existing?.primaryUserId);
    if (!hint) return; // 폴백조차 불가하면 조용히 종료(로그는 resolveHint 내부에서)

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
    const already = this.conversations.getByOriginMessageId(i.messageId);
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

  private enqueueSend(channelRef: string, text: string): void {
    const prev = this.sendChains.get(channelRef) ?? Promise.resolve();
    const next = prev.then(() => this.send(channelRef, text)).catch(() => {});
    this.sendChains.set(channelRef, next);
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
    // 종료 전, 모든 채널 체인에 남은 전송을 최대한 흘려보낸다(마지막 응답 유실 최소화).
    await Promise.allSettled([...this.sendChains.values()]);
    await this.client.destroy();
  }
}
