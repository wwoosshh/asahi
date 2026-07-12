import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";

describe("MessagesRepo.countUserMessages", () => {
  let db: Db;
  let repo: MessagesRepo;

  beforeEach(async () => {
    db = await openTestDb();
    repo = new MessagesRepo(db);
  });

  it("그 사용자의 user 역할 메시지만 센다(assistant·다른 사용자는 제외)", async () => {
    await repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "a" });
    await repo.insert({ conversationId: 1, ts: 2, role: "user", userId: "u1", content: "b" });
    await repo.insert({ conversationId: 1, ts: 3, role: "assistant", userId: "u1", content: "c" });
    await repo.insert({ conversationId: 1, ts: 4, role: "user", userId: "u2", content: "d" });

    expect(await repo.countUserMessages("u1")).toBe(2);
    expect(await repo.countUserMessages("u2")).toBe(1);
    expect(await repo.countUserMessages("nobody")).toBe(0);
  });
});
