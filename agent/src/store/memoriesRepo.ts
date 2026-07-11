import type Database from "better-sqlite3";

export type Memory = { id: number; userId: string; scope: "user" | "shared"; title: string; content: string };
type Row = { id: number; user_id: string; scope: "user" | "shared"; title: string; content: string };
function toMemory(r: Row): Memory { return { id: r.id, userId: r.user_id, scope: r.scope, title: r.title, content: r.content }; }

export class MemoriesRepo {
  private now: () => number;
  constructor(private db: Database.Database, now: () => number = Date.now) { this.now = now; }

  insert(m: { userId: string; scope: "user" | "shared"; title: string; content: string; sourceConversationId?: number }): number {
    const t = this.now();
    const result = this.db.prepare(
      "INSERT INTO memories (user_id, scope, title, content, source_conversation_id, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(m.userId, m.scope, m.title, m.content, m.sourceConversationId ?? null, t, t);
    return Number(result.lastInsertRowid);
  }

  forUser(userId: string): Memory[] {
    const rows = this.db.prepare(
      "SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'shared' OR (scope = 'user' AND user_id = ?) ORDER BY id",
    ).all(userId) as Row[];
    return rows.map(toMemory);
  }

  sharedOnly(): Memory[] {
    const rows = this.db.prepare("SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'shared' ORDER BY id").all() as Row[];
    return rows.map(toMemory);
  }

  all(): Memory[] {
    const rows = this.db.prepare("SELECT id, user_id, scope, title, content FROM memories ORDER BY id").all() as Row[];
    return rows.map(toMemory);
  }

  searchForUser(userId: string, query: string): Memory[] {
    const like = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT id, user_id, scope, title, content FROM memories
       WHERE (scope = 'shared' OR (scope = 'user' AND user_id = @u)) AND (title LIKE @q OR content LIKE @q) ORDER BY id`,
    ).all({ u: userId, q: like }) as Row[];
    return rows.map(toMemory);
  }

  update(id: number, patch: { title?: string; content?: string }): void {
    this.db.prepare(
      "UPDATE memories SET title = COALESCE(?, title), content = COALESCE(?, content), updated_ts = ? WHERE id = ?",
    ).run(patch.title ?? null, patch.content ?? null, this.now(), id);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }
}
