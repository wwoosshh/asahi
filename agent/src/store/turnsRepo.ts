import type Database from "better-sqlite3";

export class TurnsRepo {
  constructor(private db: Database.Database) {}

  countUser(userId: string, sinceTs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE user_id = ? AND ts > ?").get(userId, sinceTs) as { n: number };
    return row.n;
  }

  countGlobal(sinceTs: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE ts > ?").get(sinceTs) as { n: number };
    return row.n;
  }

  reserve(o: { userId: string | null; conversationId: number | null; kind: "message" | "summary" | "proactive"; ts: number; perUserLimit: number; globalLimit: number; ownerReserve: number; isOwner: boolean; windowMs: number }): boolean {
    const since = o.ts - o.windowMs;
    const tx = this.db.transaction(() => {
      if (o.userId !== null && this.countUser(o.userId, since) >= o.perUserLimit) return false;
      const globalCap = o.isOwner ? o.globalLimit : Math.max(0, o.globalLimit - o.ownerReserve);
      if (this.countGlobal(since) >= globalCap) return false;
      this.db.prepare("INSERT INTO turns (ts, user_id, conversation_id, kind) VALUES (?, ?, ?, ?)").run(o.ts, o.userId, o.conversationId, o.kind);
      return true;
    });
    return tx() as boolean;
  }
}
