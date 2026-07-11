import type Database from "better-sqlite3";

export type Role = "owner" | "allowed" | "blocked";

export class UsersRepo {
  private now: () => number;
  constructor(private db: Database.Database, now: () => number = Date.now) { this.now = now; }

  upsert(id: string, patch: { role?: Role; displayName?: string }): void {
    const t = this.now();
    this.db.prepare(
      `INSERT INTO users (id, role, display_name, created_ts, updated_ts)
       VALUES (@id, COALESCE(@role,'blocked'), @displayName, @t, @t)
       ON CONFLICT(id) DO UPDATE SET
         role = COALESCE(@role, users.role),
         display_name = COALESCE(@displayName, users.display_name),
         updated_ts = @t`,
    ).run({ id, role: patch.role ?? null, displayName: patch.displayName ?? null, t });
  }

  getRole(id: string): Role {
    const row = this.db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: Role } | undefined;
    return row?.role ?? "blocked";
  }

  list(role?: Role): Array<{ id: string; role: Role; displayName: string | null }> {
    const rows = (role
      ? this.db.prepare("SELECT id, role, display_name FROM users WHERE role = ? ORDER BY id").all(role)
      : this.db.prepare("SELECT id, role, display_name FROM users ORDER BY id").all()) as Array<{ id: string; role: Role; display_name: string | null }>;
    return rows.map((r) => ({ id: r.id, role: r.role, displayName: r.display_name }));
  }
}
