import type { Db } from "./db.js";

// T2/T3 Repo 패턴의 파일럿: 생성자는 Db(pg Pool) 를 받고, 모든 메서드는 async,
// SQL 은 $n 파라미터 + ON CONFLICT 로 작성한다.
export class SettingsRepo {
  constructor(private db: Db) {}

  async get(key: string): Promise<string | null> {
    const r = await this.db.query("SELECT value FROM settings WHERE key = $1", [key]);
    const row = r.rows[0] as { value: string } | undefined;
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.query("DELETE FROM settings WHERE key = $1", [key]);
  }
}
