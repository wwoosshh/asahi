import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { UsersRepo } from "./usersRepo.js";
import { ConversationsRepo } from "./conversationsRepo.js";
import { MessagesRepo } from "./messagesRepo.js";
import { SummariesRepo } from "./summariesRepo.js";
import { MemoriesRepo } from "./memoriesRepo.js";

const ROLE_BY_TYPE: Record<string, "user" | "assistant" | "system"> = {
  user_message: "user", assistant_message: "assistant", system_notice: "system",
};

// 1단계 데이터(events/summaries/settings/마크다운 기억)를 v2 스키마로 멱등 이전한다.
export function migrateFromPhase1(db: Database.Database, opts: { ownerId?: string; memoryDir?: string }): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'migrated_v2'").get() as { value: string } | undefined;
  if (done?.value === "1") return;

  if (opts.ownerId) new UsersRepo(db).upsert(opts.ownerId, { role: "owner" });

  const hasEvents = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get() as unknown) !== undefined;
  const messageCount = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;

  if (hasEvents && messageCount === 0 && opts.ownerId) {
    const events = db.prepare("SELECT id, ts, type, content, processed FROM events ORDER BY id ASC").all() as Array<{ id: number; ts: number; type: string; content: string; processed: number }>;
    if (events.length > 0) {
      const convs = new ConversationsRepo(db);
      const convId = convs.create({ kind: "dm", discordChannelId: "legacy-owner-dm", primaryUserId: opts.ownerId, isPrivate: true, lastActiveTs: events[events.length - 1].ts });
      const msgs = new MessagesRepo(db);
      for (const e of events) {
        const role = ROLE_BY_TYPE[e.type] ?? "system";
        msgs.insert({ conversationId: convId, ts: e.ts, role, userId: role === "user" ? opts.ownerId : undefined, content: e.content, processed: e.processed !== 0 });
      }
      const sid = (db.prepare("SELECT value FROM settings WHERE key = 'session.id'").get() as { value: string } | undefined)?.value ?? null;
      const last = (db.prepare("SELECT value FROM settings WHERE key = 'session.lastActiveTs'").get() as { value: string } | undefined)?.value;
      if (sid) convs.setSession(convId, sid, last ? Number(last) : events[events.length - 1].ts);

      const summaries = new SummariesRepo(db);
      const oldSummaries = db.prepare("SELECT created_ts, content FROM summaries WHERE from_event_id IS NOT NULL").all() as Array<{ created_ts: number; content: string }>;
      for (const s of oldSummaries) summaries.insert({ conversationId: convId, fromMessageId: 0, toMessageId: 0, content: s.content, createdTs: s.created_ts });
    }
  }

  if (opts.memoryDir && opts.ownerId && fs.existsSync(opts.memoryDir)) {
    const mems = new MemoriesRepo(db);
    const existing = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    if (existing === 0) {
      for (const file of fs.readdirSync(opts.memoryDir)) {
        if (!file.endsWith(".md")) continue;
        const content = fs.readFileSync(path.join(opts.memoryDir, file), "utf8").trim();
        if (content.length === 0) continue;
        mems.insert({ userId: opts.ownerId, scope: "user", title: file.replace(/\.md$/, ""), content });
      }
    }
  }

  db.prepare("INSERT INTO meta (key, value) VALUES ('migrated_v2','1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}
