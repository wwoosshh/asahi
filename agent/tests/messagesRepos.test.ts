import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";

describe("MessagesRepo", () => {
  let repo: MessagesRepo;
  beforeEach(() => { repo = new MessagesRepo(openDb(":memory:")); });

  it("대화별 최근 메시지를 시간순으로 준다", () => {
    repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "첫" });
    repo.insert({ conversationId: 1, ts: 2, role: "assistant", content: "둘" });
    repo.insert({ conversationId: 2, ts: 3, role: "user", userId: "u2", content: "다른대화" });
    const m = repo.recent(1, 10);
    expect(m.map((x) => x.content)).toEqual(["첫", "둘"]);
  });

  it("FTS 접두 검색(대화 한정/전체)", () => {
    repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "병원에 다녀왔다" });
    repo.insert({ conversationId: 2, ts: 2, role: "user", userId: "u2", content: "병원 예약" });
    expect(repo.search(1, "병원", 10).map((x) => x.content)).toEqual(["병원에 다녀왔다"]);
    expect(repo.search(null, "병원", 10)).toHaveLength(2);
    expect(() => repo.search(null, "병원?", 10)).not.toThrow();
  });

  it("미처리 user 메시지 조회/완료표시", () => {
    const id = repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "a", processed: false });
    repo.insert({ conversationId: 1, ts: 2, role: "user", userId: "u1", content: "b" });
    expect(repo.unprocessedUserMessages().map((x) => x.id)).toEqual([id]);
    repo.markProcessed(id);
    expect(repo.unprocessedUserMessages()).toHaveLength(0);
  });
});

describe("SummariesRepo", () => {
  it("대화별 요약을 최신순으로 준다", () => {
    const repo = new SummariesRepo(openDb(":memory:"));
    repo.insert({ conversationId: 1, fromMessageId: 1, toMessageId: 2, content: "A", createdTs: 1 });
    repo.insert({ conversationId: 1, fromMessageId: 3, toMessageId: 4, content: "B", createdTs: 2 });
    repo.insert({ conversationId: 2, fromMessageId: 5, toMessageId: 6, content: "C", createdTs: 3 });
    expect(repo.recent(1, 5)).toEqual(["B", "A"]);
  });
});
