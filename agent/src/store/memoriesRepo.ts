import type { Db } from "./db.js";

export type Memory = { id: number; userId: string; scope: "user" | "shared"; title: string; content: string };
type Row = { id: number | string; user_id: string; scope: "user" | "shared"; title: string; content: string };
function toMemory(r: Row): Memory { return { id: Number(r.id), userId: r.user_id, scope: r.scope, title: r.title, content: r.content }; }

export class MemoriesRepo {
  private now: () => number;
  constructor(private db: Db, now: () => number = Date.now) { this.now = now; }

  async insert(m: { userId: string; scope: "user" | "shared"; title: string; content: string; sourceConversationId?: number }): Promise<number> {
    const t = this.now();
    const r = await this.db.query(
      "INSERT INTO memories (user_id, scope, title, content, source_conversation_id, created_ts, updated_ts) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id",
      [m.userId, m.scope, m.title, m.content, m.sourceConversationId ?? null, t],
    );
    return Number((r.rows[0] as { id: number | string }).id);
  }

  async forUser(userId: string): Promise<Memory[]> {
    const r = await this.db.query(
      "SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'shared' OR (scope = 'user' AND user_id = $1) ORDER BY id",
      [userId],
    );
    return (r.rows as Row[]).map(toMemory);
  }

  async sharedOnly(): Promise<Memory[]> {
    const r = await this.db.query("SELECT id, user_id, scope, title, content FROM memories WHERE scope = 'shared' ORDER BY id");
    return (r.rows as Row[]).map(toMemory);
  }

  async all(): Promise<Memory[]> {
    const r = await this.db.query("SELECT id, user_id, scope, title, content FROM memories ORDER BY id");
    return (r.rows as Row[]).map(toMemory);
  }

  // FTS5 대체: 제목/본문 ILIKE 부분 문자열 검색.
  async searchForUser(userId: string, query: string): Promise<Memory[]> {
    const like = `%${query}%`;
    const r = await this.db.query(
      `SELECT id, user_id, scope, title, content FROM memories
       WHERE (scope = 'shared' OR (scope = 'user' AND user_id = $1)) AND (title ILIKE $2 OR content ILIKE $2) ORDER BY id`,
      [userId, like],
    );
    return (r.rows as Row[]).map(toMemory);
  }

  async update(id: number, patch: { title?: string; content?: string }): Promise<void> {
    await this.db.query(
      "UPDATE memories SET title = COALESCE($1, title), content = COALESCE($2, content), updated_ts = $3 WHERE id = $4",
      [patch.title ?? null, patch.content ?? null, this.now(), id],
    );
  }

  async delete(id: number): Promise<void> {
    await this.db.query("DELETE FROM memories WHERE id = $1", [id]);
  }
}
