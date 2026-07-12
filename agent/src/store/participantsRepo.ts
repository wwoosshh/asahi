import type { Db } from "./db.js";

export class ParticipantsRepo {
  constructor(private db: Db) {}

  async upsert(conversationId: number, userId: string, joinedTs: number): Promise<void> {
    await this.db.query(
      "INSERT INTO conversation_participants (conversation_id, user_id, joined_ts) VALUES ($1, $2, $3) ON CONFLICT (conversation_id, user_id) DO NOTHING",
      [conversationId, userId, joinedTs],
    );
  }

  async count(conversationId: number): Promise<number> {
    const r = await this.db.query("SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = $1", [conversationId]);
    return Number((r.rows[0] as { n: number | string }).n);
  }

  async list(conversationId: number): Promise<string[]> {
    const r = await this.db.query("SELECT user_id FROM conversation_participants WHERE conversation_id = $1 ORDER BY joined_ts", [conversationId]);
    return (r.rows as Array<{ user_id: string }>).map((row) => row.user_id);
  }
}
