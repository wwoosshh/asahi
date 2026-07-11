import type Database from "better-sqlite3";

// 대화(conversation)별 요약. 1단계 summaries 테이블과 이름 충돌을 피해 conversation_summaries 사용.
export class SummariesRepo {
  constructor(private db: Database.Database) {}

  insert(s: { conversationId: number; fromMessageId: number; toMessageId: number; content: string; createdTs: number }): void {
    this.db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, from_message_id, to_message_id, content, created_ts) VALUES (?, ?, ?, ?, ?)",
    ).run(s.conversationId, s.fromMessageId, s.toMessageId, s.content, s.createdTs);
  }

  recent(conversationId: number, limit: number): string[] {
    const rows = this.db.prepare("SELECT content FROM conversation_summaries WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(conversationId, limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }
}
