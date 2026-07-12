import { describe, it, expect } from "vitest";
import { decideRoute, detectBotMention, type Incoming } from "../src/adapters/discord.js";

function inc(over: Partial<Incoming> = {}): Incoming {
  return {
    userId: "u1", channelId: "c1", isDM: false, isThread: false, mentionsBot: false,
    guildId: "g1", parentChannelId: undefined, content: "안녕", messageId: "m1", images: [], ...over,
  };
}

describe("decideRoute", () => {
  it("blocked/미등록 사용자는 무엇을 보내든 무시한다", () => {
    expect(decideRoute(inc({ isDM: true }), "blocked", false)).toEqual({ kind: "ignore" });
    expect(decideRoute(inc({ mentionsBot: true }), "blocked", false)).toEqual({ kind: "ignore" });
    expect(decideRoute(inc({ isThread: true }), "blocked", true)).toEqual({ kind: "ignore" });
  });

  it("허용 사용자의 DM 은 그 사용자 DM 대화로 간다", () => {
    expect(decideRoute(inc({ isDM: true }), "owner", false)).toEqual({ kind: "dm" });
    expect(decideRoute(inc({ isDM: true }), "allowed", false)).toEqual({ kind: "dm" });
  });

  it("이미 대화 행이 있는 스레드 안 메시지는 멘션 없이도 이어간다", () => {
    expect(decideRoute(inc({ isThread: true, mentionsBot: false }), "allowed", true)).toEqual({ kind: "thread-existing" });
  });

  it("아직 대화가 아닌 스레드에서 멘션하면 그 스레드를 채택한다", () => {
    expect(decideRoute(inc({ isThread: true, mentionsBot: true }), "allowed", false)).toEqual({ kind: "adopt-thread" });
  });

  it("대화도 아니고 멘션도 없는 스레드 메시지는 무시한다", () => {
    expect(decideRoute(inc({ isThread: true, mentionsBot: false }), "allowed", false)).toEqual({ kind: "ignore" });
  });

  it("일반 채널에서 멘션하면 새 스레드를 만든다", () => {
    expect(decideRoute(inc({ mentionsBot: true }), "owner", false)).toEqual({ kind: "thread-create" });
  });

  it("일반 채널에서 멘션이 없으면 무시한다", () => {
    expect(decideRoute(inc({ mentionsBot: false }), "owner", false)).toEqual({ kind: "ignore" });
  });

  it("이미 대화로 채택된 채널(스레드 생성 폴백 등)은 멘션 없이도 이어간다", () => {
    expect(decideRoute(inc({ isThread: false, mentionsBot: false }), "allowed", true)).toEqual({ kind: "thread-existing" });
  });
});

describe("detectBotMention", () => {
  // discord.js MessageMentions.has 의 실제 의미를 모조한다:
  // 기본 옵션(ignoreEveryone=false)이면 @everyone/@here 에도 true 로 단락된다.
  const fakeMentions = (opts: { directHasBot: boolean; everyone: boolean }) => ({
    has: (_bot: unknown, o?: { ignoreEveryone?: boolean }) => {
      if (!o?.ignoreEveryone && opts.everyone) return true;
      return opts.directHasBot;
    },
  });

  it("@everyone/@here 만 있고 봇 직접 멘션이 없으면 false (예산 잠식 방지)", () => {
    expect(detectBotMention(fakeMentions({ directHasBot: false, everyone: true }), {})).toBe(false);
  });

  it("봇을 직접 @멘션하면 true", () => {
    expect(detectBotMention(fakeMentions({ directHasBot: true, everyone: false }), {})).toBe(true);
  });
});
