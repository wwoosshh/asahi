# 2A 데이터 기반 (스키마 + 마이그레이션 + 리포) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스펙 v2의 정규화 스키마(11개 테이블+인덱스)를 기존 DB에 **덧붙여** 만들고, 관심사별 리포지토리와 1단계 데이터 마이그레이션을 구현한다. 런타임 동작(소유자 DM 대화)은 그대로 유지한다.

**Architecture:** 기존 `agent.db`에 새 테이블을 `CREATE TABLE IF NOT EXISTS`로 추가(기존 events/summaries/settings/Repo는 그대로 두어 앱이 계속 동작). `meta.schema_version` 기반 마이그레이션 러너가 1단계 데이터(events/summaries/settings/마크다운 기억)를 새 테이블로 **멱등** 복사한다. 코어·어댑터는 2A에서 건드리지 않는다(2B에서 새 리포로 전환). 각 리포는 관심사 하나(파일 하나)만 담당한다.

**Tech Stack:** 1단계와 동일 — Node.js 22, TypeScript 5(ESM/NodeNext), better-sqlite3(WAL+FTS5), vitest. 실행 위치는 `agent/`.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-11-multiuser-selfaware-db-design.md`(v2). 이 계획은 §4(데이터 모델)·§13(마이그레이션)만 구현한다.
- ESM: 모든 상대 import에 `.js` 확장자. TypeScript는 5.x(고정됨).
- 앱은 `agent/`에서 실행(cwd=agent). DB 경로는 1단계 그대로 `config.dataDir`(=`../data/store`)의 `agent.db`.
- 2A는 **런타임 동작 무변경**: `src/index.ts`, `src/core/*`, `src/adapters/*`는 수정하지 않는다. 새 코드는 `src/store/`에만 추가하고 유닛 테스트로 검증한다.
- 모든 사용자-노출 텍스트(있다면)는 한국어. 비밀·데이터는 gitignore(기존 유지).
- 프라이버시·능력 규칙(스펙 §6·§7·§12)은 데이터 계층에서 지원만 하고(예: memories.scope, users.role), 실제 게이팅은 2B/2C에서. 단, 리포는 그 규칙을 쉽게 만들도록 스코프별 조회 메서드를 제공한다.

---

### Task 1: 새 스키마 + DB 오픈 확장 + 마이그레이션 러너

**Files:**
- Create: `src/store/schema.ts`
- Modify: `src/store/db.ts` (기존 SCHEMA/processed 마이그레이션 유지 + 새 스키마·버전 러너 추가)
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces:
  - `src/store/schema.ts`: `export const SCHEMA_VERSION = 2;` `export const NEW_SCHEMA: string;`(모든 새 테이블·인덱스 DDL)
  - `db.ts`: `openDb(path)`가 기존 동작 + 새 테이블 생성 + `meta(key,value)` 테이블에 `schema_version` 기록. `export function getSchemaVersion(db): number;` `export function setSchemaVersion(db, v): void;`

- [ ] **Step 1: 실패 테스트 작성** — `tests/schema.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { openDb } from "../src/store/db.js";

function tableNames(db: import("better-sqlite3").Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
}

describe("새 스키마", () => {
  it("새 정규화 테이블이 모두 생성된다", () => {
    const db = openDb(":memory:");
    const names = tableNames(db);
    for (const t of [
      "users", "conversations", "conversation_participants", "messages",
      "memories", "summaries", "logs", "actions", "turns", "backups", "triggers", "meta",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("기존 1단계 테이블도 그대로 있다(덧붙임)", () => {
    const db = openDb(":memory:");
    const names = tableNames(db);
    expect(names).toContain("events");
    expect(names).toContain("settings");
  });

  it("schema_version 이 기록된다", async () => {
    const { getSchemaVersion } = await import("../src/store/db.js");
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(2);
  });

  it("messages FTS 로 한글 접두 검색이 된다", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO conversations (kind, discord_channel_id, primary_user_id, is_private, last_active_ts, status, created_ts) VALUES ('dm','c1','u1',1,1,'active',1)").run();
    db.prepare("INSERT INTO messages (conversation_id, ts, role, user_id, content, processed) VALUES (1,1,'user','u1','병원에 다녀왔다',1)").run();
    const rows = db.prepare(
      `SELECT m.content FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ?`,
    ).all('"병원"*') as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toContain("병원에 다녀왔다");
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- schema` → FAIL(모듈/테이블 없음)

- [ ] **Step 3: 스키마 작성** — `src/store/schema.ts`

```typescript
export const SCHEMA_VERSION = 2;

// 1단계 스키마(events/summaries/settings)는 db.ts 가 계속 생성한다. 여기에는 v2 신규 테이블만.
export const NEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'blocked',
  display_name TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  discord_channel_id TEXT NOT NULL UNIQUE,
  origin_message_id TEXT UNIQUE,
  guild_id TEXT,
  parent_channel_id TEXT,
  primary_user_id TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  first_message_id INTEGER,
  private_memory_loaded INTEGER NOT NULL DEFAULT 0,
  last_active_ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  joined_ts INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_conv ON conversation_participants(conversation_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  user_id TEXT,
  discord_message_id TEXT,
  content TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(processed) WHERE processed = 0;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_conversation_id INTEGER,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, scope);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  from_message_id INTEGER NOT NULL,
  to_message_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_conv ON summaries(conversation_id);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts, level);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  conversation_id INTEGER,
  user_id TEXT,
  tool TEXT NOT NULL,
  input TEXT,
  result_summary TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_actions_conv ON actions(conversation_id, ts);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  conversation_id INTEGER,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
CREATE INDEX IF NOT EXISTS idx_turns_user_ts ON turns(user_id, ts);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  next_run_ts INTEGER,
  target_user_id TEXT,
  target_conversation_id INTEGER,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_next ON triggers(next_run_ts) WHERE status = 'active';
`;
```

- [ ] **Step 4: db.ts 확장** — `src/store/db.ts`의 `openDb` 안 `db.exec(SCHEMA);` 및 processed 마이그레이션 **다음에** 추가하고, 파일 상단 import 및 하단 함수 추가

파일 상단 import에 추가:
```typescript
import { NEW_SCHEMA, SCHEMA_VERSION } from "./schema.js";
```

`openDb` 안, `return db;` **직전**에 삽입:
```typescript
  db.exec(NEW_SCHEMA);
  setSchemaVersion(db, Math.max(getSchemaVersion(db), SCHEMA_VERSION));
```

파일 하단(맨 끝)에 함수 추가:
```typescript
export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function setSchemaVersion(db: Database.Database, v: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(v));
}
```

- [ ] **Step 5: 통과 확인** — Run: `npm test -- schema` → 4 passed. Run: `npx tsc --noEmit` → 오류 없음.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/store/schema.ts agent/src/store/db.ts agent/tests/schema.test.ts
git commit -m "feat(2A): v2 정규화 스키마 덧붙임 + schema_version 러너"
```

---

### Task 2: SettingsRepo (앱 설정 + 스키마 버전 접근)

**Files:**
- Create: `src/store/settingsRepo.ts`
- Test: `tests/settingsRepo.test.ts`

**Interfaces:**
- Consumes: `Database`(better-sqlite3).
- Produces:
```typescript
export class SettingsRepo {
  constructor(db: Database.Database);
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}
```
(기존 1단계 `settings` 테이블을 그대로 사용 — 앱 설정용. meta.schema_version 은 db.ts 함수로 접근하므로 여기 미포함.)

- [ ] **Step 1: 실패 테스트** — `tests/settingsRepo.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";

describe("SettingsRepo", () => {
  let repo: SettingsRepo;
  beforeEach(() => { repo = new SettingsRepo(openDb(":memory:")); });

  it("설정을 저장/조회/삭제한다", () => {
    expect(repo.get("k")).toBeNull();
    repo.set("k", "v1");
    expect(repo.get("k")).toBe("v1");
    repo.set("k", "v2");
    expect(repo.get("k")).toBe("v2");
    repo.delete("k");
    expect(repo.get("k")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- settingsRepo` → FAIL

- [ ] **Step 3: 구현** — `src/store/settingsRepo.ts`

```typescript
import type Database from "better-sqlite3";

export class SettingsRepo {
  constructor(private db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npm test -- settingsRepo` → 1 passed

- [ ] **Step 5: 커밋**

```bash
git add agent/src/store/settingsRepo.ts agent/tests/settingsRepo.test.ts
git commit -m "feat(2A): SettingsRepo (앱 설정 접근)"
```

---

### Task 3: Users · Conversations · Participants 리포

**Files:**
- Create: `src/store/usersRepo.ts`, `src/store/conversationsRepo.ts`, `src/store/participantsRepo.ts`
- Test: `tests/identityRepos.test.ts`

**Interfaces:**
- Consumes: `Database`, `db.ts`(테이블).
- Produces:
```typescript
export type Role = "owner" | "allowed" | "blocked";
export class UsersRepo {
  constructor(db: Database.Database, now?: () => number);
  upsert(id: string, patch: { role?: Role; displayName?: string }): void;
  getRole(id: string): Role;                 // 없으면 "blocked"
  list(role?: Role): Array<{ id: string; role: Role; displayName: string | null }>;
}

export type Conversation = {
  id: number; kind: "dm" | "thread"; discordChannelId: string; originMessageId: string | null;
  guildId: string | null; parentChannelId: string | null; primaryUserId: string; isPrivate: boolean;
  sessionId: string | null; firstMessageId: number | null; privateMemoryLoaded: boolean;
  lastActiveTs: number; status: "active" | "idle" | "closed";
};
export class ConversationsRepo {
  constructor(db: Database.Database);
  create(c: { kind: "dm" | "thread"; discordChannelId: string; originMessageId?: string; guildId?: string; parentChannelId?: string; primaryUserId: string; isPrivate: boolean; lastActiveTs: number }): number;
  getByChannelId(discordChannelId: string): Conversation | null;
  getByOriginMessageId(originMessageId: string): Conversation | null;
  setSession(id: number, sessionId: string | null, lastActiveTs: number): void;
  setPrivateMemoryLoaded(id: number, loaded: boolean): void;
  setStatus(id: number, status: "active" | "idle" | "closed"): void;
  setFirstMessageId(id: number, messageId: number): void;
}

export class ParticipantsRepo {
  constructor(db: Database.Database);
  upsert(conversationId: number, userId: string, joinedTs: number): void;
  count(conversationId: number): number;
  list(conversationId: number): string[];
}
```

- [ ] **Step 1: 실패 테스트** — `tests/identityRepos.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { ParticipantsRepo } from "../src/store/participantsRepo.js";

describe("UsersRepo", () => {
  it("upsert 하고 역할을 조회한다(기본 blocked)", () => {
    const db = openDb(":memory:");
    const users = new UsersRepo(db, () => 1);
    expect(users.getRole("u1")).toBe("blocked");
    users.upsert("u1", { role: "allowed", displayName: "철수" });
    expect(users.getRole("u1")).toBe("allowed");
    users.upsert("u1", { displayName: "철수2" }); // role 유지
    expect(users.getRole("u1")).toBe("allowed");
    expect(users.list("allowed").map((u) => u.id)).toEqual(["u1"]);
  });
});

describe("ConversationsRepo", () => {
  let db: import("better-sqlite3").Database, repo: ConversationsRepo;
  beforeEach(() => { db = openDb(":memory:"); repo = new ConversationsRepo(db); });

  it("생성 후 채널ID로 조회한다", () => {
    const id = repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    const c = repo.getByChannelId("c1")!;
    expect(c.id).toBe(id);
    expect(c.isPrivate).toBe(true);
    expect(c.sessionId).toBeNull();
  });

  it("origin_message_id 로 멱등 조회한다", () => {
    repo.create({ kind: "thread", discordChannelId: "t1", originMessageId: "m1", primaryUserId: "u1", isPrivate: false, lastActiveTs: 10 });
    expect(repo.getByOriginMessageId("m1")!.discordChannelId).toBe("t1");
    expect(repo.getByOriginMessageId("nope")).toBeNull();
  });

  it("세션·상태·기억로드 플래그를 갱신한다", () => {
    const id = repo.create({ kind: "dm", discordChannelId: "c1", primaryUserId: "u1", isPrivate: true, lastActiveTs: 10 });
    repo.setSession(id, "s1", 20);
    repo.setPrivateMemoryLoaded(id, true);
    const c = repo.getByChannelId("c1")!;
    expect(c.sessionId).toBe("s1");
    expect(c.lastActiveTs).toBe(20);
    expect(c.privateMemoryLoaded).toBe(true);
  });
});

describe("ParticipantsRepo", () => {
  it("참여자를 upsert 하고 수를 센다", () => {
    const db = openDb(":memory:");
    const repo = new ParticipantsRepo(db);
    repo.upsert(1, "u1", 1);
    repo.upsert(1, "u1", 2); // 중복 무시
    repo.upsert(1, "u2", 3);
    expect(repo.count(1)).toBe(2);
    expect(repo.list(1).sort()).toEqual(["u1", "u2"]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- identityRepos` → FAIL

- [ ] **Step 3: 구현 (usersRepo.ts)**

```typescript
import type Database from "better-sqlite3";

export type Role = "owner" | "allowed" | "blocked";

export class UsersRepo {
  private now: () => number;
  constructor(private db: Database.Database, now: () => number = Date.now) { this.now = now; }

  upsert(id: string, patch: { role?: Role; displayName?: string }): void {
    const t = this.now();
    this.db.prepare(
      `INSERT INTO users (id, role, display_name, created_ts, updated_ts)
       VALUES (@id, COALESCE(@role,'blocked'), @displayName, @t, @t)
       ON CONFLICT(id) DO UPDATE SET
         role = COALESCE(@role, users.role),
         display_name = COALESCE(@displayName, users.display_name),
         updated_ts = @t`,
    ).run({ id, role: patch.role ?? null, displayName: patch.displayName ?? null, t });
  }

  getRole(id: string): Role {
    const row = this.db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: Role } | undefined;
    return row?.role ?? "blocked";
  }

  list(role?: Role): Array<{ id: string; role: Role; displayName: string | null }> {
    const rows = (role
      ? this.db.prepare("SELECT id, role, display_name FROM users WHERE role = ? ORDER BY id").all(role)
      : this.db.prepare("SELECT id, role, display_name FROM users ORDER BY id").all()) as Array<{ id: string; role: Role; display_name: string | null }>;
    return rows.map((r) => ({ id: r.id, role: r.role, displayName: r.display_name }));
  }
}
```

- [ ] **Step 4: 구현 (conversationsRepo.ts)**

```typescript
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

  getByChannelId(discordChannelId: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE discord_channel_id = ?").get(discordChannelId) as Row | undefined;
    return row ? toConversation(row) : null;
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
```

- [ ] **Step 5: 구현 (participantsRepo.ts)**

```typescript
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
```

- [ ] **Step 6: 통과 확인** — Run: `npm test -- identityRepos` → 5 passed. Run: `npx tsc --noEmit`.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/store/usersRepo.ts agent/src/store/conversationsRepo.ts agent/src/store/participantsRepo.ts agent/tests/identityRepos.test.ts
git commit -m "feat(2A): Users/Conversations/Participants 리포"
```

---

### Task 4: Messages · Summaries 리포

**Files:**
- Create: `src/store/messagesRepo.ts`, `src/store/summariesRepo.ts`
- Test: `tests/messagesRepos.test.ts`

**Interfaces:**
- Consumes: `Database`.
- Produces:
```typescript
export type StoredMessage = { id: number; conversationId: number; ts: number; role: "user" | "assistant" | "system"; userId: string | null; content: string };
export class MessagesRepo {
  constructor(db: Database.Database);
  insert(m: { conversationId: number; ts: number; role: "user" | "assistant" | "system"; userId?: string; discordMessageId?: string; content: string; processed?: boolean }): number;
  recent(conversationId: number, limit: number): StoredMessage[]; // 시간(id)순 오름차순
  search(conversationId: number | null, query: string, limit: number): StoredMessage[]; // FTS 접두, conversationId null 이면 전체
  unprocessedUserMessages(): StoredMessage[];
  markProcessed(id: number): void;
}
export class SummariesRepo {
  constructor(db: Database.Database);
  insert(s: { conversationId: number; fromMessageId: number; toMessageId: number; content: string; createdTs: number }): void;
  recent(conversationId: number, limit: number): string[]; // 최신순
}
```

- [ ] **Step 1: 실패 테스트** — `tests/messagesRepos.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";

describe("MessagesRepo", () => {
  let repo: MessagesRepo;
  beforeEach(() => { repo = new MessagesRepo(openDb(":memory:")); });

  it("대화별 최근 메시지를 시간순으로 준다", () => {
    repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "첫" });
    repo.insert({ conversationId: 1, ts: 2, role: "assistant", content: "둘" });
    repo.insert({ conversationId: 2, ts: 3, role: "user", userId: "u2", content: "다른대화" });
    const m = repo.recent(1, 10);
    expect(m.map((x) => x.content)).toEqual(["첫", "둘"]);
  });

  it("FTS 접두 검색(대화 한정/전체)", () => {
    repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "병원에 다녀왔다" });
    repo.insert({ conversationId: 2, ts: 2, role: "user", userId: "u2", content: "병원 예약" });
    expect(repo.search(1, "병원", 10).map((x) => x.content)).toEqual(["병원에 다녀왔다"]);
    expect(repo.search(null, "병원", 10)).toHaveLength(2);
    expect(() => repo.search(null, "병원?", 10)).not.toThrow();
  });

  it("미처리 user 메시지 조회/완료표시", () => {
    const id = repo.insert({ conversationId: 1, ts: 1, role: "user", userId: "u1", content: "a", processed: false });
    repo.insert({ conversationId: 1, ts: 2, role: "user", userId: "u1", content: "b" });
    expect(repo.unprocessedUserMessages().map((x) => x.id)).toEqual([id]);
    repo.markProcessed(id);
    expect(repo.unprocessedUserMessages()).toHaveLength(0);
  });
});

describe("SummariesRepo", () => {
  it("대화별 요약을 최신순으로 준다", () => {
    const repo = new SummariesRepo(openDb(":memory:"));
    repo.insert({ conversationId: 1, fromMessageId: 1, toMessageId: 2, content: "A", createdTs: 1 });
    repo.insert({ conversationId: 1, fromMessageId: 3, toMessageId: 4, content: "B", createdTs: 2 });
    repo.insert({ conversationId: 2, fromMessageId: 5, toMessageId: 6, content: "C", createdTs: 3 });
    expect(repo.recent(1, 5)).toEqual(["B", "A"]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- messagesRepos` → FAIL

- [ ] **Step 3: 구현 (messagesRepo.ts)**

```typescript
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
```

- [ ] **Step 4: 구현 (summariesRepo.ts)**

```typescript
import type Database from "better-sqlite3";

export class SummariesRepo {
  constructor(private db: Database.Database) {}

  insert(s: { conversationId: number; fromMessageId: number; toMessageId: number; content: string; createdTs: number }): void {
    this.db.prepare(
      "INSERT INTO summaries (conversation_id, from_message_id, to_message_id, content, created_ts) VALUES (?, ?, ?, ?, ?)",
    ).run(s.conversationId, s.fromMessageId, s.toMessageId, s.content, s.createdTs);
  }

  recent(conversationId: number, limit: number): string[] {
    const rows = this.db.prepare("SELECT content FROM summaries WHERE conversation_id = ? ORDER BY id DESC LIMIT ?").all(conversationId, limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }
}
```

- [ ] **Step 5: 통과 확인** — Run: `npm test -- messagesRepos` → 4 passed. `npx tsc --noEmit`.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/store/messagesRepo.ts agent/src/store/summariesRepo.ts agent/tests/messagesRepos.test.ts
git commit -m "feat(2A): Messages/Summaries 리포 (FTS 접두검색·미처리)"
```

---

### Task 5: MemoriesRepo (프라이버시 스코프 조회)

**Files:**
- Create: `src/store/memoriesRepo.ts`
- Test: `tests/memoriesRepo.test.ts`

**Interfaces:**
- Consumes: `Database`.
- Produces:
```typescript
export type Memory = { id: number; userId: string; scope: "user" | "shared"; title: string; content: string };
export class MemoriesRepo {
  constructor(db: Database.Database, now?: () => number);
  insert(m: { userId: string; scope: "user" | "shared"; title: string; content: string; sourceConversationId?: number }): number;
  forUser(userId: string): Memory[];   // 그 사용자의 user 기억 + 모든 shared (DM 컨텍스트 주입용)
  sharedOnly(): Memory[];              // shared 만 (서버 컨텍스트 주입용)
  all(): Memory[];                     // 전원 (소유자 DM 전용 recall)
  searchForUser(userId: string, query: string): Memory[]; // title/content LIKE, user+shared
  update(id: number, patch: { title?: string; content?: string }): void;
  delete(id: number): void;
}
```

- [ ] **Step 1: 실패 테스트** — `tests/memoriesRepo.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";

describe("MemoriesRepo", () => {
  let repo: MemoriesRepo;
  beforeEach(() => {
    repo = new MemoriesRepo(openDb(":memory:"), () => 1);
    repo.insert({ userId: "owner", scope: "user", title: "고양이", content: "고양이 두 마리" });
    repo.insert({ userId: "bob", scope: "user", title: "밥선호", content: "매운 것 좋아함" });
    repo.insert({ userId: "owner", scope: "shared", title: "서버규칙", content: "존댓말 사용" });
  });

  it("forUser 는 그 사용자 user 기억 + 전체 shared 만 준다(타인 user 제외)", () => {
    const titles = repo.forUser("owner").map((m) => m.title).sort();
    expect(titles).toEqual(["고양이", "서버규칙"]);
    const bob = repo.forUser("bob").map((m) => m.title).sort();
    expect(bob).toEqual(["밥선호", "서버규칙"]); // bob 의 user + shared, owner 의 user(고양이) 제외
  });

  it("sharedOnly 는 shared 만(개인기억 없음)", () => {
    expect(repo.sharedOnly().map((m) => m.title)).toEqual(["서버규칙"]);
  });

  it("all 은 전원(소유자 recall 용)", () => {
    expect(repo.all()).toHaveLength(3);
  });

  it("검색·수정·삭제", () => {
    const hits = repo.searchForUser("owner", "고양이");
    expect(hits).toHaveLength(1);
    repo.update(hits[0].id, { content: "고양이 세 마리" });
    expect(repo.searchForUser("owner", "고양이")[0].content).toBe("고양이 세 마리");
    repo.delete(hits[0].id);
    expect(repo.searchForUser("owner", "고양이")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- memoriesRepo` → FAIL

- [ ] **Step 3: 구현** — `src/store/memoriesRepo.ts`

```typescript
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
```

- [ ] **Step 4: 통과 확인** — Run: `npm test -- memoriesRepo` → 4 passed. `npx tsc --noEmit`.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/store/memoriesRepo.ts agent/tests/memoriesRepo.test.ts
git commit -m "feat(2A): MemoriesRepo (프라이버시 스코프 조회: forUser/sharedOnly/all)"
```

---

### Task 6: TurnsRepo (원자적 한도 예약)

**Files:**
- Create: `src/store/turnsRepo.ts`
- Test: `tests/turnsRepo.test.ts`

**Interfaces:**
- Consumes: `Database`.
- Produces:
```typescript
export class TurnsRepo {
  constructor(db: Database.Database);
  // 한도 검사 + 예약 삽입을 하나의 트랜잭션으로. 초과면 롤백하고 false.
  reserve(o: { userId: string | null; conversationId: number | null; kind: "message" | "summary" | "proactive"; ts: number; perUserLimit: number; globalLimit: number; ownerReserve: number; isOwner: boolean; windowMs: number }): boolean;
  countUser(userId: string, sinceTs: number): number;
  countGlobal(sinceTs: number): number;
}
```
규칙: 최근 `windowMs` 창에서 유저 카운트 ≥ perUserLimit 이면 거부. 전역은 손님의 경우 `globalLimit - ownerReserve` 를 상한으로(소유자 예약분 보호), 소유자는 `globalLimit` 상한. 통과 시 turns 1행 삽입 후 true.

- [ ] **Step 1: 실패 테스트** — `tests/turnsRepo.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";

const HOUR = 60 * 60 * 1000;
function opts(over: Partial<Parameters<TurnsRepo["reserve"]>[0]> = {}) {
  return { userId: "u1", conversationId: 1, kind: "message" as const, ts: 1_000_000, perUserLimit: 2, globalLimit: 10, ownerReserve: 2, isOwner: false, windowMs: HOUR, ...over };
}

describe("TurnsRepo.reserve", () => {
  let repo: TurnsRepo;
  beforeEach(() => { repo = new TurnsRepo(openDb(":memory:")); });

  it("유저 한도 안에서는 예약 성공, 넘으면 거부", () => {
    expect(repo.reserve(opts())).toBe(true);
    expect(repo.reserve(opts({ ts: 1_000_001 }))).toBe(true);
    expect(repo.reserve(opts({ ts: 1_000_002 }))).toBe(false); // perUserLimit=2 초과
    expect(repo.countUser("u1", 1_000_000 - HOUR)).toBe(2);     // 거부된 건은 미기록
  });

  it("손님 전역 상한은 globalLimit-ownerReserve, 소유자는 예약분 접근 가능", () => {
    // globalLimit=3, ownerReserve=1 → 손님은 2까지
    for (let i = 0; i < 2; i++) expect(repo.reserve(opts({ userId: `g${i}`, perUserLimit: 99, globalLimit: 3, ownerReserve: 1, ts: 1_000_000 + i }))).toBe(true);
    expect(repo.reserve(opts({ userId: "g9", perUserLimit: 99, globalLimit: 3, ownerReserve: 1, ts: 1_000_010 }))).toBe(false); // 손님 상한(2) 도달
    // 소유자는 예약분까지(전역 3) 접근 → 성공
    expect(repo.reserve(opts({ userId: "owner", isOwner: true, perUserLimit: 99, globalLimit: 3, ownerReserve: 1, ts: 1_000_011 }))).toBe(true);
  });

  it("윈도우 밖 오래된 턴은 카운트에서 제외", () => {
    repo.reserve(opts({ ts: 0 })); // 아주 오래 전
    expect(repo.reserve(opts({ ts: 1_000_000 }))).toBe(true);
    expect(repo.reserve(opts({ ts: 1_000_001 }))).toBe(true); // 옛것은 창 밖이라 2건만 셈 → 통과
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- turnsRepo` → FAIL

- [ ] **Step 3: 구현** — `src/store/turnsRepo.ts`

```typescript
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
```

- [ ] **Step 4: 통과 확인** — Run: `npm test -- turnsRepo` → 3 passed. `npx tsc --noEmit`.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/store/turnsRepo.ts agent/tests/turnsRepo.test.ts
git commit -m "feat(2A): TurnsRepo (원자적 한도 예약 + 소유자 예약분)"
```

---

### Task 7: 1단계 → v2 데이터 마이그레이션

**Files:**
- Create: `src/store/migrate.ts`
- Modify: `src/store/db.ts` (openDb 끝에서 migrate 호출)
- Test: `tests/migrate.test.ts`

**Interfaces:**
- Consumes: 위 리포들, `Database`.
- Produces:
```typescript
// ownerId 는 config.ownerId. memoryDir 는 config.memoryDir(마크다운 기억). 둘 다 옵션(없으면 그 단계 생략).
export function migrateFromPhase1(db: Database.Database, opts: { ownerId?: string; memoryDir?: string }): void; // 멱등
```
동작(스펙 §13): 이미 마이그레이션됐으면(meta.migrated_v2='1') 아무것도 안 함. 아니면:
1. ownerId 있으면 users(role='owner') upsert.
2. events 가 있고 messages 가 비었으면: owner dm conversations 1건 생성(discord_channel_id='legacy-owner-dm', is_private=1), events → messages 복사(user_message→role='user'·user_id=owner, assistant_message→'assistant', system_notice→'system'; processed 보존). settings 의 session.* → 그 conversation 세션.
3. summaries(1단계) → 새 summaries(그 conversation, from/to 는 0 로).
4. memoryDir/MEMORY.md 및 *.md → memories(user_id=owner, **scope='user'**)로 임포트(파일당 1건, title=파일명, content=본문). shared 승격 없음.
5. meta.migrated_v2='1'.

- [ ] **Step 1: 실패 테스트** — `tests/migrate.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/store/db.js";
import { migrateFromPhase1 } from "../src/store/migrate.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";

function seedPhase1(db: import("better-sqlite3").Database) {
  db.prepare("INSERT INTO events (ts, type, channel, channel_ref, content, processed) VALUES (1,'user_message','discord','c1','안녕',1)").run();
  db.prepare("INSERT INTO events (ts, type, channel, channel_ref, content, processed) VALUES (2,'assistant_message','discord','c1','안녕하세요',1)").run();
  db.prepare("INSERT INTO summaries (created_ts, from_event_id, to_event_id, content) VALUES (3,1,2,'인사 나눔')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('session.id','sX')").run();
}

describe("migrateFromPhase1", () => {
  it("events/summaries/설정을 새 스키마로 옮긴다", () => {
    const db = openDb(":memory:");
    seedPhase1(db);
    migrateFromPhase1(db, { ownerId: "owner" });
    expect(new UsersRepo(db).getRole("owner")).toBe("owner");
    const conv = new ConversationsRepo(db).getByChannelId("legacy-owner-dm")!;
    expect(conv.isPrivate).toBe(true);
    expect(conv.sessionId).toBe("sX");
    const msgs = new MessagesRepo(db).recent(conv.id, 10);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([["user", "안녕"], ["assistant", "안녕하세요"]]);
    expect(msgs[0].userId).toBe("owner");
  });

  it("마크다운 기억을 scope='user'(owner)로 임포트한다", () => {
    const db = openDb(":memory:");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# 인덱스\n- 고양이");
    fs.writeFileSync(path.join(dir, "cat.md"), "고양이 두 마리를 키운다");
    migrateFromPhase1(db, { ownerId: "owner", memoryDir: dir });
    const mems = new MemoriesRepo(db).all();
    expect(mems.length).toBeGreaterThanOrEqual(2);
    expect(mems.every((m) => m.userId === "owner" && m.scope === "user")).toBe(true);
    expect(mems.some((m) => m.content.includes("고양이 두 마리"))).toBe(true);
  });

  it("멱등: 두 번 호출해도 중복 안 생김", () => {
    const db = openDb(":memory:");
    seedPhase1(db);
    migrateFromPhase1(db, { ownerId: "owner" });
    migrateFromPhase1(db, { ownerId: "owner" });
    const conv = new ConversationsRepo(db).getByChannelId("legacy-owner-dm")!;
    expect(new MessagesRepo(db).recent(conv.id, 10)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- migrate` → FAIL

- [ ] **Step 3: 구현** — `src/store/migrate.ts`

```typescript
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
```

- [ ] **Step 4: db.ts 에서 호출** — `src/store/db.ts`의 `openDb`는 config를 모르므로, migrate는 **여기서 자동 호출하지 않는다**(2B의 index.ts 배선에서 config와 함께 호출). 대신 `openDb`가 새 스키마까지 만든 뒤 반환하는 현 상태를 유지. (이 스텝은 "호출 위치 문서화"만 — 코드 변경 없음. migrate는 테스트에서 직접 호출.)

> 메모: 2B에서 `index.ts`에 `migrateFromPhase1(db, { ownerId: config.ownerId, memoryDir: config.memoryDir })`를 openDb 직후 1회 호출한다.

- [ ] **Step 5: 통과 확인** — Run: `npm test -- migrate` → 3 passed. 전체: `npm test && npx tsc --noEmit` → 전부 통과.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/store/migrate.ts agent/tests/migrate.test.ts
git commit -m "feat(2A): 1단계→v2 데이터 마이그레이션 (멱등, 마크다운 기억은 scope=user)"
```

---

## 완료 기준 (2A Definition of Done)

1. `npm test` 전체 통과, `npx tsc --noEmit` 오류 없음.
2. `openDb`가 기존 1단계 테이블 + v2 신규 11개 테이블·인덱스를 만들고 `schema_version=2` 기록.
3. 8개 리포(Settings/Users/Conversations/Participants/Messages/Summaries/Memories/Turns)가 각자 유닛 테스트로 검증됨.
4. `MemoriesRepo.forUser/sharedOnly/all` 로 프라이버시 스코프 조회 가능(2B 주입 규칙의 토대).
5. `TurnsRepo.reserve` 가 원자적으로 유저별·전역(소유자 예약분) 한도를 강제.
6. `migrateFromPhase1` 가 1단계 데이터(events/summaries/settings/마크다운)를 새 스키마로 멱등 이전, 마크다운 기억은 scope='user'(owner).
7. 런타임(index/core/adapter) 무변경 — 앱은 1단계처럼 계속 동작.
