import type Database from "better-sqlite3";

export type StoredMessage = { id: number; conversationId: number; ts: number; role: "user" | "assistant" | "system"; userId: string | null; content: string };
type Row = { id: number; conversation_id: number; ts: number; role: "user" | "assistant" | "system"; user_id: string | null; content: string };
function toMessage(r: Row): StoredMessage {
  return { id: r.id, conversationId: r.conversation_id, ts: r.ts, role: r.role, userId: r.user_id, content: r.content };
}

// 자유 텍스트를 FTS5 안전 접두 쿼리로 (1단계 수정과 동일 방식)
function toMatch(query: string): string {
  return query.split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export class MessagesRepo {
  constructor(private db: Database.Database) {}

  insert(m: { conversationId: number; ts: number; role: "user" | "assistant" | "system"; userId?: string; discordMessageId?: string; content: string; processed?: boolean }): number {
    const result = this.db.prepare(
      "INSERT INTO messages (conversation_id, ts, role, user_id, discord_message_id, content, processed) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(m.conversationId, m.ts, m.role, m.userId ?? null, m.discordMessageId ?? null, m.content, m.processed === false ? 0 : 1);
    return Number(result.lastInsertRowid);
  }

  recent(conversationId: number, limit: number): StoredMessage[] {
    const rows = this.db.prepare(
      "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
    ).all(conversationId, limit) as Row[];
    return rows.map(toMessage);
  }

  search(conversationId: number | null, query: string, limit: number): StoredMessage[] {
    const match = toMatch(query);
    if (match.length === 0) return [];
    const rows = (conversationId === null
      ? this.db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY m.id DESC LIMIT ?`).all(match, limit)
      : this.db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`).all(match, conversationId, limit)) as Row[];
    return rows.map(toMessage);
  }

  unprocessedUserMessages(): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE role = 'user' AND processed = 0 ORDER BY id ASC").all() as Row[];
    return rows.map(toMessage);
  }

  markProcessed(id: number): void {
    this.db.prepare("UPDATE messages SET processed = 1 WHERE id = ?").run(id);
  }
}
