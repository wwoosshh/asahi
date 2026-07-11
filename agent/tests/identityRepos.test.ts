import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";

describe("UsersRepo", () => {
  it("upsert 하고 역할을 조회한다(기본 blocked)", () => {
    const db = openDb(":memory:");
    const users = new UsersRepo(db, () => 1);
    expect(users.getRole("u1")).toBe("blocked");
    users.upsert("u1", { role: "allowed", displayName: "철수" });
    expect(users.getRole("u1")).toBe("allowed");
    users.upsert("u1", { displayName: "철수2" }); // role 유지
    expect(users.getRole("u1")).toBe("allowed");
    expect(users.list("allowed").map((u) => u.id)).toEqual(["u1"]);
  });
});

describe("ConversationsRepo", () => {
  let db: import("better-sqlite3").Database, repo: ConversationsRepo;
  beforeEach(() => { db = openDb(":memory:"); repo = new ConversationsRepo(db); });

  it("생성 후 채널ID로 조회한다", () => {
    const id = repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    const c = repo.getByChannelId("c1")!;
    expect(c.id).toBe(id);
    expect(c.isPrivate).toBe(true);
    expect(c.sessionId).toBeNull();
  });

  it("origin_message_id 로 멱등 조회한다", () => {
    repo.create({ kind: "thread", discordChannelId: "t1", originMessageId: "m1", primaryUserId: "u1", isPrivate: false, lastActiveTs: 10 });
    expect(repo.getByOriginMessageId("m1")!.discordChannelId).toBe("t1");
    expect(repo.getByOriginMessageId("nope")).toBeNull();
  });

  it("세션·상태·기억로드 플래그를 갱신한다", () => {
    const id = repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    repo.setSession(id, "s1", 20);
    repo.setPrivateMemoryLoaded(id, true);
    const c = repo.getByChannelId("c1")!;
    expect(c.sessionId).toBe("s1");
    expect(c.lastActiveTs).toBe(20);
    expect(c.privateMemoryLoaded).toBe(true);
  });
});

describe("ParticipantsRepo", () => {
  it("참여자를 upsert 하고 수를 센다", () => {
    const db = openDb(":memory:");
    const repo = new ParticipantsRepo(db);
    repo.upsert(1, "u1", 1);
    repo.upsert(1, "u1", 2); // 중복 무시
    repo.upsert(1, "u2", 3);
    expect(repo.count(1)).toBe(2);
    expect(repo.list(1).sort()).toEqual(["u1", "u2"]);
  });
});
