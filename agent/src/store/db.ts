import { Pool } from "pg";
import type { PoolClient } from "pg";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

// 팀 계약(T2/T3 의 Repo 들이 생성자 인자로 이 타입을 받는다): pg 의 Pool 그대로.
// 운영에서는 실제 Postgres(Supabase) 에 붙는 Pool, 테스트에서는 pg-mem 이 만들어주는
// pg 호환 Pool 이다 — 둘 다 동일한 `query(text, params)` 인터페이스를 제공한다.
export type Db = Pool;

// 운영: 실제 Postgres 연결 문자열로 Pool 을 만들고 스키마를 보장한다.
export async function openDb(connectionString: string): Promise<Db> {
  const pool = new Pool({ connectionString });
  await initSchema(pool);
  return pool;
}

// 테스트: pg-mem 인메모리 DB 위에 pg 호환 Pool 을 만들어 스키마를 보장한다.
// 기존 코드가 `openDb(":memory:")` 를 많이 쓰던 것을 대체하는 통로 — 테스트는 이걸 쓴다.
export async function openTestDb(): Promise<Db> {
  const { newDb, DataType } = await import("pg-mem");
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem 은 pg_advisory_xact_lock 을 구현하지 않는다(스파이크로 확인).
  // TurnsRepo(다음 태스크) 가 동시성 제어에 이 함수를 쓸 예정이므로, 테스트에서는
  // no-op 스텁으로 등록해 SQL 이 그대로 실행되게 한다. 실제 동시성 보장은
  // 프로덕션 Postgres 에서만 유효하며, pg-mem 은 트랜잭션이 순차 실행되므로
  // 락 자체를 테스트하지는 못한다(아래 openTestDb 문서 참고).
  mem.public.registerFunction({
    name: "pg_advisory_xact_lock",
    args: [DataType.bigint],
    returns: DataType.bool,
    implementation: () => true,
  });

  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as Db;
  await initSchema(pool);
  return pool;
}

async function initSchema(db: Db): Promise<void> {
  await db.query(SCHEMA_SQL);
  await setSchemaVersion(db, Math.max(await getSchemaVersion(db), SCHEMA_VERSION));
}

export async function getSchemaVersion(db: Db): Promise<number> {
  const r = await db.query("SELECT value FROM meta WHERE key = 'schema_version'");
  const row = r.rows[0] as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export async function setSchemaVersion(db: Db, v: number): Promise<void> {
  await db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [String(v)],
  );
}

// 트랜잭션 헬퍼: 커넥션을 하나 빌려 BEGIN/COMMIT/ROLLBACK 을 감싼다.
// TurnsRepo 같이 "조회 후 조건부 삽입"을 원자적으로 해야 하는 Repo 가 사용한다.
// 주의: pg-mem 은 SQL 레벨 ROLLBACK 을 실제로 되돌리지 않는다(스파이크로 확인).
// 커밋 경로는 pg-mem 으로 검증 가능하지만, "에러 시 롤백됨"을 확인하는 테스트는
// 실제 Postgres(통합 테스트) 에서만 신뢰할 수 있다.
export async function withTx<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
