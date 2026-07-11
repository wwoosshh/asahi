import { ChannelType, Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { EventBus } from "../events/bus.js";
import type { Config } from "../config.js";

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

export class DiscordAdapter {
  private client: Client;
  private bus: EventBus;
  private config: Config;
  // 전송을 단일 체인으로 직렬화해, 여러 메시지의 청크가 서로 뒤섞여 도착하지 않게 한다.
  private sendChain: Promise<void> = Promise.resolve();

  constructor(deps: { bus: EventBus; config: Config }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel], // DM 수신에 필요
    });
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message: Message) => {
      if (message.author.bot) return;
      if (message.author.id !== this.config.ownerId) return;
      const isDm = message.channel.type === ChannelType.DM;
      const isDesignated = this.config.channelId !== undefined && message.channelId === this.config.channelId;
      if (!isDm && !isDesignated) return;

      if ("sendTyping" in message.channel) {
        void message.channel.sendTyping().catch(() => {});
      }
      this.bus.publish({
        type: "user_message",
        channel: "discord",
        channelRef: message.channelId,
        text: message.content,
        ts: Date.now(),
      });
    });

    const send = async (channelRef: string, text: string) => {
      try {
        const channel = await this.client.channels.fetch(channelRef);
        if (!channel || !channel.isSendable()) return;
        for (const chunk of chunkMessage(text)) {
          await channel.send(chunk);
        }
      } catch (err) {
        console.error("[discord] 전송 실패:", err);
      }
    };

    const enqueueSend = (channelRef: string, text: string) => {
      this.sendChain = this.sendChain.then(() => send(channelRef, text)).catch(() => {});
    };
    this.bus.subscribe("assistant_message", (e) => enqueueSend(e.channelRef, e.text));
    this.bus.subscribe("system_notice", (e) => enqueueSend(e.channelRef, `⚠️ ${e.text}`));

    this.client.on("clientReady", () => {
      console.log(`[discord] 로그인 완료: ${this.client.user?.tag}`);
    });

    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    // 종료 전, 체인에 남은 전송을 최대한 흘려보낸다(그레이스풀 종료 시 마지막 응답 유실 최소화).
    await this.sendChain.catch(() => {});
    await this.client.destroy();
  }
}
