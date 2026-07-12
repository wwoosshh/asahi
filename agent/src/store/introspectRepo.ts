import type { Db } from "./db.js";

// 자기 구조·데이터 읽기(자기인지). 쓰기는 하지 않는다 — readOnlyQuery 는 Postgres READ ONLY
// 트랜잭션에서 실행되어(핵심 방어선), 사전검사(assertReadOnlySql, tools 에서 호출)를 뚫은 쓰기도
// DB 가 거부한다. pg-mem 은 `SET TRANSACTION READ ONLY` 를 파싱하지 못해(스파이크로 확인 — 구문
// 오류) READ ONLY 강제를 전혀 흉내내지 못한다 — 해당 보장은 실 Supabase 스모크로만 검증한다.
export class IntrospectRepo {
  constructor(private db: Db) {}

  async schema(): Promise<string> {
    const r = await this.db.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map<string, string[]>();
    for (const row of r.rows as { table_name: string; column_name: string; data_type: string }[]) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(`${row.column_name} ${row.data_type}`);
      byTable.set(row.table_name, list);
    }
    if (byTable.size === 0) return "(스키마 정보를 읽을 수 없어요)";
    return [...byTable.entries()].map(([t, cols]) => `## ${t}\n- ${cols.join("\n- ")}`).join("\n\n");
  }

  async readOnlyQuery(sql: string, opts: { maxRows?: number; timeoutMs?: number } = {}): Promise<{ rows: Record<string, unknown>[]; truncated: number }> {
    const maxRows = opts.maxRows ?? 100;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // 핵심 방어선: 이 두 SET 은 절대 .catch(() => {}) 로 삼키지 않는다. 실패하면(예: 연결이
      // READ ONLY 를 지원하지 않는 이상한 상태) 쿼리 자체를 실행하지 않고 위로 던져야
      // "사전검사를 뚫은 쓰기도 DB 가 거부한다"는 보장이 유지된다.
      await client.query("SET TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
      const r = await client.query(sql);
      const all = (r.rows ?? []) as Record<string, unknown>[];
      const rows = all.slice(0, maxRows);
      return { rows, truncated: Math.max(0, all.length - rows.length) };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
}
