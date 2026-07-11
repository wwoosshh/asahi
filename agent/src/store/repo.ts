import type Database from "better-sqlite3";

export type StoredEvent = {
  id: number;
  ts: number;
  type: string;
  channel: string | null;
  channelRef: string | null;
  content: string;
};

type Row = { id: number; ts: number; type: string; channel: string | null; channel_ref: string | null; content: string };

function toEvent(r: Row): StoredEvent {
  return { id: r.id, ts: r.ts, type: r.type, channel: r.channel, channelRef: r.channel_ref, content: r.content };
}

export class Repo {
  constructor(private db: Database.Database) {}

  insertEvent(e: { ts: number; type: string; channel?: string; channelRef?: string; content: string; processed?: boolean }): number {
    const result = this.db
      .prepare("INSERT INTO events (ts, type, channel, channel_ref, content, processed) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.ts, e.type, e.channel ?? null, e.channelRef ?? null, e.content, e.processed === false ? 0 : 1);
    return Number(result.lastInsertRowid);
  }

  unprocessedUserMessages(): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE type = 'user_message' AND processed = 0 ORDER BY id ASC")
      .all() as Row[];
    return rows.map(toEvent);
  }

  markProcessed(id: number): void {
    this.db.prepare("UPDATE events SET processed = 1 WHERE id = ?").run(id);
  }

  recentEvents(limit: number): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id ASC")
      .all(limit) as Row[];
    return rows.map(toEvent);
  }

  searchEvents(query: string, limit: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events_fts f JOIN events e ON e.id = f.rowid
         WHERE events_fts MATCH ? ORDER BY e.id DESC LIMIT ?`,
      )
      .all(query, limit) as Row[];
    return rows.map(toEvent);
  }

  insertSummary(s: { createdTs: number; fromEventId: number; toEventId: number; content: string }): void {
    this.db
      .prepare("INSERT INTO summaries (created_ts, from_event_id, to_event_id, content) VALUES (?, ?, ?, ?)")
      .run(s.createdTs, s.fromEventId, s.toEventId, s.content);
  }

  recentSummaries(limit: number): string[] {
    const rows = this.db
      .prepare("SELECT content FROM summaries ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
