import type { Db } from "./db.js";
import { withTx } from "./db.js";

// 예약(reserve) 트랜잭션 전역 직렬화용 advisory lock 키. 고정된 임의의 상수로,
// turns 테이블 예약 로직만 이 키로 직렬화한다(다른 용도와 충돌 없게 임의값 사용).
const RESERVE_LOCK_KEY = 727001;

export class TurnsRepo {
  constructor(private db: Db) {}

  async countUser(userId: string, sinceTs: number): Promise<number> {
    const r = await this.db.query("SELECT COUNT(*) AS n FROM turns WHERE user_id = $1 AND ts > $2", [userId, sinceTs]);
    return Number((r.rows[0] as { n: number | string }).n);
  }

  async countGlobal(sinceTs: number): Promise<number> {
    const r = await this.db.query("SELECT COUNT(*) AS n FROM turns WHERE ts > $1", [sinceTs]);
    return Number((r.rows[0] as { n: number | string }).n);
  }

  // 유저별·전역 한도를 검사한 뒤 조건부로 INSERT 하는 것을 원자적으로 수행한다.
  // Postgres 에서는 withTx + pg_advisory_xact_lock 으로 전역 직렬 지점을 만들어
  // 동시 예약 경합(두 요청이 동시에 카운트를 읽고 둘 다 한도 통과로 착각하는 것)을 막는다.
  // 트랜잭션 종료(커밋/롤백) 시 advisory lock 은 자동 해제된다.
  //
  // 주의: pg-mem(유닛테스트 환경)은 pg_advisory_xact_lock 을 no-op 스텁으로만 흉내내고
  // (db.ts 참고), SQL 트랜잭션도 순차 실행되어 실제 락/롤백을 검증하지 못한다.
  // 이 파일의 유닛테스트는 "순차 호출에서 한도 로직이 맞는지"만 검증한다 — 진짜 동시
  // 예약 경합(두 요청이 동시에 들어왔을 때 advisory lock 이 정말 직렬화하는지)은
  // 실제 Postgres 를 쓰는 통합/스모크 테스트 몫이다.
  async reserve(o: { userId: string | null; conversationId: number | null; kind: "message" | "summary" | "proactive"; ts: number; perUserLimit: number; globalLimit: number; ownerReserve: number; isOwner: boolean; windowMs: number }): Promise<boolean> {
    const since = o.ts - o.windowMs;
    return withTx(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [RESERVE_LOCK_KEY]);

      if (o.userId !== null) {
        const ur = await client.query("SELECT COUNT(*) AS n FROM turns WHERE user_id = $1 AND ts > $2", [o.userId, since]);
        if (Number((ur.rows[0] as { n: number | string }).n) >= o.perUserLimit) return false;
      }

      const globalCap = o.isOwner ? o.globalLimit : Math.max(0, o.globalLimit - o.ownerReserve);
      const gr = await client.query("SELECT COUNT(*) AS n FROM turns WHERE ts > $1", [since]);
      if (Number((gr.rows[0] as { n: number | string }).n) >= globalCap) return false;

      await client.query(
        "INSERT INTO turns (ts, user_id, conversation_id, kind) VALUES ($1, $2, $3, $4)",
        [o.ts, o.userId, o.conversationId, o.kind],
      );
      return true;
    });
  }
}
