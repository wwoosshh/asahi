import type { SettingsRepo } from "./settingsRepo.js";
import { normalizeDir } from "../core/paths.js";

const KEY = "owner.allowedDirs";

// 소유자가 원격 개발 작업을 허용한 폴더 목록. 실제 fs 존재 검증은 하지 않는다(도구 계층의 몫).
export class AllowedDirsRepo {
  constructor(private settings: SettingsRepo) {}

  list(): string[] {
    const raw = this.settings.get(KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  add(dir: string): void {
    const norm = normalizeDir(dir);
    const current = this.list();
    if (current.includes(norm)) return;
    this.save([...current, norm]);
  }

  remove(dir: string): void {
    const norm = normalizeDir(dir);
    const current = this.list();
    this.save(current.filter((d) => d !== norm));
  }

  private save(dirs: string[]): void {
    this.settings.set(KEY, JSON.stringify(dirs));
  }
}
