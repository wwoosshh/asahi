import type { SettingsRepo } from "./settingsRepo.js";
import { normalizeDir } from "../core/paths.js";

const KEY = "owner.allowedDirs";

// 소유자가 원격 개발 작업을 허용한 폴더 목록. 실제 fs 존재 검증은 하지 않는다(도구 계층의 몫).
export class AllowedDirsRepo {
  constructor(private settings: SettingsRepo) {}

  async list(): Promise<string[]> {
    const raw = await this.settings.get(KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  async add(dir: string): Promise<void> {
    const norm = normalizeDir(dir);
    const current = await this.list();
    if (current.includes(norm)) return;
    await this.save([...current, norm]);
  }

  async remove(dir: string): Promise<void> {
    const norm = normalizeDir(dir);
    const current = await this.list();
    await this.save(current.filter((d) => d !== norm));
  }

  private async save(dirs: string[]): Promise<void> {
    await this.settings.set(KEY, JSON.stringify(dirs));
  }
}
