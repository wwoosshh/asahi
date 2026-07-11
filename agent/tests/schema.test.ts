import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db.js";

function tableNames(db: import("better-sqlite3").Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
}

describe("새 스키마", () => {
  it("새 정규화 테이블이 모두 생성된다", () => {
    const db = openDb(":memory:");
    const names = tableNames(db);
    for (const t of [
      "users", "conversations", "conversation_participants", "messages",
      "memories", "conversation_summaries", "logs", "actions", "turns", "backups", "triggers", "meta",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("기존 1단계 테이블도 그대로 있다(덧붙임)", () => {
    const db = openDb(":memory:");
    const names = tableNames(db);
    expect(names).toContain("events");
    expect(names).toContain("settings");
    expect(names).toContain("summaries");
  });

  it("schema_version 이 기록된다", async () => {
    const { getSchemaVersion } = await import("../src/store/db.js");
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(2);
  });

  it("messages FTS 로 한글 접두 검색이 된다", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations (kind, discord_channel_id, primary_user_id, is_private, last_active_ts, status, created_ts) VALUES ('dm','c1','u1',1,1,'active',1)").run();
    db.prepare("INSERT INTO messages (conversation_id, ts, role, user_id, content, processed) VALUES (1,1,'user','u1','병원에 다녀왔다',1)").run();
    const rows = db.prepare(
      `SELECT m.content FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ?`,
    ).all('"병원"*') as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toContain("병원에 다녀왔다");
  });
});
