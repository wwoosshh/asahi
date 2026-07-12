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
// 리뷰 #2: messageId 로 enqueue 를 멱등화하는 구간(조회→삽입)을 직렬화하는 별도 advisory lock 키.
// claimNext 와 잠금 대상(테이블)은 같지만 의미상 다른 임계구역이라 키를 분리한다.
const ENQUEUE_LOCK_KEY = 727003;

export type JobStatus = "pending" | "running" | "done" | "failed";

export type Job = {
  id: number;
  userId: string;
  conversationId: number;
  discordChannelId: string;
  userMessage: string;
  messageId: number | null;
  status: JobStatus;
  progress: string | null;
  result: string | null;
  error: string | null;
  createdTs: number;
  claimedTs: number | null;
  doneTs: number | null;
  deliveredTs: number | null;
};

type Row = {
  id: number | string;
  user_id: string;
  conversation_id: number | string;
  discord_channel_id: string;
  user_message: string;
  message_id: number | string | null;
  status: JobStatus;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_ts: number;
  claimed_ts: number | null;
  done_ts: number | null;
  delivered_ts: number | null;
};

function toJob(r: Row): Job {
  return {
    id: Number(r.id),
    userId: r.user_id,
    conversationId: Number(r.conversation_id),
    discordChannelId: r.discord_channel_id,
    userMessage: r.user_message,
    messageId: r.message_id === null ? null : Number(r.message_id),
    status: r.status,
    progress: r.progress,
    result: r.result,
    error: r.error,
    createdTs: r.created_ts,
    claimedTs: r.claimed_ts,
    doneTs: r.done_ts,
    deliveredTs: r.delivered_ts,
  };
}

export class JobsRepo {
  constructor(private db: Db) {}

  // 리뷰 #2(HIGH): messageId 를 주면 그 메시지로 위임 job 을 멱등화한다 — 봇이 크래시 후 재기동해
  // recoverPending 이 같은(미처리) 메시지로 다시 위임을 시도해도, 이미 그 메시지로 만들어둔 job 이
  // 있으면 새로 만들지 않고 그 job 의 id 를 그대로 돌려준다(중복 실행 방지). messageId 를 생략하면
  // (레거시 호출부·테스트) 기존처럼 매번 새 job 을 만든다.
  // advisory lock 으로 "조회 후 삽입"을 직렬화해 두 호출이 동시에 들어와도 중복 삽입되지 않게 한다
  // (claimNext 와 같은 이유 — pg-mem 은 이 락을 no-op 로 스텁하므로 순차 호출 검증만 가능. 참고: 위
  // CLAIM_LOCK_KEY 주석).
  async enqueue(job: { userId: string; conversationId: number; discordChannelId: string; userMessage: string; ts: number; messageId?: number }): Promise<number> {
    if (job.messageId !== undefined) {
      return withTx(this.db, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [ENQUEUE_LOCK_KEY]);
        const existing = await client.query("SELECT id FROM worker_jobs WHERE message_id = $1", [job.messageId]);
        const existingRow = existing.rows[0] as { id: number | string } | undefined;
        if (existingRow) return Number(existingRow.id);
        const ins = await client.query(
          `INSERT INTO worker_jobs (user_id, conversation_id, discord_channel_id, user_message, message_id, status, created_ts)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING id`,
          [job.userId, job.conversationId, job.discordChannelId, job.userMessage, job.messageId, job.ts],
        );
        return Number((ins.rows[0] as { id: number | string }).id);
      });
    }
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

  // 리뷰 #7(LOW): 앱(Node) 시계가 아니라 DB 서버 자신의 시계로 하트비트 시각을 찍는다. 봇(Railway)과
  // 워커(사용자 PC)는 서로 다른 기계라 시계가 어긋날 수 있는데(clock skew), 양쪽 다 같은 Postgres
  // 서버의 now() 를 기준으로 쓰고 읽으면 그 스큐가 오라우팅(엉뚱하게 온라인/오프라인 판정)으로
  // 새지 않는다. pg-mem(테스트)도 now()/EXTRACT 를 지원해(스파이크로 확인) 테스트 경로도 동일하다.
  async heartbeat(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO worker_heartbeats (user_id, last_ts)
       VALUES ($1, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
       ON CONFLICT (user_id) DO UPDATE SET last_ts = excluded.last_ts`,
      [userId],
    );
  }

  // maxAgeMs: 하트비트가 "지금(DB 시계)으로부터 이 시간 이내"여야 online. last_ts 가 그 컷오프를
  // "초과"할 때만 online(같으면 offline). 하트비트가 없으면 offline. 절대시각이 아니라 상대 기간을
  // 받는 이유도 #7 과 같다 — 호출자(봇)의 절대 now() 를 컷오프 계산에 섞으면 스큐가 다시 들어온다.
  async isOnline(userId: string, maxAgeMs: number): Promise<boolean> {
    // 참고(스파이크로 확인): pg-mem 은 캐스트된 표현식 - 파라미터 형태의 뺄셈에서 파라미터 타입을
    // 잘못 추론해 피연산자 순서가 뒤집히는 버그가 있다("now() - $1" 이 "$1 - now()" 로 계산됨).
    // $2::bigint 로 명시적 캐스트를 붙이면 정상 동작한다(실제 Postgres 는 원래도 정확).
    const r = await this.db.query(
      `SELECT (last_ts > ((EXTRACT(EPOCH FROM now()) * 1000)::bigint - $2::bigint)) AS online
       FROM worker_heartbeats WHERE user_id = $1`,
      [userId, maxAgeMs],
    );
    const row = r.rows[0] as { online: boolean } | undefined;
    return row?.online === true;
  }

  // 리뷰 #5a(MED): job 결과를 디스코드로 "정확히 한 번" 배달하기 위한 compare-and-set.
  // delivered_ts 가 아직 null 인 행에만 걸리므로, 정상 폴링 경로와 배달 스윕(core.ts
  // deliverPendingJobResults)이 같은 job 을 동시에 처리하려 해도 둘 중 하나만 "승리"한다.
  async markDelivered(id: number, ts: number): Promise<boolean> {
    const r = await this.db.query(
      "UPDATE worker_jobs SET delivered_ts = $2 WHERE id = $1 AND delivered_ts IS NULL RETURNING id",
      [id, ts],
    );
    return r.rows.length > 0;
  }

  // 배달 스윕 대상: 끝났는데(done/failed) 아직 디스코드로 못 보낸(delivered_ts 없음) job 들.
  async listUndelivered(): Promise<Job[]> {
    const r = await this.db.query(
      "SELECT * FROM worker_jobs WHERE status IN ('done', 'failed') AND delivered_ts IS NULL ORDER BY created_ts ASC",
    );
    return (r.rows as Row[]).map(toJob);
  }

  // 리뷰 #5b(MED): 워커 재기동 시 자기 자신의 고아 running job 을 회수한다. 이 워커는 단일 인스턴스로
  // 그 user 를 전담하므로, 재기동 시점에 running 인 job 은 지난 프로세스가 claim 한 뒤 끝내지 못하고
  // 죽은 것(=영구 running)이 확실하다 — failed 로 되돌려 배달 스윕이 사용자에게 안내할 수 있게 한다.
  async failStaleRunning(userId: string, error: string, ts: number): Promise<void> {
    await this.db.query(
      "UPDATE worker_jobs SET status = 'failed', error = $2, done_ts = $3 WHERE user_id = $1 AND status = 'running'",
      [userId, error, ts],
    );
  }
}
