import type { SettingsRepo } from "./settingsRepo.js";
import type { AllowedDirsRepo } from "./allowedDirsRepo.js";

const LEGACY_KEY = "owner.allowedDirs";

// 리뷰 #6(LOW): allowed_dirs 테이블(하이브리드 조각3, 사용자별 로컬 워커) 도입 전에는
// owner.allowedDirs 라는 단일 settings 키(JSON 문자열 배열)에 소유자 허용 폴더를 저장했다
// (AllowedDirsRepo 가 SettingsRepo 를 감싸던 시절 — 지금은 allowed_dirs 테이블을 직접 본다).
// 그 전환에 이관 로직이 없어서, 이미 그 설정을 써온 배포라면 소유자의 허용 폴더가 새 테이블에는
// 하나도 없는 것처럼 보인다(유실처럼 보이지만 사실은 settings 테이블에 그대로 남아있음).
// 부팅마다 호출해도 안전하도록 멱등(AllowedDirsRepo.add 의 ON CONFLICT DO NOTHING)하게 작성한다 —
// "이미 옮겼는지" 별도 플래그를 두지 않고 그냥 매번 시도한다.
export async function backfillLegacyAllowedDirs(
  settings: SettingsRepo,
  allowedDirs: AllowedDirsRepo,
  ownerId: string,
): Promise<void> {
  const raw = await settings.get(LEGACY_KEY);
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[allowedDirsMigration] owner.allowedDirs 값이 유효한 JSON 이 아니어서 건너뜁니다:", raw);
    return;
  }
  if (!Array.isArray(parsed)) return;
  for (const dir of parsed) {
    if (typeof dir === "string" && dir.length > 0) {
      await allowedDirs.add(ownerId, dir);
    }
  }
}
