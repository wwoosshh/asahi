import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb } from "../src/store/db.js";
import { JobsRepo } from "../src/store/jobsRepo.js";

describe("JobsRepo", () => {
  let repo: JobsRepo;

  beforeEach(async () => {
    repo = new JobsRepo(await openTestDb());
  });

  it("enqueue 하면 pending 상태로 저장되고 get 으로 조회된다", async () => {
    const id = await repo.enqueue({ userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "안녕", ts: 100 });
    const job = await repo.get(id);
    expect(job).toMatchObject({
      id, userId: "u1", conversationId: 1, discordChannelId: "c1", userMessage: "안녕",
      status: "pending", progress: null, result: null, error: null, createdTs: 100, claimedTs: null, doneTs: null,
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

  it("heartbeat/isOnline: 컷오프보다 최근이면 online, 컷오프 이하면 offline", async () => {
    await repo.heartbeat("u1", 1000);
    expect(await repo.isOnline("u1", 900)).toBe(true);
    expect(await repo.isOnline("u1", 1000)).toBe(false); // 정확히 같으면 초과가 아니므로 offline
    expect(await repo.isOnline("u1", 1100)).toBe(false);
  });

  it("heartbeat 는 upsert 로 최신 값을 반영한다", async () => {
    await repo.heartbeat("u1", 1000);
    await repo.heartbeat("u1", 2000);
    expect(await repo.isOnline("u1", 1500)).toBe(true);
    expect(await repo.isOnline("u1", 1000)).toBe(true);
  });

  it("하트비트가 없는 user 는 offline 이다", async () => {
    expect(await repo.isOnline("ghost", 0)).toBe(false);
  });
});
