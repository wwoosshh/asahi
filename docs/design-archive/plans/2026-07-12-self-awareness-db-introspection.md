---
title: "자기인지 — DB introspection + 런타임 인지 + Opus 4.8 Implementation Plan"
status: Shipped
shippedIn: 039f91a
---

# 자기인지 — DB introspection + 런타임 인지 + Opus 4.8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Asahi가 자기 구조·데이터를 소유자 DM에서 읽고(db_schema/db_query), 자기 런타임 사양을 알며(runtime_info), 실행 모델을 Opus 4.8로 고정한다.

**Architecture:** 순수 가드(assertReadOnlySql)+포맷(formatQueryResult) → IntrospectRepo(READ ONLY 트랜잭션 조회·스키마) → 인프로세스 MCP 도구 3개(소유자 신원 전용) → agent.ts 배선(모델·introspect·runtime·init 캡처) → persona·진입점 배선. 새 DB 스키마 없음.

**Tech Stack:** TypeScript ESM(NodeNext, `.js` import), Node 22, vitest, pg/pg-mem, @anthropic-ai/claude-agent-sdk@^0.3.207.

## Global Constraints

- 모든 import `.js` 확장자(NodeNext). 텍스트 한국어. 이모지 금지 유지.
- **읽기 전용 다층 방어**: 순수 사전검사(assertReadOnlySql) + Postgres **READ ONLY 트랜잭션**(핵심) + statement_timeout + 행 상한. 진짜 방어선은 READ ONLY 트랜잭션이며, 사전검사는 빠른 거부·심층방어용(코드 주석에 명시).
- **소유자 신원 전용**: db_schema/db_query/runtime_info 는 `ctx.isOwner && ctx.isPrivate` 에서만(핸들러 재확인 + allowedToolsFor 소유자 DM 브랜치에만). ownWorkstation(손님 자기 PC)엔 열지 않는다.
- **모델**: `config.model` 기본 `claude-opus-4-8`(env `ANTHROPIC_MODEL` 재정의). 봇·워커 동일.
- 각 태스크 종료 시 `cd agent && npx tsc --noEmit && npm test` 통과. 커밋 본문 끝에 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- 브랜치: `feat/self-awareness-db`(스펙 커밋됨).

---

### Task 1: config.model (Opus 4.8 기본, 봇·워커)

**Files:**
- Modify: `agent/src/config.ts` (Config·WorkerConfig 에 `model` 추가, load 함수 둘 다)
- Test: `agent/tests/config.test.ts`

**Interfaces:**
- Produces: `Config.model: string`, `WorkerConfig.model: string` (기본 `"claude-opus-4-8"`, env `ANTHROPIC_MODEL`)

- [ ] **Step 1: 실패 테스트 추가**

`agent/tests/config.test.ts` 파일 끝에 추가(기존 import·describe 재사용; 없으면 `import { loadConfig, loadWorkerConfig } from "../src/config.js";`):

```ts
describe("model 구성(Opus 4.8 기본)", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_OWNER_ID: "1", DATABASE_URL: "postgres://x" };
  it("loadConfig: 기본 모델은 claude-opus-4-8, ANTHROPIC_MODEL 로 재정의된다", () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).model).toBe("claude-opus-4-8");
    expect(loadConfig({ ...base, ANTHROPIC_MODEL: "claude-sonnet-5" } as NodeJS.ProcessEnv).model).toBe("claude-sonnet-5");
  });
  it("loadWorkerConfig: 기본 모델은 claude-opus-4-8, 재정의 가능", () => {
    const wbase = { DATABASE_URL: "postgres://x", DISCORD_OWNER_ID: "1", WORKER_USER_ID: "2" };
    expect(loadWorkerConfig({ ...wbase } as NodeJS.ProcessEnv).model).toBe("claude-opus-4-8");
    expect(loadWorkerConfig({ ...wbase, ANTHROPIC_MODEL: "claude-haiku-4-5-20251001" } as NodeJS.ProcessEnv).model).toBe("claude-haiku-4-5-20251001");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/config.test.ts -t model`
Expected: FAIL — `.model` undefined.

- [ ] **Step 3: 구현**

`agent/src/config.ts`:
- `Config` 타입에 추가(`deployTarget` 아래): `  model: string;`
- `WorkerConfig` 타입에 추가(`sessionIdleMinutes` 아래): `  model: string;`
- `loadConfig` 의 return 객체에 추가(`deployTarget:` 줄 아래): `    model: env.ANTHROPIC_MODEL || "claude-opus-4-8",`
- `loadWorkerConfig` 의 return 객체에 추가(`sessionIdleMinutes:` 줄 아래): `    model: env.ANTHROPIC_MODEL || "claude-opus-4-8",`

- [ ] **Step 4: 통과 확인 + 전체**

Run: `cd agent && npx vitest run tests/config.test.ts && npx tsc --noEmit`
Expected: PASS(tsc 는 아직 미사용 필드라도 통과).

- [ ] **Step 5: 커밋**

```bash
git add agent/src/config.ts agent/tests/config.test.ts
git commit -m "feat(self-aware): config.model 기본 claude-opus-4-8(env ANTHROPIC_MODEL)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: sqlGuard.ts — assertReadOnlySql + formatQueryResult (순수)

**Files:**
- Create: `agent/src/core/sqlGuard.ts`
- Test: `agent/tests/sqlGuard.test.ts`

**Interfaces:**
- Produces:
  - `assertReadOnlySql(sql: string): void` — 위반 시 `throw new Error(사용자용 메시지)`.
  - `formatQueryResult(rows: Record<string, unknown>[], truncated: number, opts?: { maxCell?: number }): string`.

- [ ] **Step 1: 실패 테스트 작성**

`agent/tests/sqlGuard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertReadOnlySql, formatQueryResult } from "../src/core/sqlGuard.js";

describe("assertReadOnlySql", () => {
  it("단순 SELECT·WITH…SELECT·개행/주석 포함을 허용한다", () => {
    for (const ok of [
      "SELECT 1",
      "  select * from users limit 5",
      "SELECT count(*)\nFROM messages\nWHERE role='user'",
      "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
      "-- 주석\nSELECT id FROM conversations",
    ]) {
      expect(() => assertReadOnlySql(ok)).not.toThrow();
    }
  });

  it("쓰기·DDL·다중문·빈 문자열을 거부한다", () => {
    for (const bad of [
      "INSERT INTO users VALUES ('x')",
      "UPDATE users SET role='owner'",
      "DELETE FROM messages",
      "DROP TABLE users",
      "ALTER TABLE users ADD COLUMN x int",
      "TRUNCATE messages",
      "GRANT ALL ON users TO public",
      "SELECT 1; DROP TABLE users",   // 다중문
      "select 1; select 2",           // 다중문
      "",
      "   ",
      "explain analyze select 1",     // 부작용 가능(analyze) — SELECT/WITH 로 시작 안 함
    ]) {
      expect(() => assertReadOnlySql(bad)).toThrow();
    }
  });
});

describe("formatQueryResult", () => {
  it("행을 표로 만들고 잘린 행수를 알린다", () => {
    const out = formatQueryResult([{ id: 1, name: "a" }, { id: 2, name: "b" }], 3);
    expect(out).toMatch(/id/);
    expect(out).toMatch(/name/);
    expect(out).toMatch(/…외 3행/);
  });
  it("빈 결과를 안내한다", () => {
    expect(formatQueryResult([], 0)).toMatch(/결과 없음|행 없음/);
  });
  it("긴 셀 값을 절단한다", () => {
    const long = "x".repeat(1000);
    const out = formatQueryResult([{ c: long }], 0, { maxCell: 20 });
    expect(out).not.toContain(long);
    expect(out).toMatch(/…/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/sqlGuard.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`agent/src/core/sqlGuard.ts`:

```ts
// 읽기 전용 SQL 가드(순수). 완전한 SQL 파서가 아니라 "명백한 쓰기/다중문을 빠르게 거부"하는
// 1차 방어다 — 진짜 방어선은 IntrospectRepo.readOnlyQuery 의 Postgres READ ONLY 트랜잭션이다.
// (예: `WITH x AS (DELETE … RETURNING *) SELECT …` 같이 문두가 WITH 인 쓰기 CTE 는 이 pre-check 를
//  통과하지만, READ ONLY 트랜잭션이 실행 시점에 거부한다 — 그게 핵심 방어다.)

// 주석(줄 -- / 블록 /* */) 제거 후 앞뒤 공백 정리.
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
}

export function assertReadOnlySql(sql: string): void {
  const cleaned = stripComments(sql);
  if (cleaned.length === 0) throw new Error("빈 쿼리예요. SELECT 문을 주세요.");
  // 다중문 금지: 마지막의 세미콜론 하나만 허용하고, 그 외 위치의 세미콜론은 다중문으로 본다.
  const withoutTrailing = cleaned.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) throw new Error("한 번에 하나의 SELECT 문만 실행할 수 있어요(다중 문장 금지).");
  const firstWord = withoutTrailing.split(/[\s(]/, 1)[0].toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new Error("읽기 전용 SELECT(또는 WITH … SELECT)만 실행할 수 있어요.");
  }
}

export function formatQueryResult(rows: Record<string, unknown>[], truncated: number, opts: { maxCell?: number } = {}): string {
  const maxCell = opts.maxCell ?? 500;
  if (rows.length === 0) return "(결과 없음)";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > maxCell ? `${s.slice(0, maxCell)}…` : s;
  };
  const header = cols.join(" | ");
  const lines = rows.map((r) => cols.map((c) => cell(r[c])).join(" | "));
  const body = [header, ...lines].join("\n");
  return truncated > 0 ? `${body}\n…외 ${truncated}행 더 있음` : body;
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd agent && npx vitest run tests/sqlGuard.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/sqlGuard.ts agent/tests/sqlGuard.test.ts
git commit -m "feat(self-aware): sqlGuard — assertReadOnlySql + formatQueryResult(순수)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: IntrospectRepo — schema + readOnlyQuery (스파이크 후 구현)

**Files:**
- Create: `agent/src/store/introspectRepo.ts`
- Test: `agent/tests/introspectRepo.test.ts`

**Interfaces:**
- Consumes: `Db`(db.ts), `formatQueryResult`(불필요 — repo 는 rows 반환), `assertReadOnlySql`(호출은 tools 핸들러에서).
- Produces:
  - `IntrospectRepo(db: Db)`
  - `.schema(): Promise<string>` — 테이블·컬럼·타입 텍스트.
  - `.readOnlyQuery(sql: string, opts?: { maxRows?: number; timeoutMs?: number }): Promise<{ rows: Record<string, unknown>[]; truncated: number }>`.

- [ ] **Step 1: pg-mem 지원 스파이크(증거 수집)**

임시 스크립트로 pg-mem 이 무엇을 지원하는지 확인한다(실제 구현 방식 결정용). `agent/_spike.mjs` 작성:

```js
import { openTestDb } from "./dist-esm-or-src"; // 아래 실행법 참고
```

실행이 번거로우면 vitest 로 확인: `agent/tests/_spike.test.ts` 임시 작성 후 실행:

```ts
import { describe, it } from "vitest";
import { openTestDb } from "../src/store/db.js";
describe("pg-mem spike", () => {
  it("정보 수집", async () => {
    const db = await openTestDb();
    for (const q of [
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' LIMIT 3",
      "BEGIN", "SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = 5000", "SELECT 1", "ROLLBACK",
    ]) {
      try { const r = await db.query(q); console.log("OK:", q, "→", JSON.stringify(r.rows).slice(0,120)); }
      catch (e) { console.log("FAIL:", q, "→", e.message); }
    }
  });
});
```

Run: `cd agent && npx vitest run tests/_spike.test.ts 2>&1 | grep -E "OK:|FAIL:"`
스파이크 결과(어떤 구문이 OK/FAIL 인지)를 커밋 메시지·주석에 남긴다. **그다음 `rm agent/tests/_spike.test.ts`(임시 파일 삭제).**

- [ ] **Step 2: 실패 테스트 작성(스파이크 결과 반영)**

`agent/tests/introspectRepo.test.ts`. pg-mem 이 `SET TRANSACTION READ ONLY`/`statement_timeout` 을 **관용(무시)** 하면 아래 그대로, **에러** 내면 `readOnlyQuery` 테스트는 `it.skip` 로 두고 주석에 "실 Supabase 스모크 필요"를 남긴다(스파이크 결과에 따라 결정).

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";

describe("IntrospectRepo.readOnlyQuery", () => {
  let db: Db;
  beforeEach(async () => { db = await openTestDb(); });

  it("정상 SELECT 결과 행을 반환하고 maxRows 로 자른다", async () => {
    const msgs = new MessagesRepo(db);
    for (let i = 0; i < 5; i++) await msgs.insert({ conversationId: 1, ts: i, role: "user", userId: "u", content: `m${i}` });
    const repo = new IntrospectRepo(db);
    const { rows, truncated } = await repo.readOnlyQuery("SELECT id FROM messages ORDER BY id", { maxRows: 3 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(2);
  });
});
```

(schema() 는 information_schema 의존이라 pg-mem 지원 여부가 갈린다 — 스파이크에서 OK 면 아래 테스트 추가, FAIL 이면 실 Supabase 스모크로 미룬다:)

```ts
describe("IntrospectRepo.schema", () => {
  it("테이블·컬럼을 문자열로 반환한다(information_schema)", async () => {
    const db = await openTestDb();
    const repo = new IntrospectRepo(db);
    const s = await repo.schema();
    expect(s).toMatch(/messages/);
    expect(s).toMatch(/conversations/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd agent && npx vitest run tests/introspectRepo.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`agent/src/store/introspectRepo.ts`:

```ts
import type { Db } from "./db.js";

// 자기 구조·데이터 읽기(자기인지). 쓰기는 하지 않는다 — readOnlyQuery 는 Postgres READ ONLY
// 트랜잭션에서 실행되어(핵심 방어선), 사전검사(assertReadOnlySql, tools 에서 호출)를 뚫은 쓰기도
// DB 가 거부한다. pg-mem 은 READ ONLY 강제/timeout/information_schema 를 완전히 흉내내지 못할 수
// 있어(스파이크로 확인), 해당 보장은 실 Supabase 스모크로 검증한다.
export class IntrospectRepo {
  constructor(private db: Db) {}

  async schema(): Promise<string> {
    const r = await this.db.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map<string, string[]>();
    for (const row of r.rows as { table_name: string; column_name: string; data_type: string }[]) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(`${row.column_name} ${row.data_type}`);
      byTable.set(row.table_name, list);
    }
    if (byTable.size === 0) return "(스키마 정보를 읽을 수 없어요)";
    return [...byTable.entries()].map(([t, cols]) => `## ${t}\n- ${cols.join("\n- ")}`).join("\n\n");
  }

  async readOnlyQuery(sql: string, opts: { maxRows?: number; timeoutMs?: number } = {}): Promise<{ rows: Record<string, unknown>[]; truncated: number }> {
    const maxRows = opts.maxRows ?? 100;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
      const r = await client.query(sql);
      const all = (r.rows ?? []) as Record<string, unknown>[];
      const rows = all.slice(0, maxRows);
      return { rows, truncated: Math.max(0, all.length - rows.length) };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
}
```

**스파이크가 pg-mem 이 `SET TRANSACTION READ ONLY` 에서 에러를 낸다고 했으면**: 위 두 `SET` 호출을 `.catch(() => {})` 로 감싸지 말 것(실 PG 보장 약화). 대신 introspectRepo.test.ts 의 readOnlyQuery 테스트를 `it.skip`(주석: 실 Supabase 스모크) 하고, 순수 로직(자르기)은 이미 Task 2 formatQueryResult/여기 slice 로 커버됨을 확인한다.

- [ ] **Step 5: 통과 확인**

Run: `cd agent && npx vitest run tests/introspectRepo.test.ts && npx tsc --noEmit`
Expected: PASS(또는 skip 표시).

- [ ] **Step 6: 커밋**

```bash
git add agent/src/store/introspectRepo.ts agent/tests/introspectRepo.test.ts
git commit -m "feat(self-aware): IntrospectRepo — schema + READ ONLY 트랜잭션 readOnlyQuery

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: tools — db_schema/db_query/runtime_info + 게이팅 + ToolCtx 확장

**Files:**
- Modify: `agent/src/core/tools.ts` (ToolCtx.repos.introspect·ToolCtx.runtime 추가, 핸들러 3개, buildTools 3개, allowedToolsFor 소유자 DM 브랜치)
- Test: `agent/tests/tools.test.ts`

**Interfaces:**
- Consumes: `IntrospectRepo`(Task 3), `assertReadOnlySql`·`formatQueryResult`(Task 2).
- Produces:
  - `ToolCtx.repos.introspect: IntrospectRepo`, `ToolCtx.runtime: RuntimeInfo`.
  - `type RuntimeInfo = { model: string; sdkVersion: string; deployTarget: "local" | "cloud"; maxTurns: number }`.
  - handlers: `dbSchemaHandler(ctx)`, `dbQueryHandler(ctx, { sql })`, `runtimeInfoHandler(ctx)` (모두 `Promise<string>`).
  - `allowedToolsFor` 소유자 DM(cloud·local)에 `t("db_schema")`, `t("db_query")`, `t("runtime_info")` 추가.

- [ ] **Step 1: 실패 테스트 작성**

`agent/tests/tools.test.ts` 에 추가(파일 상단 import 에 `dbSchemaHandler, dbQueryHandler, runtimeInfoHandler, allowedToolsFor` 포함되도록):

```ts
import { openTestDb } from "../src/store/db.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { dbSchemaHandler, dbQueryHandler, runtimeInfoHandler } from "../src/core/tools.js";

async function ownerCtx(over = {}) {
  const db = await openTestDb();
  return {
    repos: { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) },
    role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1,
    runtime: { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 },
    ...over,
  } as any;
}

describe("db_query 게이팅·안전", () => {
  it("소유자가 아니면 거부한다", async () => {
    const ctx = await ownerCtx({ isOwner: false });
    expect(await dbQueryHandler(ctx, { sql: "SELECT 1" })).toMatch(/소유자/);
  });
  it("비공개(DM)가 아니면 거부한다", async () => {
    const ctx = await ownerCtx({ isPrivate: false });
    expect(await dbQueryHandler(ctx, { sql: "SELECT 1" })).toMatch(/소유자|DM/);
  });
  it("쓰기 SQL 은 사전검사로 거부한다", async () => {
    const ctx = await ownerCtx();
    expect(await dbQueryHandler(ctx, { sql: "DELETE FROM messages" })).toMatch(/읽기 전용|SELECT/);
  });
  it("소유자 정상 SELECT 는 결과를 반환한다", async () => {
    const ctx = await ownerCtx();
    const out = await dbQueryHandler(ctx, { sql: "SELECT 1 AS n" });
    expect(out).toMatch(/n/);
  });
});

describe("runtime_info", () => {
  it("소유자에게 모델·배포·maxTurns 를 보고한다", async () => {
    const ctx = await ownerCtx();
    const out = await runtimeInfoHandler(ctx);
    expect(out).toMatch(/claude-opus-4-8/);
    expect(out).toMatch(/local/);
    expect(out).toMatch(/30/);
  });
  it("소유자가 아니면 거부한다", async () => {
    expect(await runtimeInfoHandler(await ownerCtx({ isOwner: false }))).toMatch(/소유자/);
  });
});

describe("allowedToolsFor — db 도구 노출", () => {
  it("소유자 DM(local·cloud)에 db_schema/db_query/runtime_info 를 노출한다", () => {
    for (const dt of ["local", "cloud"] as const) {
      const tools = allowedToolsFor("owner", true, true, dt);
      expect(tools).toContain("mcp__asahi__db_query");
      expect(tools).toContain("mcp__asahi__db_schema");
      expect(tools).toContain("mcp__asahi__runtime_info");
    }
  });
  it("손님 DM·서버·손님 자기PC(ownWorkstation)엔 노출하지 않는다", () => {
    expect(allowedToolsFor("allowed", true, false, "local")).not.toContain("mcp__asahi__db_query");
    expect(allowedToolsFor("allowed", false, false, "local")).not.toContain("mcp__asahi__db_query");
    expect(allowedToolsFor("allowed", true, false, "local", true)).not.toContain("mcp__asahi__db_query");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/tools.test.ts`
Expected: FAIL — 핸들러·타입·노출 없음.

- [ ] **Step 3: 구현 (tools.ts)**

1) 상단 import 에 추가:
```ts
import type { IntrospectRepo } from "../store/introspectRepo.js";
import { assertReadOnlySql, formatQueryResult } from "./sqlGuard.js";
```
2) `RuntimeInfo` 타입과 `ToolCtx` 확장(`ToolCtx.repos` 에 introspect, ToolCtx 에 runtime):
```ts
export type RuntimeInfo = { model: string; sdkVersion: string; deployTarget: "local" | "cloud"; maxTurns: number };
```
`ToolCtx.repos` 타입을 `{ memories: MemoriesRepo; users: UsersRepo; allowedDirs: AllowedDirsRepo; introspect: IntrospectRepo }` 로 바꾸고, `ToolCtx` 에 `runtime: RuntimeInfo;` 필드를 추가한다.
3) 핸들러 3개 추가(기존 핸들러들 아래):
```ts
const OWNER_DM_ONLY_DB = "이 작업은 소유자 DM에서만 할 수 있어요.";
function isOwnerDm(ctx: ToolCtx): boolean { return ctx.isOwner && ctx.isPrivate; }

export async function dbSchemaHandler(ctx: ToolCtx): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY_DB;
  return await ctx.repos.introspect.schema();
}

export async function dbQueryHandler(ctx: ToolCtx, args: { sql: string }): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY_DB;
  try { assertReadOnlySql(args.sql); } catch (e) { return e instanceof Error ? e.message : "잘못된 쿼리예요."; }
  try {
    const { rows, truncated } = await ctx.repos.introspect.readOnlyQuery(args.sql);
    return formatQueryResult(rows, truncated);
  } catch (e) {
    return `쿼리 실행 오류: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runtimeInfoHandler(ctx: ToolCtx): Promise<string> {
  if (!isOwnerDm(ctx)) return OWNER_DM_ONLY_DB;
  const r = ctx.runtime;
  return [
    `모델(설정): ${r.model}`,
    `SDK: @anthropic-ai/claude-agent-sdk@${r.sdkVersion}`,
    `배포 대상: ${r.deployTarget}`,
    `한 응답 내 도구 반복 상한(maxTurns): ${r.maxTurns}`,
    `한도: 소유자는 무제한, 손님은 시간당 제한(유저별/전역).`,
  ].join("\n");
}
```
4) `buildTools` 의 `tools: [ … ]` 배열에 3개 추가(list_dirs 뒤):
```ts
      tool("db_schema", "(소유자 전용) 내 데이터베이스의 테이블·컬럼 구조를 보여줍니다.", {}, async () => textResult(await dbSchemaHandler(ctx))),
      tool("db_query", "(소유자 전용) 읽기 전용 SELECT 로 내 데이터를 조회합니다. SELECT 만 가능합니다.", { sql: z.string().describe("실행할 읽기 전용 SELECT 문") }, async (args) => textResult(await dbQueryHandler(ctx, args))),
      tool("runtime_info", "(소유자 전용) 내가 어떤 모델·SDK·배포 설정으로 동작 중인지 보여줍니다.", {}, async () => textResult(await runtimeInfoHandler(ctx))),
```
5) `allowedToolsFor` 의 소유자 DM 두 브랜치에 도구 추가:
- cloud 브랜치 배열을 `[t("remember"), t("recall"), t("manage_access"), t("db_schema"), t("db_query"), t("runtime_info")]` 로.
- local 브랜치 배열 끝에 `t("db_schema"), t("db_query"), t("runtime_info")` 추가.

**주의(ripple)**: `ToolCtx.repos` 에 `introspect`, `ToolCtx` 에 `runtime` 을 **필수**로 추가하므로, `agent/tests/tools.test.ts` 의 **기존** 핸들러 테스트(remember/recall/manageAccess/allowDir 등)가 만드는 ctx 리터럴도 `repos.introspect` 와 `runtime` 을 채워야 tsc 가 통과한다. 위 `ownerCtx` 같은 **공통 팩토리로 묶어** 기존 테스트도 그걸 쓰게 리팩터하면 깔끔하다(동작 변경 없이 픽스처만 보강).

- [ ] **Step 4: 통과 확인**

Run: `cd agent && npx vitest run tests/tools.test.ts`
Expected: PASS. (tsc 는 Task 5 에서 buildToolCtx 가 introspect/runtime 을 채우기 전까진 agent.ts 에서 에러날 수 있으니 여기선 vitest 만 확인, tsc 는 Task 5 후 전체 확인.)

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/tools.ts agent/tests/tools.test.ts
git commit -m "feat(self-aware): db_schema/db_query/runtime_info 도구 + 소유자 게이팅

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: agent.ts — introspect·runtime·모델 배선 + init 캡처

**Files:**
- Modify: `agent/src/core/agent.ts` (ToolRepos.introspect, makeRunAgentTurn 시그니처+query model+init 로깅, buildToolCtx runtime/introspect)
- Test: `agent/tests/agent.test.ts` (buildToolCtx 가 introspect/runtime 을 옮기는지)

**Interfaces:**
- Consumes: `IntrospectRepo`(Task 3), `ToolCtx.repos.introspect`·`ToolCtx.runtime`·`RuntimeInfo`(Task 4).
- Produces:
  - `ToolRepos = { memories; users; allowedDirs; introspect: IntrospectRepo }`.
  - `makeRunAgentTurn(repos, deployTarget?, model?)` — `model` 기본 `"claude-opus-4-8"`.
  - `query()` 옵션에 `model` 전달. init 메시지의 `model` 을 console 로깅.
  - `buildToolCtx(repos, context, runtime)` 로 확장(runtime 주입).

- [ ] **Step 1: 실패 테스트 작성**

`agent/tests/agent.test.ts` 에 추가(기존 buildToolCtx 테스트 패턴 재사용):

```ts
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { openTestDb } from "../src/store/db.js";
// 기존 import 에 buildToolCtx 있다고 가정

it("buildToolCtx 는 introspect 리포와 runtime 을 ctx 로 옮긴다", async () => {
  const db = await openTestDb();
  const repos = { memories: {} as any, users: {} as any, allowedDirs: {} as any, introspect: new IntrospectRepo(db) };
  const runtime = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local" as const, maxTurns: 30 };
  const ctx = buildToolCtx(repos, { role: "owner", isPrivate: true, isOwner: true, userId: "o", conversationId: 1 }, runtime);
  expect(ctx.repos.introspect).toBe(repos.introspect);
  expect(ctx.runtime.model).toBe("claude-opus-4-8");
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/agent.test.ts -t buildToolCtx`
Expected: FAIL — buildToolCtx 아직 runtime 인자를 안 받음.

- [ ] **Step 3: 구현 (agent.ts)**

1) import 추가: `import type { IntrospectRepo } from "../store/introspectRepo.js";` 그리고 tools 에서 `RuntimeInfo` 타입 import: `import { buildTools, allowedToolsFor, TOOL_SERVER, type ToolCtx, type RuntimeInfo } from "./tools.js";`
2) 상수: `const SDK_VERSION = "0.3.207"; // package.json 과 동기화` 그리고 `const DEFAULT_MODEL = "claude-opus-4-8";`
3) `ToolRepos` 타입에 `introspect: IntrospectRepo` 추가.
4) `buildToolCtx` 시그니처를 `(repos: ToolRepos, context: TurnContext, runtime: RuntimeInfo): ToolCtx` 로 바꾸고 반환 객체에 `repos`(introspect 포함) + `runtime` 을 넣는다. (repos 는 그대로 넘기면 introspect 포함됨.)
5) `makeRunAgentTurn(repos: ToolRepos, deployTarget: "local" | "cloud" = "local", model: string = DEFAULT_MODEL): TurnRunner` 로 확장.
6) 러너 내부:
```ts
    const runtime: RuntimeInfo = { model, sdkVersion: SDK_VERSION, deployTarget, maxTurns: 30 };
    const ctx: ToolCtx = buildToolCtx(repos, req.context, runtime);
```
7) `query({ ... options })` 에 `model,` 추가(예: `permissionMode: "default",` 위/아래 아무 곳).
8) init 메시지 처리에 모델 로깅 추가:
```ts
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        const actual = (message as { model?: string }).model;
        if (actual && actual !== model) console.warn(`[agent] 설정 모델(${model}) ≠ 실제 실행 모델(${actual})`);
        else if (actual) console.log(`[agent] 실행 모델: ${actual}`);
      }
```

**주의(ripple)**: `buildToolCtx` 시그니처가 `(repos, context)` → `(repos, context, runtime)` 로 바뀌므로, `agent/tests/agent.test.ts` 의 **기존** buildToolCtx 호출도 세 번째 인자(runtime)를 넘기도록 갱신해야 tsc 통과. 기존 makeRunAgentTurn 을 부르는 곳(index.ts/worker.ts)은 Task 6 에서 introspect 를 포함한 repos 로 갱신한다 — 그 전까지 tsc 전체는 Task 6 후 확인.

- [ ] **Step 4: 통과 확인**

Run: `cd agent && npx vitest run tests/agent.test.ts && npx vitest run tests/tools.test.ts`
Expected: PASS (tools 도 이제 ctx.runtime/introspect 로 통과).

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/agent.ts agent/tests/agent.test.ts
git commit -m "feat(self-aware): agent 배선 — model→query·introspect·runtime·init 모델 로깅

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: persona 안내 + 진입점 배선(봇·워커) + 전체 검증

**Files:**
- Modify: `agent/src/core/persona.ts` (소유자 DM 능력 블록에 한 줄)
- Modify: `agent/src/index.ts` (repos.introspect + makeRunAgentTurn 에 config.model)
- Modify: `agent/src/worker.ts` (introspect + config.model)
- Test: `agent/tests/persona.test.ts` (능력 안내 문구)

**Interfaces:**
- Consumes: `IntrospectRepo`, `config.model`(Task 1), `makeRunAgentTurn(repos, deployTarget, model)`(Task 5).

- [ ] **Step 1: persona 실패 테스트**

`agent/tests/persona.test.ts` 의 캐릭터/관계 describe 에 추가:
```ts
  it("소유자 DM 능력 블록에 db 조회로 실측 응답하라는 안내가 있다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/db_query|db_schema|조회/);
    expect(p).toMatch(/실측|사실/);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/persona.test.ts -t "db 조회"`
Expected: FAIL.

- [ ] **Step 3: persona.ts 수정**

`buildCapabilityBlock` 의 **소유자 DM local·cloud 두 분기 모두**의 마지막에 한 줄 추가(문구 동일):
```
- db_schema/db_query 로 네 구조와 데이터를 직접 조회해 추측 대신 실측(사실)으로 답하고, 네가 할 수 있는 것/아직 못 하는 것을 정직히 안내해. runtime_info 로 네가 어떤 모델·설정으로 도는지도 알 수 있어.
```
(cloud 분기에도 동일 추가 — db 도구는 PC 무관이라 cloud 에서도 동작.)

- [ ] **Step 4: index.ts 배선**

- import 추가: `import { IntrospectRepo } from "./store/introspectRepo.js";`
- `repos` 객체에 `introspect: new IntrospectRepo(db),` 추가.
- `makeRunAgentTurn(...)` 호출을 아래로:
```ts
  const runTurn = makeRunAgentTurn({ memories: repos.memories, users: repos.users, allowedDirs: repos.allowedDirs, introspect: repos.introspect }, config.deployTarget, config.model);
```

- [ ] **Step 5: worker.ts 배선**

- import 추가: `import { IntrospectRepo } from "./store/introspectRepo.js";`
- `const introspect = new IntrospectRepo(db);` 추가(다른 repo 선언 옆).
- `makeRunAgentTurn(...)` 호출을 아래로:
```ts
  const runTurn = makeRunAgentTurn({ memories, users, allowedDirs, introspect }, "local", config.model);
```

- [ ] **Step 6: 전체 검증**

Run: `cd agent && npx tsc --noEmit && npm test && npm run build`
Expected: PASS 전체, `dist/index.js`·`dist/worker.js` 생성. 확인 후 `rm -rf agent/dist`.

- [ ] **Step 7: 커밋**

```bash
git add agent/src/core/persona.ts agent/src/index.ts agent/src/worker.ts agent/tests/persona.test.ts
git commit -m "feat(self-aware): persona 안내 + 봇·워커 introspect·모델 배선

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 검증·마무리 (플랜 밖, 실행자 참고)
- 전체: `cd agent && npx tsc --noEmit && npm test && npm run build`.
- 재배포 후 소유자 스모크: (1) "너 어떤 모델로 돌아가?" → runtime_info(claude-opus-4-8, cloud). Railway 로그에 `[agent] 실행 모델: …` 확인. (2) "네 db 구조 보여줘" → db_schema. (3) "내 기억 목록" → db_query 정상. (4) 쓰기 SQL 요청 → READ ONLY 거부(사전검사 또는 tx). (5) 손님/서버에선 이 도구들이 없음.
- **실 Supabase 스모크 필수**(pg-mem 미검증분): READ ONLY tx 가 쓰기를 실제로 거부하는지, information_schema schema() 반환, statement_timeout.

## Self-Review 메모(작성자 확인 완료)
- 스펙 커버리지: §3.1 db_schema→T3+T4, §3.2 db_query→T2(가드)+T3(tx)+T4(도구), §3.3 runtime_info→T4+T5, §3.5 모델→T1+T5+T6, §4 안전→T2(사전검사)+T3(READ ONLY tx)+T4(게이팅), §6 persona→T6, §7 배선→T5+T6. 누락 없음.
- 타입 일관성: `IntrospectRepo`/`RuntimeInfo`/`ToolCtx.repos.introspect`/`ToolCtx.runtime`/`makeRunAgentTurn(repos,deployTarget,model)`/`buildToolCtx(repos,context,runtime)` 가 T3→T6 전반 동일.
- pg-mem 위험: T3 스파이크로 READ ONLY/information_schema/timeout 지원을 먼저 확인, 미지원분은 실 Supabase 스모크로 명시(은닉 없음).
