# 1단계: 코어 + SQLite/메모리 + 디스코드 봇 + PM2 상시구동 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 디스코드로 대화하면 기억(SQLite + 마크다운)이 이어지는 상주형 AI 비서의 최소 완성본을 만들고 PM2로 상시 구동한다.

**Architecture:** 단일 Node.js 데몬. 디스코드 어댑터가 메시지를 이벤트 버스에 발행하면, 에이전트 코어가 큐로 직렬 처리하며 Claude Agent SDK 세션을 실행한다. 유휴 시간 내에는 세션을 resume으로 이어가고, 새 세션 시작 시 SQLite의 최근 대화/요약과 `memory/` 마크다운 인덱스를 재주입해 기억 연속성을 만든다.

**Tech Stack:** Node.js 22 LTS, TypeScript 5 (ESM/NodeNext), `@anthropic-ai/claude-agent-sdk`, discord.js v14, better-sqlite3 (WAL+FTS5), vitest, PM2.

## 프로젝트 폴더 구조 (2026-07-11 갱신)

루트를 깨끗하게 유지하기 위해, 아래 태스크들의 코드 블록에 나오는 파일은 **리포 루트가 아니라 `agent/` 아래**에 만든다. 런타임 데이터와 운영 설정도 분리한다.

| 계획 문서의 표기 위치 | 실제 생성 위치 |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/…`, `tests/…`, `.env` | `agent/` 아래 |
| `store/agent.db` (SQLite) | `data/store/agent.db` |
| `memory/` (마크다운 기억) | `data/memory/` |
| `ecosystem.config.cjs` | `deploy/ecosystem.config.cjs` |
| `.gitignore`, `README.md` | 리포 루트 |

- `config.ts`의 기본 경로는 `dataDir = ../data/store`, `memoryDir = ../data/memory` (cwd=`agent/` 기준).
- PM2는 `cwd: agent/`로 구동하므로 앱 내부 상대 경로(`src`, `dist`, `../data`)가 그대로 성립한다.
- 테스트의 import 경로(`../src/…`)는 `src`와 `tests`가 함께 `agent/`로 이동하므로 계획서 그대로 유효하다.

## Global Constraints

- 스펙 문서: `docs/superpowers/specs/2026-07-11-pc-ai-assistant-design.md` — 이 계획은 스펙 12장 로드맵의 1단계만 구현한다.
- LLM 인증: Claude Pro/Max 구독 (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` 환경변수, 또는 Claude Code CLI 로그인). API 키 코드 경로 없음.
- ESM 프로젝트: `package.json`에 `"type": "module"`, tsconfig `module: "NodeNext"`. **모든 상대 import는 `.js` 확장자를 붙인다** (예: `import { EventBus } from "../events/bus.js"`).
- 비밀값(`DISCORD_TOKEN` 등)은 `.env`로만 관리하고 절대 커밋하지 않는다. `store/`(DB)와 `memory/`(개인 기억)도 gitignore.
- 유휴 시 LLM 호출 금지(이벤트 기반). 시간당 턴 수 상한(`MAX_TURNS_PER_HOUR`, 기본 30)으로 구독 한도 보호.
- 에이전트 도구는 1단계에서 `Read, Write, Edit, Glob, Grep`만 허용, `permissionMode: "dontAsk"` (그 외 도구 전부 거부). Bash·웹·브라우저는 2단계에서 개방.
- 모든 사용자-노출 텍스트(오류 알림 등)는 한국어.

---

### Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `tests/sanity.test.ts`

**Interfaces:**
- Produces: 이후 모든 태스크가 사용하는 빌드/테스트 환경. `npm test`(vitest), `npm run build`(tsc), `npm run dev`(tsx).

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "resident-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: 의존성 설치**

```bash
npm install @anthropic-ai/claude-agent-sdk discord.js better-sqlite3 dotenv
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 3: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: vitest.config.ts 작성**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: .gitignore 작성**

```
node_modules/
dist/
.env
store/
memory/
*.log
```

- [ ] **Step 6: .env.example 작성**

```
# 디스코드 봇 토큰 (Discord Developer Portal > Bot)
DISCORD_TOKEN=
# 소유자(본인)의 디스코드 사용자 ID — 이 사람의 메시지에만 반응
DISCORD_OWNER_ID=
# (선택) DM 외에 반응할 서버 채널 ID
DISCORD_CHANNEL_ID=
# (선택) claude setup-token 으로 발급한 구독 OAuth 토큰
CLAUDE_CODE_OAUTH_TOKEN=
# (선택) 세션 유휴 종료 시간(분), 기본 30
SESSION_IDLE_MINUTES=
# (선택) 시간당 최대 턴 수(구독 한도 보호), 기본 30
MAX_TURNS_PER_HOUR=
```

- [ ] **Step 7: 새니티 테스트 작성** — `tests/sanity.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("vitest가 동작한다", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: 검증 실행**

Run: `npm test`
Expected: `1 passed`

Run: `npx tsc --noEmit`
Expected: 오류 없음 (src가 비어 있어도 통과)

- [ ] **Step 9: 커밋**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example tests/sanity.test.ts
git commit -m "chore: 1단계 프로젝트 스캐폴딩 (TypeScript ESM + vitest)"
```

---

### Task 2: 설정 로더 (config)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` — 이후 모든 태스크가 `Config` 타입을 사용.

```typescript
export type Config = {
  discordToken: string;
  ownerId: string;
  channelId?: string;      // 선택: DM 외 반응할 서버 채널
  dataDir: string;         // SQLite 폴더 (기본 <cwd>/store)
  memoryDir: string;       // 마크다운 기억 폴더 (기본 <cwd>/memory)
  sessionIdleMinutes: number; // 기본 30
  maxTurnsPerHour: number;    // 기본 30
};
```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/config.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DISCORD_TOKEN: "tok", DISCORD_OWNER_ID: "123" };

describe("loadConfig", () => {
  it("필수값이 있으면 기본값과 함께 로드된다", () => {
    const c = loadConfig(base);
    expect(c.discordToken).toBe("tok");
    expect(c.ownerId).toBe("123");
    expect(c.channelId).toBeUndefined();
    expect(c.sessionIdleMinutes).toBe(30);
    expect(c.maxTurnsPerHour).toBe(30);
    expect(c.dataDir.endsWith("store")).toBe(true);
    expect(c.memoryDir.endsWith("memory")).toBe(true);
  });

  it("선택값을 덮어쓸 수 있다", () => {
    const c = loadConfig({ ...base, DISCORD_CHANNEL_ID: "ch1", SESSION_IDLE_MINUTES: "10", MAX_TURNS_PER_HOUR: "5" });
    expect(c.channelId).toBe("ch1");
    expect(c.sessionIdleMinutes).toBe(10);
    expect(c.maxTurnsPerHour).toBe(5);
  });

  it("필수값이 없으면 무엇이 빠졌는지 알려주며 실패한다", () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- config`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: 구현** — `src/config.ts`

```typescript
import path from "node:path";

export type Config = {
  discordToken: string;
  ownerId: string;
  channelId?: string;
  dataDir: string;
  memoryDir: string;
  sessionIdleMinutes: number;
  maxTurnsPerHour: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["DISCORD_TOKEN", "DISCORD_OWNER_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  return {
    discordToken: env.DISCORD_TOKEN as string,
    ownerId: env.DISCORD_OWNER_ID as string,
    channelId: env.DISCORD_CHANNEL_ID || undefined,
    dataDir: env.DATA_DIR || path.resolve("store"),
    memoryDir: env.MEMORY_DIR || path.resolve("memory"),
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 30),
    maxTurnsPerHour: Number(env.MAX_TURNS_PER_HOUR || 30),
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- config`
Expected: 3 passed

- [ ] **Step 5: 커밋**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: 환경변수 기반 설정 로더"
```

---

### Task 3: 이벤트 버스

**Files:**
- Create: `src/events/bus.ts`
- Test: `tests/bus.test.ts`

**Interfaces:**
- Produces: 아래 타입과 클래스. 코어·어댑터가 모두 이것으로 통신한다.

```typescript
export type ChannelKind = "discord";
export type UserMessageEvent = { type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AssistantMessageEvent = { type: "assistant_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type SystemNoticeEvent = { type: "system_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AgentEvent = UserMessageEvent | AssistantMessageEvent | SystemNoticeEvent;

export class EventBus {
  subscribe<T extends AgentEvent["type"]>(type: T, handler: (e: Extract<AgentEvent, { type: T }>) => void | Promise<void>): void;
  publish(event: AgentEvent): void; // 핸들러 예외/거부는 콘솔 로깅만 하고 전파하지 않음
}
```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/bus.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { EventBus, type UserMessageEvent } from "../src/events/bus.js";

const msg: UserMessageEvent = { type: "user_message", channel: "discord", channelRef: "c1", text: "hi", ts: 1 };

describe("EventBus", () => {
  it("구독한 타입의 이벤트만 받는다", () => {
    const bus = new EventBus();
    const onUser = vi.fn();
    const onAssistant = vi.fn();
    bus.subscribe("user_message", onUser);
    bus.subscribe("assistant_message", onAssistant);
    bus.publish(msg);
    expect(onUser).toHaveBeenCalledWith(msg);
    expect(onAssistant).not.toHaveBeenCalled();
  });

  it("한 핸들러의 예외가 다른 핸들러를 막지 않는다", () => {
    const bus = new EventBus();
    const second = vi.fn();
    bus.subscribe("user_message", () => { throw new Error("boom"); });
    bus.subscribe("user_message", second);
    expect(() => bus.publish(msg)).not.toThrow();
    expect(second).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- bus`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/events/bus.ts`

```typescript
export type ChannelKind = "discord";

export type UserMessageEvent = { type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AssistantMessageEvent = { type: "assistant_message"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type SystemNoticeEvent = { type: "system_notice"; channel: ChannelKind; channelRef: string; text: string; ts: number };
export type AgentEvent = UserMessageEvent | AssistantMessageEvent | SystemNoticeEvent;

type Handler = (e: AgentEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<AgentEvent["type"], Handler[]>();

  subscribe<T extends AgentEvent["type"]>(
    type: T,
    handler: (e: Extract<AgentEvent, { type: T }>) => void | Promise<void>,
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as Handler);
    this.handlers.set(type, list);
  }

  publish(event: AgentEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[bus] 핸들러 오류 (${event.type}):`, err));
        }
      } catch (err) {
        console.error(`[bus] 핸들러 오류 (${event.type}):`, err);
      }
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- bus`
Expected: 2 passed

- [ ] **Step 5: 커밋**

```bash
git add src/events/bus.ts tests/bus.test.ts
git commit -m "feat: 타입 안전 이벤트 버스"
```

---

### Task 4: SQLite 저장 계층 (store)

**Files:**
- Create: `src/store/db.ts`, `src/store/repo.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: 없음 (최하위 계층)
- Produces:

```typescript
// db.ts
export function openDb(dbPath: string): Database; // WAL 모드 + 스키마 생성. ":memory:" 지원(테스트용)

// repo.ts
export type StoredEvent = { id: number; ts: number; type: string; channel: string | null; channelRef: string | null; content: string };
export class Repo {
  constructor(db: Database);
  insertEvent(e: { ts: number; type: string; channel?: string; channelRef?: string; content: string }): number; // 반환: rowid
  recentEvents(limit: number): StoredEvent[];           // 시간순 오름차순
  searchEvents(query: string, limit: number): StoredEvent[]; // FTS5 전문 검색
  insertSummary(s: { createdTs: number; fromEventId: number; toEventId: number; content: string }): void;
  recentSummaries(limit: number): string[];             // 최신순
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
}
```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/store.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

describe("Repo", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = new Repo(openDb(":memory:"));
  });

  it("이벤트를 저장하고 시간순으로 조회한다", () => {
    repo.insertEvent({ ts: 1, type: "user_message", channel: "discord", channelRef: "c1", content: "첫번째" });
    repo.insertEvent({ ts: 2, type: "assistant_message", channel: "discord", channelRef: "c1", content: "두번째" });
    const events = repo.recentEvents(10);
    expect(events).toHaveLength(2);
    expect(events[0].content).toBe("첫번째");
    expect(events[1].content).toBe("두번째");
  });

  it("recentEvents는 최근 N개를 시간순으로 반환한다", () => {
    for (let i = 1; i <= 5; i++) {
      repo.insertEvent({ ts: i, type: "user_message", content: `msg${i}` });
    }
    const events = repo.recentEvents(2);
    expect(events.map((e) => e.content)).toEqual(["msg4", "msg5"]);
  });

  it("FTS로 내용을 검색한다", () => {
    repo.insertEvent({ ts: 1, type: "user_message", content: "내일 병원 예약 잊지마" });
    repo.insertEvent({ ts: 2, type: "user_message", content: "저녁 메뉴 추천해줘" });
    const hits = repo.searchEvents("병원", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("병원");
  });

  it("요약을 저장하고 최신순으로 읽는다", () => {
    repo.insertSummary({ createdTs: 1, fromEventId: 1, toEventId: 2, content: "요약A" });
    repo.insertSummary({ createdTs: 2, fromEventId: 3, toEventId: 4, content: "요약B" });
    expect(repo.recentSummaries(2)).toEqual(["요약B", "요약A"]);
  });

  it("설정을 저장/조회/삭제한다", () => {
    expect(repo.getSetting("session.id")).toBeNull();
    repo.setSetting("session.id", "abc");
    expect(repo.getSetting("session.id")).toBe("abc");
    repo.setSetting("session.id", "def");
    expect(repo.getSetting("session.id")).toBe("def");
    repo.deleteSetting("session.id");
    expect(repo.getSetting("session.id")).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- store`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현 (db.ts)** — `src/store/db.ts`

```typescript
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

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
  return db;
}
```

- [ ] **Step 4: 구현 (repo.ts)** — `src/store/repo.ts`

```typescript
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

  insertEvent(e: { ts: number; type: string; channel?: string; channelRef?: string; content: string }): number {
    const result = this.db
      .prepare("INSERT INTO events (ts, type, channel, channel_ref, content) VALUES (?, ?, ?, ?, ?)")
      .run(e.ts, e.type, e.channel ?? null, e.channelRef ?? null, e.content);
    return Number(result.lastInsertRowid);
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
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test -- store`
Expected: 5 passed

- [ ] **Step 6: 커밋**

```bash
git add src/store/db.ts src/store/repo.ts tests/store.test.ts
git commit -m "feat: SQLite 저장 계층 (WAL + FTS5 + 요약/설정)"
```

---

### Task 5: 마크다운 메모리 부트스트랩

**Files:**
- Create: `src/memory/memory.ts`
- Test: `tests/memory.test.ts`

**Interfaces:**
- Produces:

```typescript
export function ensureMemoryDir(memoryDir: string): void;      // 폴더와 MEMORY.md가 없으면 생성
export function readMemoryIndex(memoryDir: string): string;    // MEMORY.md 내용 반환 (없으면 생성 후 반환)
```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/memory.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMemoryDir, readMemoryIndex } from "../src/memory/memory.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-"));
}

describe("memory", () => {
  it("폴더와 MEMORY.md를 부트스트랩한다", () => {
    const dir = path.join(tmpDir(), "memory");
    ensureMemoryDir(dir);
    expect(fs.existsSync(path.join(dir, "MEMORY.md"))).toBe(true);
  });

  it("이미 있는 MEMORY.md는 덮어쓰지 않는다", () => {
    const dir = path.join(tmpDir(), "memory");
    ensureMemoryDir(dir);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# 내 기억\n- 중요한 것");
    ensureMemoryDir(dir);
    expect(readMemoryIndex(dir)).toContain("중요한 것");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- memory`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/memory/memory.ts`

```typescript
import fs from "node:fs";
import path from "node:path";

const STARTER = `# 기억 인덱스

여기는 비서의 장기 기억 목차입니다. 기억 파일 하나를 만들 때마다 아래에 한 줄 요약을 추가하세요.

- (아직 기억 없음)
`;

export function ensureMemoryDir(memoryDir: string): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const indexPath = path.join(memoryDir, "MEMORY.md");
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, STARTER, "utf8");
  }
}

export function readMemoryIndex(memoryDir: string): string {
  ensureMemoryDir(memoryDir);
  return fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8");
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- memory`
Expected: 2 passed

- [ ] **Step 5: 커밋**

```bash
git add src/memory/memory.ts tests/memory.test.ts
git commit -m "feat: 마크다운 메모리 폴더 부트스트랩"
```

---

### Task 6: Agent SDK 래퍼 + 페르소나

**Files:**
- Create: `src/core/agent.ts`, `src/core/persona.ts`

**Interfaces:**
- Consumes: 없음 (SDK 직접 사용)
- Produces: 코어(Task 7)가 주입받아 쓰는 실행 함수 타입과 구현.

```typescript
// agent.ts
export type TurnRequest = { prompt: string; systemPrompt: string; resume?: string; cwd: string };
export type TurnResult = { text: string; sessionId?: string; ok: boolean };
export type TurnRunner = (req: TurnRequest) => Promise<TurnResult>;
export const runAgentTurn: TurnRunner;

// persona.ts
export function buildSystemPrompt(memoryDir: string): string;
```

참고: 이 태스크는 외부 SDK 호출 글루 코드라 단위 테스트를 두지 않는다. 코어 테스트(Task 7)는 `TurnRunner`를 가짜로 주입하고, 실제 SDK 경로는 Task 9의 스모크 테스트로 검증한다.

- [ ] **Step 1: 구현 (persona.ts)** — `src/core/persona.ts`

```typescript
export function buildSystemPrompt(memoryDir: string): string {
  return `당신은 사용자의 PC에 상주하는 개인 AI 비서입니다. 유능하고 친근한 매니저처럼 행동하세요.

## 기본 규칙
- 항상 한국어로 대답합니다.
- 응답은 디스코드 메시지로 전달됩니다. 간결하게 쓰고, 표나 복잡한 마크다운은 피하세요.
- 모르는 것은 모른다고 말하고, 추측일 때는 추측임을 밝힙니다.

## 기억 관리 (중요)
- 당신의 장기 기억은 ${memoryDir} 폴더의 마크다운 파일입니다.
- 대화 중 오래 기억할 가치가 있는 것(사용자에 대한 사실, 선호, 결정, 진행 중인 일)을 알게 되면
  ${memoryDir}에 파일 하나(기억 하나)로 저장하고, ${memoryDir}/MEMORY.md 인덱스에 한 줄 요약을 추가하세요.
- 이미 있는 기억과 겹치면 새 파일 대신 기존 파일을 갱신하세요. 틀린 기억은 삭제하세요.
- 사소한 것(인사, 일회성 질문)은 저장하지 마세요.

## 컨텍스트
- 새 세션이 시작되면 프롬프트 앞에 [기억 컨텍스트] 블록으로 기억 인덱스, 이전 대화 요약, 최근 대화가 주어집니다.
- 이 컨텍스트를 바탕으로 대화가 이어지는 것처럼 자연스럽게 응답하세요.`;
}
```

- [ ] **Step 2: 구현 (agent.ts)** — `src/core/agent.ts`

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

export type TurnRequest = { prompt: string; systemPrompt: string; resume?: string; cwd: string };
export type TurnResult = { text: string; sessionId?: string; ok: boolean };
export type TurnRunner = (req: TurnRequest) => Promise<TurnResult>;

export const runAgentTurn: TurnRunner = async (req) => {
  let sessionId: string | undefined;
  let text = "";
  let ok = false;

  for await (const message of query({
    prompt: req.prompt,
    options: {
      cwd: req.cwd,
      systemPrompt: req.systemPrompt,
      resume: req.resume,
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
      permissionMode: "dontAsk",
      maxTurns: 30,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type === "result") {
      sessionId = message.session_id ?? sessionId;
      if (message.subtype === "success") {
        text = message.result;
        ok = true;
      } else {
        text = `(에이전트 오류: ${message.subtype})`;
        ok = false;
      }
    }
  }

  return { text, sessionId, ok };
};
```

- [ ] **Step 3: 타입 검증**

Run: `npx tsc --noEmit`
Expected: 오류 없음. (SDK 타입과 필드명이 다르면 여기서 잡힌다 — 오류 메시지에 맞춰 필드명을 수정할 것)

- [ ] **Step 4: 커밋**

```bash
git add src/core/agent.ts src/core/persona.ts
git commit -m "feat: Agent SDK 래퍼와 비서 페르소나"
```

---

### Task 7: 에이전트 코어 (큐 + 세션 수명주기 + 기억 재주입)

**Files:**
- Create: `src/core/core.ts`
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: `EventBus`(Task 3), `Repo`(Task 4), `readMemoryIndex`(Task 5), `TurnRunner`·`buildSystemPrompt`(Task 6), `Config`(Task 2)
- Produces:

```typescript
export class AgentCore {
  constructor(deps: {
    bus: EventBus;
    repo: Repo;
    config: Config;
    runTurn: TurnRunner;
    now?: () => number;   // 테스트용 시계 주입, 기본 Date.now
  });
  start(): void;                                  // user_message 구독 시작
  async drain(): Promise<void>;                   // 큐가 빌 때까지 대기 (테스트용)
  async closeIdleSessionIfNeeded(): Promise<void>; // 유휴 세션 요약 후 종료 (index.ts가 주기 호출)
}
```

동작 규칙 (테스트가 이를 검증한다):

1. `user_message` 수신 → DB 기록 → 큐에 넣고 직렬 처리.
2. 세션 상태는 settings에 보관: `session.id`, `session.lastActiveTs`, `session.firstEventId`.
3. 마지막 활동이 `sessionIdleMinutes` 이내면 `resume`으로 이어가고, 아니면 새 세션 — 이때 프롬프트 앞에 [기억 컨텍스트] 블록(기억 인덱스 + 최근 요약 3개 + 최근 대화 20개)을 붙인다.
4. 시간당 턴 수가 `maxTurnsPerHour` 이상이면 LLM을 호출하지 않고 `system_notice`로 알린다.
5. 턴 성공 시: 세션 상태 갱신, `assistant_message` DB 기록 + 버스 발행. 실패 시: `system_notice` 발행.
6. `closeIdleSessionIfNeeded`: 세션이 있고 유휴 시간이 지났으면, resume으로 요약 턴을 실행해 `summaries`에 저장하고 세션 상태를 지운다.

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/core.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus, type AgentEvent } from "../src/events/bus.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { ensureMemoryDir } from "../src/memory/memory.js";
import { AgentCore } from "../src/core/core.js";
import type { Config } from "../src/config.js";
import type { TurnRequest, TurnResult } from "../src/core/agent.js";

function setup(overrides: Partial<Config> = {}) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-"));
  ensureMemoryDir(memoryDir);
  const config: Config = {
    discordToken: "t", ownerId: "o", dataDir: ":memory:", memoryDir,
    sessionIdleMinutes: 30, maxTurnsPerHour: 30, ...overrides,
  };
  const bus = new EventBus();
  const repo = new Repo(openDb(":memory:"));
  const calls: TurnRequest[] = [];
  let nextResult: TurnResult = { text: "안녕하세요!", sessionId: "s1", ok: true };
  const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    return nextResult;
  };
  let clock = 1_000_000;
  const core = new AgentCore({ bus, repo, config, runTurn, now: () => clock });
  core.start();
  const published: AgentEvent[] = [];
  bus.subscribe("assistant_message", (e) => { published.push(e); });
  bus.subscribe("system_notice", (e) => { published.push(e); });
  return {
    bus, repo, core, calls, published, memoryDir,
    setClock: (t: number) => { clock = t; },
    setResult: (r: TurnResult) => { nextResult = r; },
  };
}

function userMsg(text: string, ts: number): AgentEvent {
  return { type: "user_message", channel: "discord", channelRef: "c1", text, ts };
}

describe("AgentCore", () => {
  it("메시지를 받으면 턴을 실행하고 응답을 발행·기록한다", async () => {
    const t = setup();
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].prompt).toContain("안녕");
    expect(t.published[0]).toMatchObject({ type: "assistant_message", channelRef: "c1", text: "안녕하세요!" });
    const types = t.repo.recentEvents(10).map((e) => e.type);
    expect(types).toEqual(["user_message", "assistant_message"]);
  });

  it("유휴 시간 이내의 두 번째 메시지는 resume으로 이어간다", async () => {
    const t = setup();
    t.bus.publish(userMsg("첫번째", 1));
    await t.core.drain();
    t.bus.publish(userMsg("두번째", 2));
    await t.core.drain();
    expect(t.calls[0].resume).toBeUndefined();
    expect(t.calls[1].resume).toBe("s1");
  });

  it("새 세션 시작 시 기억 컨텍스트를 주입한다", async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.memoryDir, "MEMORY.md"), "# 기억 인덱스\n- 사용자는 고양이를 키운다");
    t.repo.insertSummary({ createdTs: 1, fromEventId: 1, toEventId: 2, content: "지난번엔 여행 얘기를 했다" });
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    expect(t.calls[0].prompt).toContain("기억 컨텍스트");
    expect(t.calls[0].prompt).toContain("고양이를 키운다");
    expect(t.calls[0].prompt).toContain("여행 얘기");
  });

  it("유휴 시간이 지나면 resume 없이 새 세션으로 시작한다", async () => {
    const t = setup({ sessionIdleMinutes: 30 });
    t.bus.publish(userMsg("첫번째", 1));
    await t.core.drain();
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.bus.publish(userMsg("한참 뒤", 2));
    await t.core.drain();
    expect(t.calls[1].resume).toBeUndefined();
    expect(t.calls[1].prompt).toContain("기억 컨텍스트");
  });

  it("시간당 한도를 넘으면 LLM을 호출하지 않고 알린다", async () => {
    const t = setup({ maxTurnsPerHour: 1 });
    t.bus.publish(userMsg("1", 1));
    await t.core.drain();
    t.bus.publish(userMsg("2", 2));
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice?.text).toContain("한도");
  });

  it("턴 실패 시 오류를 알린다", async () => {
    const t = setup();
    t.setResult({ text: "(에이전트 오류: error_during_execution)", sessionId: undefined, ok: false });
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    const notice = t.published.find((e) => e.type === "system_notice");
    expect(notice?.text).toContain("오류");
  });

  it("유휴 세션을 요약하고 종료한다", async () => {
    const t = setup({ sessionIdleMinutes: 30 });
    t.bus.publish(userMsg("기억해줘", 1));
    await t.core.drain();
    t.setClock(1_000_000 + 31 * 60 * 1000);
    t.setResult({ text: "사용자와 인사를 나눴다.", sessionId: "s1", ok: true });
    await t.core.closeIdleSessionIfNeeded();
    expect(t.calls).toHaveLength(2);            // 대화 턴 + 요약 턴
    expect(t.calls[1].resume).toBe("s1");       // 요약은 기존 세션에서
    expect(t.repo.recentSummaries(1)).toEqual(["사용자와 인사를 나눴다."]);
    // 세션이 지워졌으니 다음 메시지는 새 세션
    t.bus.publish(userMsg("다시 안녕", 3));
    await t.core.drain();
    expect(t.calls[2].resume).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- core`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/core/core.ts`

```typescript
import type { EventBus, UserMessageEvent } from "../events/bus.js";
import type { Repo } from "../store/repo.js";
import type { Config } from "../config.js";
import type { TurnRunner } from "./agent.js";
import { buildSystemPrompt } from "./persona.js";
import { readMemoryIndex } from "../memory/memory.js";

const SUMMARY_PROMPT = `이 대화 세션이 곧 종료됩니다. 나중에 다시 깨어날 너 자신을 위해 이번 대화를 요약하세요.
- 결정된 것, 사용자에 대해 새로 알게 된 것, 진행 중인 일 중심으로 10줄 이내
- 요약 텍스트만 출력 (인사말·설명 없이)`;

export class AgentCore {
  private bus: EventBus;
  private repo: Repo;
  private config: Config;
  private runTurn: TurnRunner;
  private now: () => number;
  private queue: UserMessageEvent[] = [];
  private processing = false;
  private turnTimestamps: number[] = [];
  private drainResolvers: Array<() => void> = [];

  constructor(deps: { bus: EventBus; repo: Repo; config: Config; runTurn: TurnRunner; now?: () => number }) {
    this.bus = deps.bus;
    this.repo = deps.repo;
    this.config = deps.config;
    this.runTurn = deps.runTurn;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.bus.subscribe("user_message", (e) => {
      this.queue.push(e);
      void this.processQueue();
    });
  }

  drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        await this.handleUserMessage(event).catch((err) => {
          console.error("[core] 처리 오류:", err);
          this.notify(event.channelRef, `처리 중 오류가 발생했어요: ${String(err)}`);
        });
      }
    } finally {
      this.processing = false;
      for (const resolve of this.drainResolvers.splice(0)) resolve();
    }
  }

  private async handleUserMessage(event: UserMessageEvent): Promise<void> {
    const eventId = this.repo.insertEvent({
      ts: event.ts, type: "user_message", channel: event.channel, channelRef: event.channelRef, content: event.text,
    });

    if (!this.checkRateLimit()) {
      this.notify(event.channelRef, "구독 한도 보호를 위해 잠시 쉬고 있어요. 1시간 안에 다시 시도해 주세요.");
      return;
    }

    const session = this.currentSession();
    let prompt = event.text;
    let resume: string | undefined;

    if (session && this.now() - session.lastActiveTs < this.idleMs()) {
      resume = session.id;
    } else {
      prompt = `${this.buildContextBlock()}\n\n---\n\n사용자 메시지: ${event.text}`;
      this.repo.setSetting("session.firstEventId", String(eventId));
    }

    this.turnTimestamps.push(this.now());
    const result = await this.runTurn({
      prompt,
      systemPrompt: buildSystemPrompt(this.config.memoryDir),
      resume,
      cwd: process.cwd(),
    });

    if (!result.ok) {
      this.notify(event.channelRef, `비서 처리 중 오류가 있었어요: ${result.text}`);
      return;
    }

    if (result.sessionId) {
      this.repo.setSetting("session.id", result.sessionId);
      this.repo.setSetting("session.lastActiveTs", String(this.now()));
    }

    this.repo.insertEvent({
      ts: this.now(), type: "assistant_message", channel: event.channel, channelRef: event.channelRef, content: result.text,
    });
    this.bus.publish({ type: "assistant_message", channel: event.channel, channelRef: event.channelRef, text: result.text, ts: this.now() });
  }

  async closeIdleSessionIfNeeded(): Promise<void> {
    const session = this.currentSession();
    if (!session) return;
    if (this.now() - session.lastActiveTs < this.idleMs()) return;

    const firstEventId = Number(this.repo.getSetting("session.firstEventId") ?? 0);
    const result = await this.runTurn({
      prompt: SUMMARY_PROMPT,
      systemPrompt: buildSystemPrompt(this.config.memoryDir),
      resume: session.id,
      cwd: process.cwd(),
    });
    if (result.ok && result.text.trim().length > 0) {
      const lastEvent = this.repo.recentEvents(1)[0];
      this.repo.insertSummary({
        createdTs: this.now(), fromEventId: firstEventId, toEventId: lastEvent?.id ?? firstEventId, content: result.text.trim(),
      });
    }
    this.repo.deleteSetting("session.id");
    this.repo.deleteSetting("session.lastActiveTs");
    this.repo.deleteSetting("session.firstEventId");
  }

  private currentSession(): { id: string; lastActiveTs: number } | null {
    const id = this.repo.getSetting("session.id");
    const lastActiveTs = this.repo.getSetting("session.lastActiveTs");
    if (!id || !lastActiveTs) return null;
    return { id, lastActiveTs: Number(lastActiveTs) };
  }

  private idleMs(): number {
    return this.config.sessionIdleMinutes * 60 * 1000;
  }

  private checkRateLimit(): boolean {
    const oneHourAgo = this.now() - 60 * 60 * 1000;
    this.turnTimestamps = this.turnTimestamps.filter((t) => t > oneHourAgo);
    return this.turnTimestamps.length < this.config.maxTurnsPerHour;
  }

  private buildContextBlock(): string {
    const memoryIndex = readMemoryIndex(this.config.memoryDir);
    const summaries = this.repo.recentSummaries(3);
    const recent = this.repo.recentEvents(20);
    const recentLines = recent
      .map((e) => `[${new Date(e.ts).toISOString()}] ${e.type === "user_message" ? "사용자" : "비서"}: ${e.content}`)
      .join("\n");
    return [
      "[기억 컨텍스트 — 새 세션 시작]",
      "## 장기 기억 인덱스 (MEMORY.md)",
      memoryIndex,
      "## 이전 대화 요약 (최신순)",
      summaries.length > 0 ? summaries.join("\n---\n") : "(요약 없음)",
      "## 최근 대화 기록",
      recentLines.length > 0 ? recentLines : "(기록 없음)",
    ].join("\n\n");
  }

  private notify(channelRef: string, text: string): void {
    this.repo.insertEvent({ ts: this.now(), type: "system_notice", channel: "discord", channelRef, content: text });
    this.bus.publish({ type: "system_notice", channel: "discord", channelRef, text, ts: this.now() });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- core`
Expected: 7 passed

- [ ] **Step 5: 전체 테스트 + 타입 검증**

Run: `npm test && npx tsc --noEmit`
Expected: 전부 통과

- [ ] **Step 6: 커밋**

```bash
git add src/core/core.ts tests/core.test.ts
git commit -m "feat: 에이전트 코어 — 큐, 세션 수명주기, 기억 재주입, 한도 보호"
```

---

### Task 8: 디스코드 어댑터

**Files:**
- Create: `src/adapters/discord.ts`
- Test: `tests/discord.test.ts` (메시지 분할 함수만 단위 테스트; 봇 연결은 Task 9 스모크로 검증)

**Interfaces:**
- Consumes: `EventBus`(Task 3), `Config`(Task 2)
- Produces:

```typescript
export function chunkMessage(text: string, max?: number): string[]; // 디스코드 2000자 제한 분할
export class DiscordAdapter {
  constructor(deps: { bus: EventBus; config: Config });
  async start(): Promise<void>;   // 로그인 + 수신/발신 연결
  async stop(): Promise<void>;    // 종료 시 클라이언트 정리
}
```

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/discord.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { chunkMessage } from "../src/adapters/discord.js";

describe("chunkMessage", () => {
  it("2000자 이하면 그대로 한 조각", () => {
    expect(chunkMessage("짧은 메시지")).toEqual(["짧은 메시지"]);
  });

  it("길면 최대 길이 이하 조각들로 나눈다", () => {
    const text = "가".repeat(4500);
    const chunks = chunkMessage(text, 2000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("줄바꿈 경계를 우선해서 자른다", () => {
    const line = "한 줄입니다.\n";
    const text = line.repeat(200); // 2600자
    const chunks = chunkMessage(text, 2000);
    expect(chunks[0].endsWith("한 줄입니다.")).toBe(true);
  });

  it("빈 문자열은 빈 배열", () => {
    expect(chunkMessage("")).toEqual([]);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- discord`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `src/adapters/discord.ts`

```typescript
import { ChannelType, Client, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { EventBus } from "../events/bus.js";
import type { Config } from "../config.js";

export function chunkMessage(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

export class DiscordAdapter {
  private client: Client;
  private bus: EventBus;
  private config: Config;

  constructor(deps: { bus: EventBus; config: Config }) {
    this.bus = deps.bus;
    this.config = deps.config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel], // DM 수신에 필요
    });
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (message: Message) => {
      if (message.author.bot) return;
      if (message.author.id !== this.config.ownerId) return;
      const isDm = message.channel.type === ChannelType.DM;
      const isDesignated = this.config.channelId !== undefined && message.channelId === this.config.channelId;
      if (!isDm && !isDesignated) return;

      if ("sendTyping" in message.channel) {
        void message.channel.sendTyping().catch(() => {});
      }
      this.bus.publish({
        type: "user_message",
        channel: "discord",
        channelRef: message.channelId,
        text: message.content,
        ts: Date.now(),
      });
    });

    const send = async (channelRef: string, text: string) => {
      try {
        const channel = await this.client.channels.fetch(channelRef);
        if (!channel || !channel.isSendable()) return;
        for (const chunk of chunkMessage(text)) {
          await channel.send(chunk);
        }
      } catch (err) {
        console.error("[discord] 전송 실패:", err);
      }
    };

    this.bus.subscribe("assistant_message", (e) => void send(e.channelRef, e.text));
    this.bus.subscribe("system_notice", (e) => void send(e.channelRef, `⚠️ ${e.text}`));

    this.client.on("clientReady", () => {
      console.log(`[discord] 로그인 완료: ${this.client.user?.tag}`);
    });

    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
```

참고: discord.js v14의 ready 이벤트 이름이 설치된 버전에 따라 `ready`일 수 있다. `npx tsc --noEmit`에서 `clientReady`가 없다고 하면 `"ready"`로 바꾼다.

- [ ] **Step 4: 테스트 통과 + 타입 검증**

Run: `npm test -- discord && npx tsc --noEmit`
Expected: 4 passed, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/adapters/discord.ts tests/discord.test.ts
git commit -m "feat: 디스코드 어댑터 (소유자 전용, DM+지정 채널, 메시지 분할)"
```

---

### Task 9: 진입점 배선 + 디스코드 봇 등록 + 스모크 테스트

**Files:**
- Create: `src/index.ts`, `.env` (커밋 금지)

**Interfaces:**
- Consumes: 지금까지의 모든 모듈.

- [ ] **Step 1: 구현 (index.ts)** — `src/index.ts`

```typescript
import "dotenv/config";
import path from "node:path";
import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { Repo } from "./store/repo.js";
import { ensureMemoryDir } from "./memory/memory.js";
import { AgentCore } from "./core/core.js";
import { runAgentTurn } from "./core/agent.js";
import { DiscordAdapter } from "./adapters/discord.js";

async function main() {
  const config = loadConfig();
  ensureMemoryDir(config.memoryDir);

  const db = openDb(path.join(config.dataDir, "agent.db"));
  const repo = new Repo(db);
  const bus = new EventBus();

  const core = new AgentCore({ bus, repo, config, runTurn: runAgentTurn });
  core.start();

  const discord = new DiscordAdapter({ bus, config });
  await discord.start();

  // 유휴 세션 정리: 1분마다 확인
  const idleTimer = setInterval(() => {
    void core.closeIdleSessionIfNeeded().catch((err) => console.error("[core] 유휴 정리 오류:", err));
  }, 60 * 1000);

  const shutdown = async () => {
    console.log("종료 중...");
    clearInterval(idleTimer);
    await discord.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log("상주 비서가 시작되었습니다.");
}

main().catch((err) => {
  console.error("시작 실패:", err);
  process.exit(1);
});
```

- [ ] **Step 2: 타입 검증 + 전체 테스트**

Run: `npx tsc --noEmit && npm test`
Expected: 전부 통과

- [ ] **Step 3: 디스코드 봇 등록 (사용자 수동 작업 — 안내 후 대기)**

사용자가 해야 할 일:
1. https://discord.com/developers/applications → **New Application** → 이름 입력 (예: "내 비서")
2. 왼쪽 **Bot** 메뉴 → **Reset Token** → 토큰 복사 (`.env`의 `DISCORD_TOKEN`)
3. 같은 페이지에서 **MESSAGE CONTENT INTENT** 켜기 (필수)
4. 왼쪽 **OAuth2 → URL Generator** → Scopes에서 `bot` 체크 → Bot Permissions에서 `Send Messages`, `Read Message History` 체크 → 생성된 URL로 봇을 내 서버에 초대 (또는 DM만 쓸 거면 아무 서버나 하나)
5. 디스코드 앱에서 설정 → 고급 → **개발자 모드** 켜기 → 내 프로필 우클릭 → **ID 복사하기** (`.env`의 `DISCORD_OWNER_ID`)

- [ ] **Step 4: 구독 인증 확인 (사용자 수동 작업)**

```powershell
claude setup-token
```

출력된 토큰을 `.env`의 `CLAUDE_CODE_OAUTH_TOKEN`에 넣는다. (Claude Code CLI에 이미 로그인되어 있다면 이 단계 없이도 SDK가 자격증명을 자동으로 사용하지만, PM2 데몬 환경에서는 토큰 방식이 확실하다.)

- [ ] **Step 5: .env 작성**

`.env.example`을 복사해 `.env`를 만들고 위에서 얻은 값들을 채운다. **절대 커밋하지 않는다.**

- [ ] **Step 6: 개발 모드 스모크 테스트**

Run: `npm run dev`
Expected: 콘솔에 `[discord] 로그인 완료: ...`와 `상주 비서가 시작되었습니다.`

디스코드에서 봇에게 DM 전송 → 검증 체크리스트:
- [ ] "안녕, 넌 누구야?" → 한국어로 비서 응답이 온다
- [ ] "내가 고양이 두 마리를 키운다는 걸 기억해줘" → 응답 후 `memory/` 폴더에 기억 파일이 생기고 `MEMORY.md`에 인덱스 줄이 추가된다
- [ ] `Ctrl+C`로 프로세스 종료 → 재시작(`npm run dev`) → "내가 뭘 키운다고 했지?" → 고양이를 기억한다
- [ ] Beekeeper Studio로 `store/agent.db`를 **Read Only**로 열어 `events` 테이블에 대화가 쌓였는지 확인

- [ ] **Step 7: 커밋**

```bash
git add src/index.ts
git commit -m "feat: 진입점 배선 — 코어/디스코드/유휴정리/종료처리"
```

---

### Task 10: PM2 상시구동

**Files:**
- Create: `ecosystem.config.cjs`
- Modify: `.gitignore` (logs 추가 불필요 — `*.log` 이미 포함)

**Interfaces:**
- Consumes: `npm run build` 산출물(`dist/index.js`)

- [ ] **Step 1: ecosystem.config.cjs 작성**

```javascript
module.exports = {
  apps: [
    {
      name: "assistant",
      script: "dist/index.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      env: { NODE_ENV: "production" },
    },
  ],
};
```

(dotenv가 `.env`를 런타임에 읽으므로 PM2에 비밀값을 넣을 필요 없음.)

- [ ] **Step 2: 빌드 후 PM2 기동**

```powershell
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 logs assistant --lines 20
```

Expected: 로그에 `[discord] 로그인 완료`. 디스코드 DM에 응답 확인.

- [ ] **Step 3: 부팅 자동 시작 등록**

```powershell
pm2 save
npm install -g pm2-windows-startup
pm2-startup install
pm2 save
```

- [ ] **Step 4: 절전 방지 설정**

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

(전원 연결 시 절전/최대절전 안 함, 모니터만 10분 후 끄기.)

- [ ] **Step 5: 최종 스모크 테스트 — 상시구동 검증**

- [ ] `pm2 restart assistant` → 디스코드 DM 응답 정상
- [ ] PC 재부팅 → 로그인 후 1~2분 내에 봇이 자동으로 온라인 → DM "내가 뭘 키운다고 했지?" → 여전히 고양이를 기억한다 (기억 연속성 + 자동 시작 동시 검증)
- [ ] `pm2 status`에서 `assistant`가 `online`

- [ ] **Step 6: 커밋**

```bash
git add ecosystem.config.cjs
git commit -m "feat: PM2 상시구동 설정 (자동재시작 + 부팅 자동시작)"
```

---

### Task 11: 크래시 복구 — 미처리 메시지 재개

스펙 10장: "처리 중 크래시가 나도 이벤트가 DB에 미완료 상태로 남아 재시작 시 재처리된다."

**Files:**
- Modify: `src/store/db.ts` (processed 컬럼), `src/store/repo.ts` (미처리 조회/완료 표시), `src/core/core.ts` (처리 완료 마킹 + 재개), `src/index.ts` (부팅 시 재개 호출)
- Test: `tests/core.test.ts` (추가 테스트), `tests/store.test.ts` (추가 테스트)

**Interfaces:**
- Consumes: 기존 `Repo`, `AgentCore`
- Produces:

```typescript
// repo.ts 추가
insertEvent(e: { ts: number; type: string; channel?: string; channelRef?: string; content: string; processed?: boolean }): number; // processed 기본 true
unprocessedUserMessages(): StoredEvent[];  // processed=0인 user_message, 시간순
markProcessed(id: number): void;

// core.ts 추가
async recoverPending(): Promise<void>;  // 미처리 메시지를 큐에 다시 넣음 (DB 재기록 없이)
```

- [ ] **Step 1: 실패하는 테스트 추가** — `tests/store.test.ts`에 추가

```typescript
  it("미처리 user_message를 조회하고 완료 표시한다", () => {
    const id1 = repo.insertEvent({ ts: 1, type: "user_message", content: "a", processed: false });
    repo.insertEvent({ ts: 2, type: "user_message", content: "b" }); // 기본 processed=true
    expect(repo.unprocessedUserMessages().map((e) => e.id)).toEqual([id1]);
    repo.markProcessed(id1);
    expect(repo.unprocessedUserMessages()).toHaveLength(0);
  });
```

`tests/core.test.ts`에 추가:

```typescript
  it("부팅 시 미처리 메시지를 재개해 처리한다", async () => {
    const t = setup();
    t.repo.insertEvent({ ts: 1, type: "user_message", channel: "discord", channelRef: "c1", content: "크래시 전 메시지", processed: false });
    await t.core.recoverPending();
    await t.core.drain();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].prompt).toContain("크래시 전 메시지");
    expect(t.repo.unprocessedUserMessages()).toHaveLength(0);
  });

  it("정상 처리된 메시지는 완료 표시된다", async () => {
    const t = setup();
    t.bus.publish(userMsg("안녕", 1));
    await t.core.drain();
    expect(t.repo.unprocessedUserMessages()).toHaveLength(0);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- store && npm test -- core`
Expected: FAIL — `processed`, `unprocessedUserMessages`, `recoverPending` 미구현

- [ ] **Step 3: 스키마 마이그레이션** — `src/store/db.ts`의 `openDb`에서 `db.exec(SCHEMA);` 다음에 추가

```typescript
  const columns = db.pragma("table_info(events)") as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "processed")) {
    db.exec("ALTER TABLE events ADD COLUMN processed INTEGER NOT NULL DEFAULT 1");
  }
```

- [ ] **Step 4: Repo 확장** — `src/store/repo.ts`

`insertEvent`를 다음으로 교체:

```typescript
  insertEvent(e: { ts: number; type: string; channel?: string; channelRef?: string; content: string; processed?: boolean }): number {
    const result = this.db
      .prepare("INSERT INTO events (ts, type, channel, channel_ref, content, processed) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.ts, e.type, e.channel ?? null, e.channelRef ?? null, e.content, e.processed === false ? 0 : 1);
    return Number(result.lastInsertRowid);
  }
```

메서드 추가:

```typescript
  unprocessedUserMessages(): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE type = 'user_message' AND processed = 0 ORDER BY id ASC")
      .all() as Row[];
    return rows.map(toEvent);
  }

  markProcessed(id: number): void {
    this.db.prepare("UPDATE events SET processed = 1 WHERE id = ?").run(id);
  }
```

- [ ] **Step 5: 코어 수정** — `src/core/core.ts`

큐 타입을 `{ event: UserMessageEvent; storedId?: number }`로 바꾸고:

```typescript
  private queue: Array<{ event: UserMessageEvent; storedId?: number }> = [];

  start(): void {
    this.bus.subscribe("user_message", (e) => {
      this.queue.push({ event: e });
      void this.processQueue();
    });
  }

  async recoverPending(): Promise<void> {
    for (const stored of this.repo.unprocessedUserMessages()) {
      this.queue.push({
        event: { type: "user_message", channel: (stored.channel ?? "discord") as "discord", channelRef: stored.channelRef ?? "", text: stored.content, ts: stored.ts },
        storedId: stored.id,
      });
    }
    void this.processQueue();
  }
```

`processQueue` 루프에서 `const item = this.queue.shift()!;` 후 `this.handleUserMessage(item.event, item.storedId)` 호출로 변경.

`handleUserMessage(event, storedId?)` 수정:
- 첫 줄의 insertEvent를 `const eventId = storedId ?? this.repo.insertEvent({ ...기존값, processed: false });`로 변경
- 함수의 **모든 종료 경로**(성공 발행 후, 한도 알림 후, 오류 알림 후) 끝에 `this.repo.markProcessed(eventId);` 추가

- [ ] **Step 6: index.ts 수정** — `await discord.start();` 다음 줄에 추가

```typescript
  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개
```

- [ ] **Step 7: 전체 테스트 통과 확인**

Run: `npm test && npx tsc --noEmit`
Expected: 전부 통과

- [ ] **Step 8: 커밋**

```bash
git add src/store/db.ts src/store/repo.ts src/core/core.ts src/index.ts tests/store.test.ts tests/core.test.ts
git commit -m "feat: 크래시 복구 — 미처리 메시지 부팅 시 재개"
```

---

## 완료 기준 (1단계 Definition of Done)

1. `npm test` 전체 통과, `npx tsc --noEmit` 오류 없음.
2. 디스코드 DM으로 비서와 한국어 대화가 된다 (소유자 외 무반응).
3. 기억 파일이 `memory/`에 생성·갱신되고, 프로세스 재시작·PC 재부팅 후에도 기억이 이어진다.
4. 30분 유휴 후 세션이 요약되어 `summaries`에 저장되고, 다음 대화는 새 세션 + 기억 컨텍스트로 시작된다.
5. PM2가 크래시 시 자동 재시작하고, 재부팅 시 자동 기동한다.
6. Beekeeper Studio(Read Only)로 `store/agent.db`의 `events`/`summaries`를 눈으로 확인할 수 있다.
