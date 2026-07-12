import type { Db } from "./db.js";
import { normalizeDir } from "../core/paths.js";

// 사용자별로 원격 개발 작업을 허용한 폴더 목록. 실제 fs 존재 검증은 하지 않는다(도구 계층의 몫).
// 하이브리드 재설계 조각3(사용자별 로컬 워커) 이전에는 owner.allowedDirs 라는 단일 settings 키에
// 소유자 몫만 저장했지만, 이제 사용자별 로컬 워커가 각자의 허용 폴더를 갖도록 allowed_dirs 테이블로
// 옮겼다. 소유자는 지금까지처럼 자신의 userId(config.ownerId) 로 저장/조회되므로 동작은 동일하다.
export class AllowedDirsRepo {
  constructor(private db: Db) {}

  async list(userId: string): Promise<string[]> {
    const r = await this.db.query("SELECT dir FROM allowed_dirs WHERE user_id = $1 ORDER BY dir", [userId]);
    return (r.rows as { dir: string }[]).map((row) => row.dir);
  }

  async add(userId: string, dir: string): Promise<void> {
    const norm = normalizeDir(dir);
    await this.db.query(
      "INSERT INTO allowed_dirs (user_id, dir) VALUES ($1, $2) ON CONFLICT (user_id, dir) DO NOTHING",
      [userId, norm],
    );
  }

  async remove(userId: string, dir: string): Promise<void> {
    const norm = normalizeDir(dir);
    await this.db.query("DELETE FROM allowed_dirs WHERE user_id = $1 AND dir = $2", [userId, norm]);
  }
}
