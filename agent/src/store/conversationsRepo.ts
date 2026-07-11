import type Database from "better-sqlite3";

export type Conversation = {
  id: number; kind: "dm" | "thread"; discordChannelId: string; originMessageId: string | null;
  guildId: string | null; parentChannelId: string | null; primaryUserId: string; isPrivate: boolean;
  sessionId: string | null; firstMessageId: number | null; privateMemoryLoaded: boolean;
  lastActiveTs: number; status: "active" | "idle" | "closed";
};

type Row = {
  id: number; kind: "dm" | "thread"; discord_channel_id: string; origin_message_id: string | null;
  guild_id: string | null; parent_channel_id: string | null; primary_user_id: string; is_private: number;
  session_id: string | null; first_message_id: number | null; private_memory_loaded: number;
  last_active_ts: number; status: "active" | "idle" | "closed";
};

function toConversation(r: Row): Conversation {
  return {
    id: r.id, kind: r.kind, discordChannelId: r.discord_channel_id, originMessageId: r.origin_message_id,
    guildId: r.guild_id, parentChannelId: r.parent_channel_id, primaryUserId: r.primary_user_id,
    isPrivate: r.is_private === 1, sessionId: r.session_id, firstMessageId: r.first_message_id,
    privateMemoryLoaded: r.private_memory_loaded === 1, lastActiveTs: r.last_active_ts, status: r.status,
  };
}

export class ConversationsRepo {
  constructor(private db: Database.Database) {}

  create(c: { kind: "dm" | "thread"; discordChannelId: string; originMessageId?: string; guildId?: string; parentChannelId?: string; primaryUserId: string; isPrivate: boolean; lastActiveTs: number }): number {
    const result = this.db.prepare(
      `INSERT INTO conversations (kind, discord_channel_id, origin_message_id, guild_id, parent_channel_id, primary_user_id, is_private, last_active_ts, status, created_ts)
       VALUES (@kind, @discordChannelId, @originMessageId, @guildId, @parentChannelId, @primaryUserId, @isPrivate, @lastActiveTs, 'active', @lastActiveTs)`,
    ).run({
      kind: c.kind, discordChannelId: c.discordChannelId, originMessageId: c.originMessageId ?? null,
      guildId: c.guildId ?? null, parentChannelId: c.parentChannelId ?? null, primaryUserId: c.primaryUserId,
      isPrivate: c.isPrivate ? 1 : 0, lastActiveTs: c.lastActiveTs,
    });
    return Number(result.lastInsertRowid);
  }

  getById(id: number): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  getByChannelId(discordChannelId: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE discord_channel_id = ?").get(discordChannelId) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  // 유휴 정리 대상: 활성 상태 + 열린 세션 + last_active 가 컷오프 이전. 오래된 것부터.
  listActiveIdle(cutoffTs: number, limit = 100): Conversation[] {
    const rows = this.db.prepare(
      "SELECT * FROM conversations WHERE status = 'active' AND session_id IS NOT NULL AND last_active_ts < ? ORDER BY last_active_ts ASC LIMIT ?",
    ).all(cutoffTs, limit) as Row[];
    return rows.map(toConversation);
  }

  getByOriginMessageId(originMessageId: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE origin_message_id = ?").get(originMessageId) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  setSession(id: number, sessionId: string | null, lastActiveTs: number): void {
    this.db.prepare("UPDATE conversations SET session_id = ?, last_active_ts = ? WHERE id = ?").run(sessionId, lastActiveTs, id);
  }

  setPrivateMemoryLoaded(id: number, loaded: boolean): void {
    this.db.prepare("UPDATE conversations SET private_memory_loaded = ? WHERE id = ?").run(loaded ? 1 : 0, id);
  }

  setStatus(id: number, status: "active" | "idle" | "closed"): void {
    this.db.prepare("UPDATE conversations SET status = ? WHERE id = ?").run(status, id);
  }

  setFirstMessageId(id: number, messageId: number): void {
    this.db.prepare("UPDATE conversations SET first_message_id = ? WHERE id = ?").run(messageId, id);
  }
}
