import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { IntrospectRepo } from "../src/store/introspectRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";

// 스파이크 결과(agent/tests/_spike.test.ts, 삭제됨 — 결과는 커밋 메시지·report 참고):
// - information_schema.columns 조회: OK
// - SET TRANSACTION READ ONLY: FAIL(pg-mem 파싱 자체를 못 함 — "Unexpected word token: read")
// - SET LOCAL statement_timeout = N: OK(파싱은 되지만 강제하지는 않음)
// - READ ONLY 트랜잭션 안에서 INSERT 거부: FAIL(pg-mem 은 애초에 READ ONLY 를 파싱 못 해 강제도 없음)
// → readOnlyQuery 는 pg-mem 에서 실행 자체가 안 되므로(SET TRANSACTION READ ONLY 에서 예외) 아래
//   테스트는 it.skip 로 남기고 실 Supabase 스모크로 검증한다. schema() 는 information_schema 가
//   pg-mem 에서 OK 였으므로 정상 실행한다.
describe("IntrospectRepo.readOnlyQuery", () => {
  let db: Db;
  beforeEach(async () => { db = await openTestDb(); });

  // pg-mem 이 `SET TRANSACTION READ ONLY` 를 파싱하지 못해(스파이크 FAIL) 이 경로 전체가
  // pg-mem 에서 실행 불가능하다. 진짜 방어선(Postgres READ ONLY 트랜잭션)은 실 Supabase
  // 스모크로만 검증할 수 있다 — 여기서는 은닉하지 않고 skip 사유를 남긴다.
  it.skip("정상 SELECT 결과 행을 반환하고 maxRows 로 자른다(실 Supabase 스모크 필요)", async () => {
    const msgs = new MessagesRepo(db);
    for (let i = 0; i < 5; i++) await msgs.insert({ conversationId: 1, ts: i, role: "user", userId: "u", content: `m${i}` });
    const repo = new IntrospectRepo(db);
    const { rows, truncated } = await repo.readOnlyQuery("SELECT id FROM messages ORDER BY id", { maxRows: 3 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(2);
  });
});

describe("IntrospectRepo.schema", () => {
  it("테이블·컬럼을 문자열로 반환한다(information_schema)", async () => {
    const db = await openTestDb();
    const repo = new IntrospectRepo(db);
    const s = await repo.schema();
    expect(s).toMatch(/messages/);
    expect(s).toMatch(/conversations/);
  });
});
