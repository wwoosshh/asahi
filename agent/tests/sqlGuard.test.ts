import { describe, it, expect } from "vitest";
import { assertReadOnlySql, formatQueryResult } from "../src/core/sqlGuard.js";

describe("assertReadOnlySql", () => {
  it("단순 SELECT·WITH…SELECT·개행/주석 포함을 허용한다", () => {
    for (const ok of [
      "SELECT 1",
      "  select * from users limit 5",
      "SELECT count(*)\nFROM messages\nWHERE role='user'",
      "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
      "-- 주석\nSELECT id FROM conversations",
    ]) {
      expect(() => assertReadOnlySql(ok)).not.toThrow();
    }
  });

  it("쓰기·DDL·다중문·빈 문자열을 거부한다", () => {
    for (const bad of [
      "INSERT INTO users VALUES ('x')",
      "UPDATE users SET role='owner'",
      "DELETE FROM messages",
      "DROP TABLE users",
      "ALTER TABLE users ADD COLUMN x int",
      "TRUNCATE messages",
      "GRANT ALL ON users TO public",
      "SELECT 1; DROP TABLE users",   // 다중문
      "select 1; select 2",           // 다중문
      "",
      "   ",
      "explain analyze select 1",     // 부작용 가능(analyze) — SELECT/WITH 로 시작 안 함
    ]) {
      expect(() => assertReadOnlySql(bad)).toThrow();
    }
  });
});

describe("formatQueryResult", () => {
  it("행을 표로 만들고 잘린 행수를 알린다", () => {
    const out = formatQueryResult([{ id: 1, name: "a" }, { id: 2, name: "b" }], 3);
    expect(out).toMatch(/id/);
    expect(out).toMatch(/name/);
    expect(out).toMatch(/…외 3행/);
  });
  it("빈 결과를 안내한다", () => {
    expect(formatQueryResult([], 0)).toMatch(/결과 없음|행 없음/);
  });
  it("긴 셀 값을 절단한다", () => {
    const long = "x".repeat(1000);
    const out = formatQueryResult([{ c: long }], 0, { maxCell: 20 });
    expect(out).not.toContain(long);
    expect(out).toMatch(/…/);
  });
});
