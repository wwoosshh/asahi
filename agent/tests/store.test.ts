import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

describe("Repo", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
  });

  it("이벤트를 저장하고 시간순으로 조회한다", () => {
    repo.insertEvent({ ts: 1, type: "user_message", channel: "discord", channelRef: "c1", content: "첫번째" });
    repo.insertEvent({ ts: 2, type: "assistant_message", channel: "discord", channelRef: "c1", content: "두번째" });
    const events = repo.recentEvents(10);
    expect(events).toHaveLength(2);
    expect(events[0].content).toBe("첫번째");
    expect(events[1].content).toBe("두번째");
  });

  it("recentEvents는 최근 N개를 시간순으로 반환한다", () => {
    for (let i = 1; i <= 5; i++) {
      repo.insertEvent({ ts: i, type: "user_message", content: `msg${i}` });
    }
    const events = repo.recentEvents(2);
    expect(events.map((e) => e.content)).toEqual(["msg4", "msg5"]);
  });

  it("FTS로 내용을 검색한다", () => {
    repo.insertEvent({ ts: 1, type: "user_message", content: "내일 병원 예약 잊지마" });
    repo.insertEvent({ ts: 2, type: "user_message", content: "저녁 메뉴 추천해줘" });
    const hits = repo.searchEvents("병원", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("병원");
  });

  it("요약을 저장하고 최신순으로 읽는다", () => {
    repo.insertSummary({ createdTs: 1, fromEventId: 1, toEventId: 2, content: "요약A" });
    repo.insertSummary({ createdTs: 2, fromEventId: 3, toEventId: 4, content: "요약B" });
    expect(repo.recentSummaries(2)).toEqual(["요약B", "요약A"]);
  });

  it("설정을 저장/조회/삭제한다", () => {
    expect(repo.getSetting("session.id")).toBeNull();
    repo.setSetting("session.id", "abc");
    expect(repo.getSetting("session.id")).toBe("abc");
    repo.setSetting("session.id", "def");
    expect(repo.getSetting("session.id")).toBe("def");
    repo.deleteSetting("session.id");
    expect(repo.getSetting("session.id")).toBeNull();
  });

  it("미처리 user_message를 조회하고 완료 표시한다", () => {
    const id1 = repo.insertEvent({ ts: 1, type: "user_message", content: "a", processed: false });
    repo.insertEvent({ ts: 2, type: "user_message", content: "b" }); // 기본 processed=true
    expect(repo.unprocessedUserMessages().map((e) => e.id)).toEqual([id1]);
    repo.markProcessed(id1);
    expect(repo.unprocessedUserMessages()).toHaveLength(0);
  });
});
