// 읽기 전용 SQL 가드(순수). 완전한 SQL 파서가 아니라 "명백한 쓰기/다중문을 빠르게 거부"하는
// 1차 방어다 — 진짜 방어선은 IntrospectRepo.readOnlyQuery 의 Postgres READ ONLY 트랜잭션이다.
// (예: `WITH x AS (DELETE … RETURNING *) SELECT …` 같이 문두가 WITH 인 쓰기 CTE 는 이 pre-check 를
//  통과하지만, READ ONLY 트랜잭션이 실행 시점에 거부한다 — 그게 핵심 방어다.)

// 주석(줄 -- / 블록 /* */) 제거 후 앞뒤 공백 정리.
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
}

export function assertReadOnlySql(sql: string): void {
  const cleaned = stripComments(sql);
  if (cleaned.length === 0) throw new Error("빈 쿼리예요. SELECT 문을 주세요.");
  // 다중문 금지: 마지막의 세미콜론 하나만 허용하고, 그 외 위치의 세미콜론은 다중문으로 본다.
  const withoutTrailing = cleaned.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) throw new Error("한 번에 하나의 SELECT 문만 실행할 수 있어요(다중 문장 금지).");
  const firstWord = withoutTrailing.split(/[\s(]/, 1)[0].toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new Error("읽기 전용 SELECT(또는 WITH … SELECT)만 실행할 수 있어요.");
  }
}

export function formatQueryResult(rows: Record<string, unknown>[], truncated: number, opts: { maxCell?: number } = {}): string {
  const maxCell = opts.maxCell ?? 500;
  if (rows.length === 0) return "(결과 없음)";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > maxCell ? `${s.slice(0, maxCell)}…` : s;
  };
  const header = cols.join(" | ");
  const lines = rows.map((r) => cols.map((c) => cell(r[c])).join(" | "));
  const body = [header, ...lines].join("\n");
  return truncated > 0 ? `${body}\n…외 ${truncated}행 더 있음` : body;
}
