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
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

export class DiscordAdapter {
  private client: Client;
  private bus: EventBus;
  private config: Config;

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

    this.bus.subscribe("assistant_message", (e) => void send(e.channelRef, e.text));
    this.bus.subscribe("system_notice", (e) => void send(e.channelRef, `⚠️ ${e.text}`));

    this.client.on("clientReady", () => {
      console.log(`[discord] 로그인 완료: ${this.client.user?.tag}`);
    });

    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
