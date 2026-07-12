import type { Db } from "./db.js";

// 대화(conversation)별 요약. 1단계 summaries 테이블과 이름 충돌을 피해 conversation_summaries 사용.
export class SummariesRepo {
  constructor(private db: Db) {}

  async insert(s: { conversationId: number; fromMessageId: number; toMessageId: number; content: string; createdTs: number }): Promise<void> {
    await this.db.query(
      "INSERT INTO conversation_summaries (conversation_id, from_message_id, to_message_id, content, created_ts) VALUES ($1, $2, $3, $4, $5)",
      [s.conversationId, s.fromMessageId, s.toMessageId, s.content, s.createdTs],
    );
  }

  async recent(conversationId: number, limit: number): Promise<string[]> {
    const r = await this.db.query(
      "SELECT content FROM conversation_summaries WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2",
      [conversationId, limit],
    );
    return (r.rows as Array<{ content: string }>).map((row) => row.content);
  }
}
