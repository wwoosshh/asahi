import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { NEW_SCHEMA, SCHEMA_VERSION } from "./schema.js";

export type { Database } from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  channel TEXT,
  channel_ref TEXT,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(content, content='events', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts INTEGER NOT NULL,
  from_event_id INTEGER NOT NULL,
  to_event_id INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  // 마이그레이션: 크래시 복구용 processed 컬럼 (기존 DB에도 안전하게 추가)
  const columns = db.pragma("table_info(events)") as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "processed")) {
    db.exec("ALTER TABLE events ADD COLUMN processed INTEGER NOT NULL DEFAULT 1");
  }
  // v2: 새 정규화 스키마를 덧붙이고(기존 테이블 유지) 스키마 버전을 기록한다.
  db.exec(NEW_SCHEMA);
  setSchemaVersion(db, Math.max(getSchemaVersion(db), SCHEMA_VERSION));
  return db;
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function setSchemaVersion(db: Database.Database, v: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(v));
}
