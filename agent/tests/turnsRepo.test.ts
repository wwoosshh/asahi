import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { TurnsRepo } from "../src/store/turnsRepo.js";

const HOUR = 60 * 60 * 1000;
function opts(over: Partial<Parameters<TurnsRepo["reserve"]>[0]> = {}) {
  return { userId: "u1", conversationId: 1, kind: "message" as const, ts: 1_000_000, perUserLimit: 2, globalLimit: 10, ownerReserve: 2, isOwner: false, windowMs: HOUR, ...over };
}

// 주의(pg-mem 한계): 아래 테스트들은 순차 호출로 "한도 검사 로직"만 검증한다.
// pg-mem 은 pg_advisory_xact_lock 을 no-op 스텁으로만 흉내내고 트랜잭션도 순차 실행되므로,
// 진짜 동시 예약 경합에서 advisory lock 이 직렬화를 보장하는지는 이 유닛테스트로 확인할 수
// 없다 — 그건 실제 Postgres 를 쓰는 통합/스모크 테스트 몫이다.
describe("TurnsRepo.reserve", () => {
  let repo: TurnsRepo;
  beforeEach(async () => { repo = new TurnsRepo(await openTestDb()); });

  it("유저 한도 안에서는 예약 성공, 넘으면 거부", async () => {
    expect(await repo.reserve(opts())).toBe(true);
    expect(await repo.reserve(opts({ ts: 1_000_001 }))).toBe(true);
    expect(await repo.reserve(opts({ ts: 1_000_002 }))).toBe(false); // perUserLimit=2 초과
    expect(await repo.countUser("u1", 1_000_000 - HOUR)).toBe(2);     // 거부된 건은 미기록
  });

  it("손님 전역 상한은 globalLimit-ownerReserve, 소유자는 예약분 접근 가능", async () => {
    // globalLimit=3, ownerReserve=1 → 손님은 2까지
    for (let i = 0; i < 2; i++) expect(await repo.reserve(opts({ userId: `g${i}`, perUserLimit: 99, globalLimit: 3, ownerReserve: 1, ts: 1_000_000 + i }))).toBe(true);
    expect(await repo.reserve(opts({ userId: "g9", perUserLimit: 99, globalLimit: 3, ownerReserve: 1, ts: 1_000_010 }))).toBe(false); // 손님 상한(2) 도달
    // 소유자는 예약분까지(전역 3) 접근 → 성공
    expect(await repo.reserve(opts({ userId: "owner", isOwner: true, perUserLimit: 99, globalLimit: 3, ownerReserve: 1, ts: 1_000_011 }))).toBe(true);
  });

  it("윈도우 밖 오래된 턴은 카운트에서 제외", async () => {
    await repo.reserve(opts({ ts: 0 })); // 1시간보다 훨씬 전 → 이후 창 밖
    const t = 2 * HOUR;            // 창 시작(t-HOUR=HOUR>0)이라 ts=0 은 카운트 제외
    expect(await repo.reserve(opts({ ts: t }))).toBe(true);     // 창 안 0건 → 예약
    expect(await repo.reserve(opts({ ts: t + 1 }))).toBe(true); // 창 안 1건(ts=t)만 셈 → perUserLimit 2 미만 → 통과
  });
});
