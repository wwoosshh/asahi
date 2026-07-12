import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { openDb } from "../src/store/db.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";

describe("AllowedDirsRepo", () => {
  let settings: SettingsRepo;
  let repo: AllowedDirsRepo;

  beforeEach(() => {
    settings = new SettingsRepo(openDb(":memory:"));
    repo = new AllowedDirsRepo(settings);
  });

  it("초기 상태는 빈 배열", () => {
    expect(repo.list()).toEqual([]);
  });

  it("add 하면 정규화된 절대경로로 저장되고 list 에 나타난다", () => {
    repo.add("C:\\proj\\a\\");
    expect(repo.list()).toEqual([path.resolve("C:\\proj\\a")]);
  });

  it("중복 add 는 무시한다(같은 경로를 다른 표기로 넣어도)", () => {
    repo.add("C:\\proj\\a");
    repo.add("C:\\proj\\a\\"); // 후행 슬래시만 다름 → 정규화 후 동일
    expect(repo.list()).toEqual([path.resolve("C:\\proj\\a")]);
  });

  it("여러 폴더를 add 하면 모두 누적된다", () => {
    repo.add("C:\\proj\\a");
    repo.add("C:\\proj\\b");
    expect(repo.list().sort()).toEqual([path.resolve("C:\\proj\\a"), path.resolve("C:\\proj\\b")].sort());
  });

  it("remove 하면 목록에서 제거된다", () => {
    repo.add("C:\\proj\\a");
    repo.add("C:\\proj\\b");
    repo.remove("C:\\proj\\a\\"); // 후행 슬래시 다르게 줘도 정규화되어 제거됨
    expect(repo.list()).toEqual([path.resolve("C:\\proj\\b")]);
  });

  it("존재하지 않는 dir 을 remove 해도 안전하다", () => {
    repo.add("C:\\proj\\a");
    repo.remove("C:\\nope");
    expect(repo.list()).toEqual([path.resolve("C:\\proj\\a")]);
  });

  it("손상된 settings 값(JSON 파싱 실패)이면 빈 배열로 안전 처리한다", () => {
    settings.set("owner.allowedDirs", "{ not valid json ][");
    expect(repo.list()).toEqual([]);
  });

  it("손상된 값이 있어도 add 하면 정상적으로 새 목록을 저장한다", () => {
    settings.set("owner.allowedDirs", "not json");
    repo.add("C:\\proj\\a");
    expect(repo.list()).toEqual([path.resolve("C:\\proj\\a")]);
  });
});
