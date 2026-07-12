import type { Db } from "./db.js";
import { withTx } from "./db.js";

// claimNext 원자성 스파이크 결과(임시 tsx 스크립트로 확인, 삭제됨):
// 1) `... FOR UPDATE SKIP LOCKED` 는 pg-mem 이 AST 자체를 못 읽어 즉시 예외("Not supported: skip locked").
// 2) 서브쿼리 형태 `WHERE id = (SELECT ... LIMIT 1 [FOR UPDATE])` 는 예외는 안 나지만, pg-mem 이
//    LIMIT 1 로 뽑힌 스칼라 하나가 아니라 조건에 맞는 모든 행을 갱신해버리는 버그가 있다(운영 Postgres
//    에서는 정상 동작할 표준 SQL 이지만, 테스트 환경에서 검증이 불가능).
// 그래서 서브쿼리 없이 "SELECT 로 후보 하나를 고르고, 그 id 로 UPDATE" 두 단계로 짜고, 이 둘을
// withTx + pg_advisory_xact_lock(TurnsRepo.reserve 와 동일한 패턴, db.ts 참고)으로 감싸 직렬화한다.
// 실제 Postgres 에서는 advisory lock 이 claimNext 호출 전체를 전역 직렬화하므로, SELECT 와 UPDATE
// 사이에 다른 claimNext 트랜잭션이 끼어들 수 없어 두 워커가 같은 job 을 동시에 가져가지 못한다
// (원자성은 "행 잠금"이 아니라 "호출 자체의 직렬화"로 보장된다). job 클레임은 폴링 주기가 길어
// 핫패스가 아니므로 사용자 구분 없는 전역 직렬화로도 충분하다.
// 주의: pg-mem(유닛테스트)은 advisory lock 을 no-op 로 스텁하고 트랜잭션도 순차 실행되므로, 아래
// 테스트(jobsRepo.test.ts)는 "순차 호출에서 클레임 로직이 맞는지"만 검증한다 — 진짜 동시 클레임
// 경합(두 워커가 동시에 폴링했을 때 advisory lock 이 정말 직렬화하는지)은 실제 Postgres 를 쓰는
// 통합/스모크 테스트의 몫이다.
const CLAIM_LOCK_KEY = 727002;

export type JobStatus = "pending" | "running" | "done" | "failed";

export type Job = {
  id: number;
  userId: string;
  conversationId: number;
  discordChannelId: string;
  userMessage: string;
  status: JobStatus;
  progress: string | null;
  result: string | null;
  error: string | null;
  createdTs: number;
  claimedTs: number | null;
  doneTs: number | null;
};

type Row = {
  id: number | string;
  user_id: string;
  conversation_id: number | string;
  discord_channel_id: string;
  user_message: string;
  status: JobStatus;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_ts: number;
  claimed_ts: number | null;
  done_ts: number | null;
};

function toJob(r: Row): Job {
  return {
    id: Number(r.id),
    userId: r.user_id,
    conversationId: Number(r.conversation_id),
    discordChannelId: r.discord_channel_id,
    userMessage: r.user_message,
    status: r.status,
    progress: r.progress,
    result: r.result,
    error: r.error,
    createdTs: r.created_ts,
    claimedTs: r.claimed_ts,
    doneTs: r.done_ts,
  };
}

export class JobsRepo {
  constructor(private db: Db) {}

  async enqueue(job: { userId: string; conversationId: number; discordChannelId: string; userMessage: string; ts: number }): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO worker_jobs (user_id, conversation_id, discord_channel_id, user_message, status, created_ts)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
      [job.userId, job.conversationId, job.discordChannelId, job.userMessage, job.ts],
    );
    return Number((r.rows[0] as { id: number | string }).id);
  }

  // 그 user 의 가장 오래된 pending job 하나를 원자적으로 running 으로 바꿔 반환한다. 없으면 null.
  async claimNext(userId: string, ts: number): Promise<Job | null> {
    return withTx(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_LOCK_KEY]);
      const sel = await client.query(
        "SELECT id FROM worker_jobs WHERE user_id = $1 AND status = 'pending' ORDER BY created_ts ASC LIMIT 1",
        [userId],
      );
      const row = sel.rows[0] as { id: number | string } | undefined;
      if (!row) return null;
      const upd = await client.query(
        "UPDATE worker_jobs SET status = 'running', claimed_ts = $2 WHERE id = $1 RETURNING *",
        [row.id, ts],
      );
      return toJob(upd.rows[0] as Row);
    });
  }

  async setProgress(id: number, progress: string): Promise<void> {
    await this.db.query("UPDATE worker_jobs SET progress = $2 WHERE id = $1", [id, progress]);
  }

  async complete(id: number, result: string, ts: number): Promise<void> {
    await this.db.query(
      "UPDATE worker_jobs SET status = 'done', result = $2, done_ts = $3 WHERE id = $1",
      [id, result, ts],
    );
  }

  async fail(id: number, error: string, ts: number): Promise<void> {
    await this.db.query(
      "UPDATE worker_jobs SET status = 'failed', error = $2, done_ts = $3 WHERE id = $1",
      [id, error, ts],
    );
  }

  async get(id: number): Promise<Job | null> {
    const r = await this.db.query("SELECT * FROM worker_jobs WHERE id = $1", [id]);
    const row = r.rows[0] as Row | undefined;
    return row ? toJob(row) : null;
  }

  async heartbeat(userId: string, ts: number): Promise<void> {
    await this.db.query(
      "INSERT INTO worker_heartbeats (user_id, last_ts) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET last_ts = excluded.last_ts",
      [userId, ts],
    );
  }

  // last_ts 가 cutoffTs 를 "초과"할 때만 online(같으면 offline). 하트비트가 없으면 offline.
  async isOnline(userId: string, cutoffTs: number): Promise<boolean> {
    const r = await this.db.query("SELECT last_ts FROM worker_heartbeats WHERE user_id = $1", [userId]);
    const row = r.rows[0] as { last_ts: number } | undefined;
    return row !== undefined && row.last_ts > cutoffTs;
  }
}
