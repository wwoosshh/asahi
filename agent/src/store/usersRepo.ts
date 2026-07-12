import type { Db } from "./db.js";

export type Role = "owner" | "allowed" | "blocked";

export class UsersRepo {
  private now: () => number;
  constructor(private db: Db, now: () => number = Date.now) { this.now = now; }

  async upsert(id: string, patch: { role?: Role; displayName?: string }): Promise<void> {
    const t = this.now();
    await this.db.query(
      `INSERT INTO users (id, role, display_name, created_ts, updated_ts)
       VALUES ($1, COALESCE($2,'blocked'), $3, $4, $4)
       ON CONFLICT (id) DO UPDATE SET
         role = COALESCE($2, users.role),
         display_name = COALESCE($3, users.display_name),
         updated_ts = $4`,
      [id, patch.role ?? null, patch.displayName ?? null, t],
    );
  }

  async getRole(id: string): Promise<Role> {
    const r = await this.db.query("SELECT role FROM users WHERE id = $1", [id]);
    const row = r.rows[0] as { role: Role } | undefined;
    return row?.role ?? "blocked";
  }

  async list(role?: Role): Promise<Array<{ id: string; role: Role; displayName: string | null }>> {
    const r = role
      ? await this.db.query("SELECT id, role, display_name FROM users WHERE role = $1 ORDER BY id", [role])
      : await this.db.query("SELECT id, role, display_name FROM users ORDER BY id");
    const rows = r.rows as Array<{ id: string; role: Role; display_name: string | null }>;
    return rows.map((row) => ({ id: row.id, role: row.role, displayName: row.display_name }));
  }
}
