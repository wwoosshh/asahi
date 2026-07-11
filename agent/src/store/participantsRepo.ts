import type Database from "better-sqlite3";

export class ParticipantsRepo {
  constructor(private db: Database.Database) {}

  upsert(conversationId: number, userId: string, joinedTs: number): void {
    this.db.prepare(
      "INSERT INTO conversation_participants (conversation_id, user_id, joined_ts) VALUES (?, ?, ?) ON CONFLICT(conversation_id, user_id) DO NOTHING",
    ).run(conversationId, userId, joinedTs);
  }

  count(conversationId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ?").get(conversationId) as { n: number };
    return row.n;
  }

  list(conversationId: number): string[] {
    const rows = this.db.prepare("SELECT user_id FROM conversation_participants WHERE conversation_id = ? ORDER BY joined_ts").all(conversationId) as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }
}
