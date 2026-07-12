import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { buildToolCtx, type TurnContext, type ToolRepos } from "../src/core/agent.js";
import { allowDirHandler, type RuntimeInfo } from "../src/core/tools.js";

const testRuntime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 };

// 리뷰 #1(HIGH): makeRunAgentTurn 이 ctx(ToolCtx) 를 만들 때 TurnContext.ownWorkstation 을 복사하지
// 않아서, 워커 턴(자기 PC 전권)에서도 allow_dir 등 PC 관리 도구의 실제 핸들러(canManagePc)가 항상
// 거부됐다 — allowedToolsFor 는 req.context.ownWorkstation 을 직접 보고 도구 목록엔 넣어주지만,
// 정작 핸들러에 전달되는 ctx 에는 그 필드가 빠져 있어 "도구는 보이는데 실행하면 거부"라는 불일치가
// 생겼다. buildToolCtx 를 별도 순수 함수로 뽑아 makeRunAgentTurn 과 이 테스트가 같은 경로를 검증한다.
async function repos(): Promise<ToolRepos> {
  const db = await openTestDb();
  return { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(db), introspect: new IntrospectRepo(db) };
}

describe("buildToolCtx — makeRunAgentTurn 의 ToolCtx 구성(리뷰 #1 회귀)", () => {
  it("ownWorkstation 을 포함해 TurnContext 의 모든 필드를 ToolCtx 로 그대로 복사한다", async () => {
    const r = await repos();
    const context: TurnContext = { role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 7, ownWorkstation: true };
    const ctx = buildToolCtx(r, context, testRuntime);
    expect(ctx).toMatchObject({ role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 7, ownWorkstation: true });
  });

  it("ownWorkstation 이 없으면(봇/소유자 DM 경로) undefined 로 그대로 전달된다", async () => {
    const r = await repos();
    const context: TurnContext = { role: "owner", isPrivate: true, isOwner: true, userId: "owner", conversationId: 1 };
    const ctx = buildToolCtx(r, context, testRuntime);
    expect(ctx.ownWorkstation).toBeUndefined();
  });

  it("회귀: ownWorkstation=true 로 만든 ctx 는 allowDirHandler(canManagePc) 를 통과시킨다(수정 전엔 누락되어 손님 워커 턴에서 거부됐다)", async () => {
    const r = await repos();
    const context: TurnContext = { role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 1, ownWorkstation: true };
    const ctx = buildToolCtx(r, context, testRuntime);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-buildctx-"));
    const out = await allowDirHandler(ctx, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(await ctx.repos.allowedDirs.list("guest")).toEqual([path.resolve(dir)]);
  });

  it("buildToolCtx 는 introspect 리포와 runtime 을 ctx 로 옮긴다", async () => {
    const db = await openTestDb();
    const repos: ToolRepos = { memories: {} as any, users: {} as any, allowedDirs: {} as any, introspect: new IntrospectRepo(db) };
    const runtime: RuntimeInfo = { model: "claude-opus-4-8", sdkVersion: "0.3.207", deployTarget: "local", maxTurns: 30 };
    const ctx = buildToolCtx(repos, { role: "owner", isPrivate: true, isOwner: true, userId: "o", conversationId: 1 }, runtime);
    expect(ctx.repos.introspect).toBe(repos.introspect);
    expect(ctx.runtime.model).toBe("claude-opus-4-8");
  });
});
