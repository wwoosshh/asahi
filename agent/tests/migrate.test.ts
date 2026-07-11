import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/store/db.js";
import { migrateFromPhase1 } from "../src/store/migrate.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";

function seedPhase1(db: import("better-sqlite3").Database) {
  db.prepare("INSERT INTO events (ts, type, channel, channel_ref, content, processed) VALUES (1,'user_message','discord','c1','안녕',1)").run();
  db.prepare("INSERT INTO events (ts, type, channel, channel_ref, content, processed) VALUES (2,'assistant_message','discord','c1','안녕하세요',1)").run();
  db.prepare("INSERT INTO summaries (created_ts, from_event_id, to_event_id, content) VALUES (3,1,2,'인사 나눔')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('session.id','sX')").run();
}

describe("migrateFromPhase1", () => {
  it("events/summaries/설정을 새 스키마로 옮긴다", () => {
    const db = openDb(":memory:");
    seedPhase1(db);
    migrateFromPhase1(db, { ownerId: "owner" });
    expect(new UsersRepo(db).getRole("owner")).toBe("owner");
    const conv = new ConversationsRepo(db).getByChannelId("legacy-owner-dm")!;
    expect(conv.isPrivate).toBe(true);
    expect(conv.sessionId).toBe("sX");
    const msgs = new MessagesRepo(db).recent(conv.id, 10);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([["user", "안녕"], ["assistant", "안녕하세요"]]);
    expect(msgs[0].userId).toBe("owner");
  });

  it("마크다운 기억을 scope='user'(owner)로 임포트한다", () => {
    const db = openDb(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# 인덱스\n- 고양이");
    fs.writeFileSync(path.join(dir, "cat.md"), "고양이 두 마리를 키운다");
    migrateFromPhase1(db, { ownerId: "owner", memoryDir: dir });
    const mems = new MemoriesRepo(db).all();
    expect(mems.length).toBeGreaterThanOrEqual(2);
    expect(mems.every((m) => m.userId === "owner" && m.scope === "user")).toBe(true);
    expect(mems.some((m) => m.content.includes("고양이 두 마리"))).toBe(true);
  });

  it("멱등: 두 번 호출해도 중복 안 생김", () => {
    const db = openDb(":memory:");
    seedPhase1(db);
    migrateFromPhase1(db, { ownerId: "owner" });
    migrateFromPhase1(db, { ownerId: "owner" });
    const conv = new ConversationsRepo(db).getByChannelId("legacy-owner-dm")!;
    expect(new MessagesRepo(db).recent(conv.id, 10)).toHaveLength(2);
  });
});
