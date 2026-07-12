import { describe, it, expect } from "vitest";
import { openTestDb, getSchemaVersion, type Db } from "../src/store/db.js";

async function tableNames(db: Db): Promise<string[]> {
  const r = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  return (r.rows as Array<{ table_name: string }>).map((row) => row.table_name);
}

describe("새 스키마(Postgres)", () => {
  it("새 정규화 테이블이 모두 생성된다", async () => {
    const db = await openTestDb();
    const names = await tableNames(db);
    for (const t of [
      "users", "conversations", "conversation_participants", "messages",
      "memories", "conversation_summaries", "logs", "actions", "turns", "backups", "triggers", "meta",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("기존 1단계 테이블도 그대로 있다(덧붙임)", async () => {
    const db = await openTestDb();
    const names = await tableNames(db);
    expect(names).toContain("events");
    expect(names).toContain("settings");
    expect(names).toContain("summaries");
  });

  it("schema_version 이 기록된다", async () => {
    const db = await openTestDb();
    expect(await getSchemaVersion(db)).toBeGreaterThanOrEqual(2);
  });

  it("messages 에 ILIKE 로 부분 문자열 검색이 된다(FTS5 대체)", async () => {
    const db = await openTestDb();
    await db.query(
      "INSERT INTO conversations (kind, discord_channel_id, primary_user_id, is_private, last_active_ts, status, created_ts) VALUES ('dm','c1','u1',true,1,'active',1)",
    );
    await db.query(
      "INSERT INTO messages (conversation_id, ts, role, user_id, content, processed) VALUES (1,1,'user','u1','병원에 다녀왔다',true)",
    );
    const r = await db.query("SELECT content FROM messages WHERE content ILIKE $1", ["%병원%"]);
    expect((r.rows as Array<{ content: string }>).map((row) => row.content)).toContain("병원에 다녀왔다");
  });
});
