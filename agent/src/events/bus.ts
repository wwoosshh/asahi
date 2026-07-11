export type ChannelKind = "discord";

export type UserMessageEvent = { type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AssistantMessageEvent = { type: "assistant_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type SystemNoticeEvent = { type: "system_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AgentEvent = UserMessageEvent | AssistantMessageEvent | SystemNoticeEvent;

type Handler = (e: AgentEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<AgentEvent["type"], Handler[]>();

  subscribe<T extends AgentEvent["type"]>(
    type: T,
    handler: (e: Extract<AgentEvent, { type: T }>) => void | Promise<void>,
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler);
    this.handlers.set(type, list);
  }

  publish(event: AgentEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[bus] 핸들러 오류 (${event.type}):`, err));
        }
      } catch (err) {
        console.error(`[bus] 핸들러 오류 (${event.type}):`, err);
      }
    }
  }
}
