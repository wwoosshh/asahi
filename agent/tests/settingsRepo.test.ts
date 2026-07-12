import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";

describe("SettingsRepo", () => {
  let repo: SettingsRepo;
  beforeEach(async () => { repo = new SettingsRepo(await openTestDb()); });

  it("설정을 저장/조회/삭제한다", async () => {
    expect(await repo.get("k")).toBeNull();
    await repo.set("k", "v1");
    expect(await repo.get("k")).toBe("v1");
    await repo.set("k", "v2");
    expect(await repo.get("k")).toBe("v2");
    await repo.delete("k");
    expect(await repo.get("k")).toBeNull();
  });
});
