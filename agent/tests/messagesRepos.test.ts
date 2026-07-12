import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";

describe("MessagesRepo", () => {
  let repo: MessagesRepo;
  beforeEach(async () => { repo = new MessagesRepo(await openTestDb()); });

  it("대화별 최근 메시지를 시간순으로 준다", async () => {
    await repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "첫" });
    await repo.insert({ conversationId: 1, ts: 2, role: "assistant", content: "둘" });
    await repo.insert({ conversationId: 2, ts: 3, role: "user", userId: "u2", content: "다른대화" });
    const m = await repo.recent(1, 10);
    expect(m.map((x) => x.content)).toEqual(["첫", "둘"]);
  });

  it("ILIKE 부분일치 검색(대화 한정/전체, FTS5 대체)", async () => {
    await repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "병원에 다녀왔다" });
    await repo.insert({ conversationId: 2, ts: 2, role: "user", userId: "u2", content: "병원 예약" });
    expect((await repo.search(1, "병원", 10)).map((x) => x.content)).toEqual(["병원에 다녀왔다"]);
    expect(await repo.search(null, "병원", 10)).toHaveLength(2);
    await expect(repo.search(null, "병원?", 10)).resolves.not.toThrow();
  });

  it("ILIKE 메타문자(%, _)를 이스케이프해 리터럴로만 매칭한다", async () => {
    await repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "50% 할인" });
    await repo.insert({ conversationId: 1, ts: 2, role: "user", userId: "u1", content: "50X 할인" });
    await repo.insert({ conversationId: 1, ts: 3, role: "user", userId: "u1", content: "a_b 테스트" });
    await repo.insert({ conversationId: 1, ts: 4, role: "user", userId: "u1", content: "aXb 테스트" });

    // '%' 가 이스케이프되지 않으면 와일드카드로 해석되어 "50X 할인"도 오매칭된다.
    expect((await repo.search(1, "50%", 10)).map((x) => x.content)).toEqual(["50% 할인"]);
    // '_' 가 이스케이프되지 않으면 와일드카드로 해석되어 "aXb 테스트"도 오매칭된다.
    expect((await repo.search(1, "a_b", 10)).map((x) => x.content)).toEqual(["a_b 테스트"]);
  });

  it("미처리 user 메시지 조회/완료표시", async () => {
    const id = await repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "a", processed: false });
    await repo.insert({ conversationId: 1, ts: 2, role: "user", userId: "u1", content: "b" });
    expect((await repo.unprocessedUserMessages()).map((x) => x.id)).toEqual([id]);
    await repo.markProcessed(id);
    expect(await repo.unprocessedUserMessages()).toHaveLength(0);
  });
});

describe("SummariesRepo", () => {
  it("대화별 요약을 최신순으로 준다", async () => {
    const repo = new SummariesRepo(await openTestDb());
    await repo.insert({ conversationId: 1, fromMessageId: 1, toMessageId: 2, content: "A", createdTs: 1 });
    await repo.insert({ conversationId: 1, fromMessageId: 3, toMessageId: 4, content: "B", createdTs: 2 });
    await repo.insert({ conversationId: 2, fromMessageId: 5, toMessageId: 6, content: "C", createdTs: 3 });
    expect(await repo.recent(1, 5)).toEqual(["B", "A"]);
  });
});
