import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { JobsRepo } from "../src/store/jobsRepo.js";

describe("JobsRepo", () => {
  let db: Db;
  let repo: JobsRepo;

  beforeEach(async () => {
    db = await openTestDb();
    repo = new JobsRepo(db);
  });

  it("enqueue 하면 pending 상태로 저장되고 get 으로 조회된다", async () => {
    const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "안녕", ts: 100 });
    const job = await repo.get(id);
    expect(job).toMatchObject({
      id, userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "안녕",
      status: "pending", progress: null, result: null, error: null, createdTs: 100, claimedTs: null, doneTs: null,
      messageId: null, deliveredTs: null,
    });
  });

  it("get 은 존재하지 않는 id 에 null 을 반환한다", async () => {
    expect(await repo.get(9999)).toBeNull();
  });

  it("claimNext 는 가장 오래된 pending 하나만 running 으로 바꿔 반환하고 나머지는 그대로 둔다", async () => {
    const id1 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "first", ts: 100 });
    const id2 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "second", ts: 200 });

    const claimed = await repo.claimNext("u1", 150);
    expect(claimed?.id).toBe(id1);
    expect(claimed?.status).toBe("running");
    expect(claimed?.claimedTs).toBe(150);

    const stillPending = await repo.get(id2);
    expect(stillPending?.status).toBe("pending");
  });

  it("claimNext 는 다른 user 의 job 은 가져오지 않는다", async () => {
    await repo.enqueue({ userId: "u2", conversationId: 1, discordChannelId: "c1", userMessage: "other user", ts: 100 });
    expect(await repo.claimNext("u1", 150)).toBeNull();
  });

  it("claimNext 는 pending 이 없으면 null 을 반환한다", async () => {
    expect(await repo.claimNext("u1", 150)).toBeNull();
  });

  it("연속 claimNext 는 매번 다른 job 을 순서대로 가져오고 다 떨어지면 null", async () => {
    const id1 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "a", ts: 100 });
    const id2 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "b", ts: 200 });
    expect((await repo.claimNext("u1", 300))?.id).toBe(id1);
    expect((await repo.claimNext("u1", 400))?.id).toBe(id2);
    expect(await repo.claimNext("u1", 500)).toBeNull();
  });

  it("setProgress 는 progress 필드만 갱신한다(상태는 바뀌지 않음)", async () => {
    const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
    await repo.claimNext("u1", 150);
    await repo.setProgress(id, "파일 읽는 중...");
    const job = await repo.get(id);
    expect(job?.progress).toBe("파일 읽는 중...");
    expect(job?.status).toBe("running");
  });

  it("complete 는 status=done·result 저장·done_ts 기록", async () => {
    const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
    await repo.claimNext("u1", 150);
    await repo.complete(id, "완료했어요", 200);
    const job = await repo.get(id);
    expect(job).toMatchObject({ status: "done", result: "완료했어요", doneTs: 200 });
  });

  it("fail 은 status=failed·error 저장·done_ts 기록", async () => {
    const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
    await repo.claimNext("u1", 150);
    await repo.fail(id, "에러났어요", 250);
    const job = await repo.get(id);
    expect(job).toMatchObject({ status: "failed", error: "에러났어요", doneTs: 250 });
  });

  describe("리뷰 #2(HIGH) — messageId 로 위임 job 을 멱등화", () => {
    it("messageId 를 생략하면(레거시 경로) 기존처럼 매번 새 job 을 만든다", async () => {
      const id1 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "a", ts: 100 });
      const id2 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "b", ts: 200 });
      expect(id2).not.toBe(id1);
    });

    it("같은 messageId 로 두 번 enqueue 하면 새 job 을 만들지 않고 기존 id 를 반환한다(중복 실행 방지)", async () => {
      const id1 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "hi", ts: 100, messageId: 555 });
      const id2 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "hi(다시 시도)", ts: 200, messageId: 555 });
      expect(id2).toBe(id1);
      const rows = await db.query("SELECT * FROM worker_jobs WHERE message_id = $1", [555]);
      expect(rows.rows.length).toBe(1); // 중복 행이 생기지 않음
      const job = await repo.get(id1);
      expect(job?.messageId).toBe(555);
      expect(job?.userMessage).toBe("hi"); // 원래 첫 시도 내용 그대로(두 번째 시도로 덮어쓰지 않음)
    });

    it("서로 다른 messageId 는 서로 다른 job 으로 저장된다", async () => {
      const id1 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "a", ts: 100, messageId: 1 });
      const id2 = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "b", ts: 200, messageId: 2 });
      expect(id2).not.toBe(id1);
    });
  });

  describe("리뷰 #5a(MED) — 배달(delivered_ts) 추적", () => {
    it("markDelivered 는 처음 호출에서 true(자신이 배달) 를 반환하고 delivered_ts 를 남긴다", async () => {
      const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
      await repo.complete(id, "완료", 200);
      const won = await repo.markDelivered(id, 300);
      expect(won).toBe(true);
      const job = await repo.get(id);
      expect(job?.deliveredTs).toBe(300);
    });

    it("markDelivered 를 두 번 호출하면 두 번째는 false(이미 배달됨, 정확히 한 번 보장)", async () => {
      const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
      await repo.complete(id, "완료", 200);
      expect(await repo.markDelivered(id, 300)).toBe(true);
      expect(await repo.markDelivered(id, 400)).toBe(false);
      const job = await repo.get(id);
      expect(job?.deliveredTs).toBe(300); // 두 번째 호출로 덮어써지지 않음
    });

    it("listUndelivered 는 done/failed 이면서 delivered_ts 가 없는 job 만 돌려준다", async () => {
      const doneId = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "a", ts: 100 });
      await repo.complete(doneId, "완료", 200);
      const failedId = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "b", ts: 100 });
      await repo.fail(failedId, "에러", 200);
      const pendingId = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "c", ts: 100 });
      const deliveredId = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "d", ts: 100 });
      await repo.complete(deliveredId, "완료", 200);
      await repo.markDelivered(deliveredId, 300);

      const undelivered = (await repo.listUndelivered()).map((j) => j.id).sort((a, b) => a - b);
      expect(undelivered).toEqual([doneId, failedId].sort((a, b) => a - b));
      expect(undelivered).not.toContain(pendingId);
      expect(undelivered).not.toContain(deliveredId);
    });
  });

  describe("리뷰 #5b(MED) — failStaleRunning: 워커 재기동 시 고아 running 회수", () => {
    it("그 user 의 running job 을 failed 로 되돌리고 error/doneTs 를 기록한다", async () => {
      const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
      await repo.claimNext("u1", 150);
      await repo.failStaleRunning("u1", "워커 재시작으로 유실됨", 500);
      const job = await repo.get(id);
      expect(job).toMatchObject({ status: "failed", error: "워커 재시작으로 유실됨", doneTs: 500 });
    });

    it("다른 user 의 running job 은 건드리지 않는다", async () => {
      const idOther = await repo.enqueue({ userId: "u2", conversationId: 1, discordChannelId: "c1", userMessage: "x", ts: 100 });
      await repo.claimNext("u2", 150);
      await repo.failStaleRunning("u1", "워커 재시작으로 유실됨", 500);
      expect((await repo.get(idOther))?.status).toBe("running");
    });

    it("running 이 아닌 job(pending/done)은 건드리지 않는다", async () => {
      const firstId = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "first", ts: 100 });
      const secondId = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "second", ts: 200 });
      const claimed = await repo.claimNext("u1", 150); // 가장 오래된 firstId 가 running 이 됨
      await repo.complete(claimed!.id, "완료", 300); // 그리고 바로 done 으로 마무리
      // 이제 firstId=done, secondId=pending(한 번도 claim 안 됨) — 둘 다 running 이 아니다.
      await repo.failStaleRunning("u1", "재시작", 999);
      expect((await repo.get(firstId))?.status).toBe("done");
      expect((await repo.get(secondId))?.status).toBe("pending");
    });
  });

  describe("리뷰 #7(LOW) — heartbeat/isOnline 은 앱 시계가 아니라 DB 서버 시계를 기준으로 한다", () => {
    it("heartbeat 직후엔 넉넉한 cutoff(ms) 로 online 이다", async () => {
      await repo.heartbeat("u1");
      expect(await repo.isOnline("u1", 30_000)).toBe(true);
    });

    it("cutoff 를 0 으로 주면(하트비트 시각이 반드시 그보다 전이므로) offline 이다", async () => {
      await repo.heartbeat("u1");
      expect(await repo.isOnline("u1", 0)).toBe(false);
    });

    it("하트비트가 없는 user 는 offline 이다", async () => {
      expect(await repo.isOnline("ghost", 30_000)).toBe(false);
    });

    it("heartbeat 는 upsert 로 last_ts 를 최신화한다(다시 호출해도 그대로 online 유지)", async () => {
      await repo.heartbeat("u1");
      await repo.heartbeat("u1");
      expect(await repo.isOnline("u1", 30_000)).toBe(true);
    });

    it("DB 시계 기준으로 하트비트가 cutoff 보다 오래되면(직접 과거로 되돌려 시뮬레이션) offline 이다", async () => {
      await repo.heartbeat("u1");
      // 앱 시계가 아니라 DB 자신의 now() 를 기준으로 과거 시각을 만든다 — 클럭 스큐(리뷰 #7)와 무관하게
      // "DB 입장에서 오래됨"을 직접 구성해, 봇 서버 시계와 워커 서버 시계가 달라도 이 판정이 always
      // DB 시계 하나로만 이뤄짐을 검증한다.
      await db.query(
        "UPDATE worker_heartbeats SET last_ts = (EXTRACT(EPOCH FROM now())*1000)::bigint - $2::bigint WHERE user_id = $1",
        ["u1", 60_000],
      );
      expect(await repo.isOnline("u1", 30_000)).toBe(false);
    });
  });
});
