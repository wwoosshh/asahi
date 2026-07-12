import { describe, it, expect } from "vitest";
import path from "node:path";
import { openTestDb } from "../src/store/db.js";
import { SettingsRepo } from "../src/store/settingsRepo.js";
import { AllowedDirsRepo } from "../src/store/allowedDirsRepo.js";
import { backfillLegacyAllowedDirs } from "../src/store/allowedDirsMigration.js";

// 리뷰 #6(LOW): allowed_dirs 테이블 도입(하이브리드 조각3) 이전에는 owner.allowedDirs 라는 단일
// settings 키(JSON 문자열 배열)에 소유자 허용 폴더를 저장했다. 스키마 전환 시 별도 이관 없이
// AllowedDirsRepo 가 통째로 새 테이블을 보게 바뀌어서, 기존에 그 설정을 실제로 써온 배포라면
// 소유자의 허용 폴더가 통째로 유실된 것처럼 보인다(테이블은 비어 있고 레거시 키만 남음).
describe("backfillLegacyAllowedDirs — owner.allowedDirs → allowed_dirs 테이블 이전", () => {
  it("레거시 키가 있으면 소유자 id 로 allowed_dirs 에 옮긴다", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const allowedDirs = new AllowedDirsRepo(db);
    await settings.set("owner.allowedDirs", JSON.stringify(["C:\\proj\\a", "C:\\proj\\b"]));

    await backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1");

    expect((await allowedDirs.list("owner-1")).sort()).toEqual(
      [path.resolve("C:\\proj\\a"), path.resolve("C:\\proj\\b")].sort(),
    );
  });

  it("레거시 키가 없으면 아무 것도 하지 않는다", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const allowedDirs = new AllowedDirsRepo(db);

    await backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1");

    expect(await allowedDirs.list("owner-1")).toEqual([]);
  });

  it("멱등 — 두 번 호출해도 중복되지 않는다(재부팅마다 반복 호출해도 안전)", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const allowedDirs = new AllowedDirsRepo(db);
    await settings.set("owner.allowedDirs", JSON.stringify(["C:\\proj\\a"]));

    await backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1");
    await backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1");

    expect(await allowedDirs.list("owner-1")).toEqual([path.resolve("C:\\proj\\a")]);
  });

  it("allowed_dirs 에 이미 별도로 등록된 폴더가 있어도 레거시 백필과 병존한다(유실 없이 병합)", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const allowedDirs = new AllowedDirsRepo(db);
    await allowedDirs.add("owner-1", "C:\\proj\\already");
    await settings.set("owner.allowedDirs", JSON.stringify(["C:\\proj\\legacy"]));

    await backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1");

    expect((await allowedDirs.list("owner-1")).sort()).toEqual(
      [path.resolve("C:\\proj\\already"), path.resolve("C:\\proj\\legacy")].sort(),
    );
  });

  it("레거시 값이 깨진 JSON 이면 조용히 무시한다(부팅 실패 방지)", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const allowedDirs = new AllowedDirsRepo(db);
    await settings.set("owner.allowedDirs", "{이건 유효한 JSON 배열이 아님");

    await expect(backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1")).resolves.toBeUndefined();
    expect(await allowedDirs.list("owner-1")).toEqual([]);
  });

  it("배열이 아닌 JSON(예: 객체)이면 무시한다", async () => {
    const db = await openTestDb();
    const settings = new SettingsRepo(db);
    const allowedDirs = new AllowedDirsRepo(db);
    await settings.set("owner.allowedDirs", JSON.stringify({ not: "an array" }));

    await backfillLegacyAllowedDirs(settings, allowedDirs, "owner-1");

    expect(await allowedDirs.list("owner-1")).toEqual([]);
  });
});
