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
