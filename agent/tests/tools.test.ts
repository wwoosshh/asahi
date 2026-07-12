import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { UsersRepo } from "../src/store/usersRepo.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import {
  rememberHandler, recallHandler, manageAccessHandler,
  allowDirHandler, revokeDirHandler, listDirsHandler,
  allowedToolsFor, type ToolCtx,
} from "../src/core/tools.js";

function ctx(over: Partial<ToolCtx> = {}): ToolCtx {
  const db = openDb(":memory:");
  return {
    repos: { memories: new MemoriesRepo(db), users: new UsersRepo(db), allowedDirs: new AllowedDirsRepo(new SettingsRepo(db)) },
    role: "allowed", isPrivate: true, isOwner: false, userId: "guest", conversationId: 1,
    ...over,
  };
}

describe("remember 도구", () => {
  it("항상 현재 상대(userId)·scope='user' 로 저장한다(손님은 shared 를 못 쓴다)", () => {
    const c = ctx({ userId: "guest", isPrivate: true, isOwner: false });
    rememberHandler(c, { title: "선호", content: "커피는 아메리카노" });
    const all = c.repos.memories.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: "guest", scope: "user", title: "선호" });
  });
});

describe("recall 도구 — 프라이버시 스코프", () => {
  it("손님 DM 은 본인+공용만, 타인 개인기억은 제외", () => {
    const c = ctx({ userId: "guest", isPrivate: true, isOwner: false });
    c.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님메모입니다" });
    c.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자메모입니다" });
    c.repos.memories.insert({ userId: "owner", scope: "shared", title: "s", content: "공용메모입니다" });
    const out = recallHandler(c, { query: "메모" });
    expect(out).toContain("손님메모입니다");
    expect(out).toContain("공용메모입니다");
    expect(out).not.toContain("소유자메모입니다");
  });

  it("소유자 DM 은 전원 기억을 검색한다", () => {
    const c = ctx({ userId: "owner", isPrivate: true, isOwner: true });
    c.repos.memories.insert({ userId: "guest", scope: "user", title: "g", content: "손님메모입니다" });
    c.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자메모입니다" });
    c.repos.memories.insert({ userId: "owner", scope: "shared", title: "s", content: "공용메모입니다" });
    const out = recallHandler(c, { query: "메모" });
    expect(out).toContain("손님메모입니다");
    expect(out).toContain("소유자메모입니다");
    expect(out).toContain("공용메모입니다");
  });

  it("서버(비공개 아님)는 소유자여도 공용만 검색한다(개인기억 미노출)", () => {
    const c = ctx({ userId: "owner", isPrivate: false, isOwner: true });
    c.repos.memories.insert({ userId: "owner", scope: "user", title: "o", content: "소유자메모입니다" });
    c.repos.memories.insert({ userId: "owner", scope: "shared", title: "s", content: "공용메모입니다" });
    const out = recallHandler(c, { query: "메모" });
    expect(out).toContain("공용메모입니다");
    expect(out).not.toContain("소유자메모입니다");
  });
});

describe("manage_access 도구", () => {
  it("소유자 DM 이 아니면 거부하고 아무것도 바꾸지 않는다", () => {
    const guest = ctx({ isOwner: false, isPrivate: true });
    expect(manageAccessHandler(guest, { userId: "999", role: "allowed" })).toContain("소유자");
    expect(guest.repos.users.getRole("999")).toBe("blocked");

    const ownerServer = ctx({ isOwner: true, isPrivate: false });
    manageAccessHandler(ownerServer, { userId: "999", role: "allowed" });
    expect(ownerServer.repos.users.getRole("999")).toBe("blocked");
  });

  it("소유자 DM 에서 명시적 숫자 ID 로 역할을 설정한다", () => {
    const owner = ctx({ userId: "owner", isOwner: true, isPrivate: true });
    const out = manageAccessHandler(owner, { userId: "123456789", role: "allowed" });
    expect(owner.repos.users.getRole("123456789")).toBe("allowed");
    expect(out).toContain("123456789");
  });

  it("표시명 등 비-스노플레이크는 거부한다(오작동 방지)", () => {
    const owner = ctx({ userId: "owner", isOwner: true, isPrivate: true });
    manageAccessHandler(owner, { userId: "철수", role: "allowed" });
    expect(owner.repos.users.getRole("철수")).toBe("blocked");
  });

  it("owner 역할 부여는 거부한다(제2 소유자 생성 차단 — 신원 게이트 우회 방지)", () => {
    const owner = ctx({ userId: "owner", isOwner: true, isPrivate: true });
    manageAccessHandler(owner, { userId: "123456789", role: "owner" });
    expect(owner.repos.users.getRole("123456789")).toBe("blocked"); // 미적용
  });
});

describe("allow_dir/revoke_dir/list_dir 도구(§원격개발 A2) — 소유자 DM 전용", () => {
  it("소유자 DM 에서 실제 존재하는 디렉토리를 허용하면 list 에 반영된다", () => {
    const owner = ctx({ isOwner: true, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-"));
    const out = allowDirHandler(owner, { path: dir });
    expect(out).toContain(path.resolve(dir));
    expect(owner.repos.allowedDirs.list()).toEqual([path.resolve(dir)]);
    expect(listDirsHandler(owner)).toContain(path.resolve(dir));
  });

  it("존재하지 않는 경로는 거부하고 아무것도 추가하지 않는다", () => {
    const owner = ctx({ isOwner: true, isPrivate: true });
    const bogus = path.join(os.tmpdir(), "asahi-does-not-exist-xyz");
    const out = allowDirHandler(owner, { path: bogus });
    expect(owner.repos.allowedDirs.list()).toEqual([]);
    expect(out).toContain("찾을 수 없어요");
  });

  it("디렉토리가 아닌 파일 경로는 거부한다", () => {
    const owner = ctx({ isOwner: true, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-allowdir-file-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");
    allowDirHandler(owner, { path: file });
    expect(owner.repos.allowedDirs.list()).toEqual([]);
  });

  it("심링크(정션)로 등록해도 실경로로 정규화해 저장한다(과차단 방지, 보안리뷰 #4)", () => {
    const owner = ctx({ isOwner: true, isPrivate: true });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-realdir-"));
    const link = path.join(os.tmpdir(), `asahi-junction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      // 이 환경에서 정션/심링크 생성 권한이 없으면 스킵한다(코드리뷰로 갈음).
      return;
    }
    try {
      const real = fs.realpathSync(link);
      const out = allowDirHandler(owner, { path: link });
      expect(owner.repos.allowedDirs.list()).toEqual([real]);
      expect(owner.repos.allowedDirs.list()).not.toContain(path.resolve(link));
      expect(out).toContain(real);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("revoke_dir 은 허용 목록에서 제거한다", () => {
    const owner = ctx({ isOwner: true, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-revokedir-"));
    owner.repos.allowedDirs.add(dir);
    const out = revokeDirHandler(owner, { path: dir });
    expect(owner.repos.allowedDirs.list()).toEqual([]);
    expect(out).toContain(path.resolve(dir));
  });

  it("list_dir 은 비어있으면 안내 문구를 반환한다", () => {
    const owner = ctx({ isOwner: true, isPrivate: true });
    expect(listDirsHandler(owner)).toContain("없어요");
  });

  it("손님 DM 에서는 세 도구 모두 거부하고 아무것도 바꾸지 않는다", () => {
    const guest = ctx({ isOwner: false, isPrivate: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-guest-"));
    expect(allowDirHandler(guest, { path: dir })).toContain("소유자");
    expect(guest.repos.allowedDirs.list()).toEqual([]);
    guest.repos.allowedDirs.add(dir); // 이후 상태로 revoke 시도 검증
    expect(revokeDirHandler(guest, { path: dir })).toContain("소유자");
    expect(guest.repos.allowedDirs.list()).toEqual([path.resolve(dir)]);
    expect(listDirsHandler(guest)).toContain("소유자");
  });

  it("서버(비공개 아님)에서는 소유자여도 세 도구 모두 거부한다", () => {
    const ownerServer = ctx({ isOwner: true, isPrivate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asahi-ownerserver-"));
    expect(allowDirHandler(ownerServer, { path: dir })).toContain("소유자");
    expect(ownerServer.repos.allowedDirs.list()).toEqual([]);
    expect(listDirsHandler(ownerServer)).toContain("소유자");
  });
});

describe("allowedToolsFor — 능력 계층(§7.1)", () => {
  it("소유자 DM 은 파일 도구 + remember/recall/manage_access + Bash + dir 관리 도구", () => {
    const tools = allowedToolsFor("owner", true, true);
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("mcp__asahi__remember");
    expect(tools).toContain("mcp__asahi__recall");
    expect(tools).toContain("mcp__asahi__manage_access");
    expect(tools).toContain("Bash");
    expect(tools).toContain("mcp__asahi__allow_dir");
    expect(tools).toContain("mcp__asahi__revoke_dir");
    expect(tools).toContain("mcp__asahi__list_dirs");
  });

  it("손님 DM 은 remember/recall 만(파일·manage_access·Bash·dir 도구 없음)", () => {
    const tools = allowedToolsFor("allowed", true, false);
    expect(tools).toEqual(["mcp__asahi__remember", "mcp__asahi__recall"]);
    expect(tools).not.toContain("Read");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("mcp__asahi__manage_access");
    expect(tools).not.toContain("mcp__asahi__allow_dir");
  });

  it("서버 턴은 recall(공용)만 — 개인기억 저장·PC 도구·dir 도구 불가", () => {
    expect(allowedToolsFor("owner", false, false)).toEqual(["mcp__asahi__recall"]);
    expect(allowedToolsFor("allowed", false, false)).toEqual(["mcp__asahi__recall"]);
  });
});
