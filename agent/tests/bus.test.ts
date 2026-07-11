import { describe, it, expect, vi } from "vitest";
import { EventBus, type UserMessageEvent } from "../src/events/bus.js";

const msg: UserMessageEvent = { type: "user_message", channel: "discord", channelRef: "c1", text: "hi", ts: 1 };

describe("EventBus", () => {
  it("구독한 타입의 이벤트만 받는다", () => {
    const bus = new EventBus();
    const onUser = vi.fn();
    const onAssistant = vi.fn();
    bus.subscribe("user_message", onUser);
    bus.subscribe("assistant_message", onAssistant);
    bus.publish(msg);
    expect(onUser).toHaveBeenCalledWith(msg);
    expect(onAssistant).not.toHaveBeenCalled();
  });

  it("한 핸들러의 예외가 다른 핸들러를 막지 않는다", () => {
    const bus = new EventBus();
    const second = vi.fn();
    bus.subscribe("user_message", () => { throw new Error("boom"); });
    bus.subscribe("user_message", second);
    expect(() => bus.publish(msg)).not.toThrow();
    expect(second).toHaveBeenCalled();
  });
});
