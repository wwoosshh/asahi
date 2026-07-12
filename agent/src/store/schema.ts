export const SCHEMA_VERSION = 3;

// Postgres DDL. better-sqlite3 -> pg 이전(feat/postgres-supabase-store)에서
// 기존 SQLite 스키마(db.ts 의 legacy SCHEMA + 이 파일의 NEW_SCHEMA)를 하나로 합쳤다.
// - INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
// - 불리언 의미 컬럼(is_private, processed, private_memory_loaded) -> BOOLEAN
// - FTS5 가상테이블(messages_fts/events_fts)과 그 트리거는 제거했다. 검색은 이후 태스크에서 ILIKE 로 구현한다.
// - 1단계 호환 테이블(events/summaries)은 "새로 시작" 정책(T3)에 따라 제거했다 — migrateFromPhase1
//   삭제로 더 이상 아무도 참조하지 않는다(legacy Repo(better-sqlite3) 도 함께 제거).
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'blocked',
  display_name TEXT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL UNIQUE,
  origin_message_id TEXT UNIQUE,
  guild_id TEXT,
  parent_channel_id TEXT,
  primary_user_id TEXT NOT NULL,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  session_id TEXT,
  first_message_id BIGINT,
  private_memory_loaded BOOLEAN NOT NULL DEFAULT FALSE,
  last_active_ts BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  joined_ts BIGINT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_conv ON conversation_participants(conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  ts BIGINT NOT NULL,
  role TEXT NOT NULL,
  user_id TEXT,
  discord_message_id TEXT,
  content TEXT NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(processed) WHERE processed = FALSE;

CREATE TABLE IF NOT EXISTS memories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_conversation_id BIGINT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, scope);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  from_message_id BIGINT NOT NULL,
  to_message_id BIGINT NOT NULL,
  content TEXT NOT NULL,
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conv ON conversation_summaries(conversation_id);

CREATE TABLE IF NOT EXISTS logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts, level);

CREATE TABLE IF NOT EXISTS actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  conversation_id BIGINT,
  user_id TEXT,
  tool TEXT NOT NULL,
  input TEXT,
  result_summary TEXT,
  status TEXT NOT NULL,
  duration_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_actions_conv ON actions(conversation_id, ts);

CREATE TABLE IF NOT EXISTS turns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  user_id TEXT,
  conversation_id BIGINT,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_user_ts ON turns(user_id, ts);

CREATE TABLE IF NOT EXISTS backups (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts BIGINT NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS triggers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  next_run_ts BIGINT,
  target_user_id TEXT,
  target_conversation_id BIGINT,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_next ON triggers(next_run_ts) WHERE status = 'active';

-- 하이브리드 재설계 조각3(사용자별 로컬 워커): Railway 봇이 owner/손님 DM 의 PC 작업(파일/Bash)을
-- 각자의 로컬 워커에게 위임하는 큐. 워커 진입점·봇 라우팅은 별도 태스크(W2/W3) 몫이며, 이 스키마는
-- 그 데이터 계층만 마련한다.
CREATE TABLE IF NOT EXISTS worker_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id BIGINT NOT NULL,
  discord_channel_id TEXT NOT NULL,
  user_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress TEXT,
  result TEXT,
  error TEXT,
  created_ts BIGINT NOT NULL,
  claimed_ts BIGINT,
  done_ts BIGINT
);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_user_status ON worker_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);

-- 사용자별 워커 생존 신호. 워커가 주기적으로 heartbeat 를 찍고, 봇은 isOnline(cutoff) 으로
-- "지금 이 사용자의 워커가 떠 있는지" 를 판단한다(라우팅 판단은 W2/W3 몫).
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  user_id TEXT PRIMARY KEY,
  last_ts BIGINT NOT NULL
);

-- 사용자별 허용 폴더(원격 개발 작업 대상). 기존 owner.allowedDirs 단일 settings 키를 대체한다 —
-- 소유자는 지금까지처럼 자신의 userId(config.ownerId) 로 저장/조회되어 동작이 그대로다.
CREATE TABLE IF NOT EXISTS allowed_dirs (
  user_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  PRIMARY KEY (user_id, dir)
);
`;
