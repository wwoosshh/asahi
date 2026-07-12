import { describe, it, expect } from "vitest";
import { loadConfig, loadWorkerConfig } from "../src/config.js";

const base = { DISCORD_TOKEN: "tok", DISCORD_OWNER_ID: "123", DATABASE_URL: "postgres://localhost/test" };

describe("loadConfig", () => {
  it("필수값이 있으면 기본값과 함께 로드된다", () => {
    const c = loadConfig(base);
    expect(c.discordToken).toBe("tok");
    expect(c.ownerId).toBe("123");
    expect(c.databaseUrl).toBe("postgres://localhost/test");
    expect(c.channelId).toBeUndefined();
    expect(c.sessionIdleMinutes).toBe(30);
    expect(c.maxTurnsPerHour).toBe(30);
    expect(c.dataDir.endsWith("store")).toBe(true);
    expect(c.memoryDir.endsWith("memory")).toBe(true);
  });

  it("멀티유저 한도 기본값을 로드한다", () => {
    const c = loadConfig(base);
    expect(c.maxTurnsPerHourPerUser).toBe(20);
    expect(c.maxTurnsPerHourGlobal).toBe(40);
    expect(c.ownerReserve).toBe(10);
  });

  it("멀티유저 한도를 env 로 덮어쓸 수 있다", () => {
    const c = loadConfig({ ...base, MAX_TURNS_PER_HOUR_PER_USER: "7", MAX_TURNS_PER_HOUR_GLOBAL: "15", OWNER_RESERVE: "4" });
    expect(c.maxTurnsPerHourPerUser).toBe(7);
    expect(c.maxTurnsPerHourGlobal).toBe(15);
    expect(c.ownerReserve).toBe(4);
  });

  it("멀티유저 한도 env 가 잘못되면(0·음수·오타) 시작 시 명확히 실패한다", () => {
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR_PER_USER: "0" })).toThrow(/MAX_TURNS_PER_HOUR_PER_USER/);
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR_GLOBAL: "-3" })).toThrow(/MAX_TURNS_PER_HOUR_GLOBAL/);
    expect(() => loadConfig({ ...base, OWNER_RESERVE: "abc" })).toThrow(/OWNER_RESERVE/);
  });

  it("선택값을 덮어쓸 수 있다", () => {
    const c = loadConfig({ ...base, DISCORD_CHANNEL_ID: "ch1", SESSION_IDLE_MINUTES: "10", MAX_TURNS_PER_HOUR: "5" });
    expect(c.channelId).toBe("ch1");
    expect(c.sessionIdleMinutes).toBe(10);
    expect(c.maxTurnsPerHour).toBe(5);
  });

  it("deployTarget 기본값은 local 이다", () => {
    const c = loadConfig(base);
    expect(c.deployTarget).toBe("local");
  });

  it("DEPLOY_TARGET=cloud 이면 deployTarget 이 cloud 로 로드된다", () => {
    const c = loadConfig({ ...base, DEPLOY_TARGET: "cloud" });
    expect(c.deployTarget).toBe("cloud");
  });

  it("DEPLOY_TARGET 이 cloud 가 아닌 값(오타 등)이면 local 로 취급한다", () => {
    const c = loadConfig({ ...base, DEPLOY_TARGET: "production" });
    expect(c.deployTarget).toBe("local");
  });

  it("필수값이 없으면 무엇이 빠졌는지 알려주며 실패한다", () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN/);
  });

  it("DATABASE_URL 이 없으면 명확히 실패한다", () => {
    const { DATABASE_URL, ...withoutDbUrl } = base;
    expect(() => loadConfig(withoutDbUrl)).toThrow(/DATABASE_URL/);
  });

  it("숫자 env 가 잘못되면(오타·0·음수) 시작 시 명확히 실패한다", () => {
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR: "30/hour" })).toThrow(/MAX_TURNS_PER_HOUR/);
    expect(() => loadConfig({ ...base, MAX_TURNS_PER_HOUR: "0" })).toThrow(/MAX_TURNS_PER_HOUR/);
    expect(() => loadConfig({ ...base, SESSION_IDLE_MINUTES: "abc" })).toThrow(/SESSION_IDLE_MINUTES/);
  });
});

describe("loadWorkerConfig(하이브리드 조각3 — 로컬 워커 전용 설정, 봇 설정과 분리)", () => {
  const workerBase = { DATABASE_URL: "postgres://localhost/test", DISCORD_OWNER_ID: "123", WORKER_USER_ID: "456" };

  it("필수값이 있으면 로드된다", () => {
    const c = loadWorkerConfig(workerBase);
    expect(c.databaseUrl).toBe("postgres://localhost/test");
    expect(c.ownerId).toBe("123");
    expect(c.workerUserId).toBe("456");
    expect(c.workerSecret).toBeUndefined();
    expect(c.sessionIdleMinutes).toBe(30);
    expect(c.dataDir.endsWith("store")).toBe(true);
    expect(c.memoryDir.endsWith("memory")).toBe(true);
  });

  it("WORKER_SECRET 이 있으면 로드만 한다(지금은 로드만, 검증 없음)", () => {
    const c = loadWorkerConfig({ ...workerBase, WORKER_SECRET: "s3cr3t" });
    expect(c.workerSecret).toBe("s3cr3t");
  });

  it("DISCORD_TOKEN 은 필요 없다(워커는 디스코드에 연결하지 않는다)", () => {
    expect(() => loadWorkerConfig(workerBase)).not.toThrow();
  });

  it("DATABASE_URL/DISCORD_OWNER_ID/WORKER_USER_ID 중 하나라도 없으면 무엇이 빠졌는지 알려주며 실패한다", () => {
    const { DATABASE_URL, ...withoutDb } = workerBase;
    expect(() => loadWorkerConfig(withoutDb)).toThrow(/DATABASE_URL/);
    const { DISCORD_OWNER_ID, ...withoutOwner } = workerBase;
    expect(() => loadWorkerConfig(withoutOwner)).toThrow(/DISCORD_OWNER_ID/);
    const { WORKER_USER_ID, ...withoutWorkerUser } = workerBase;
    expect(() => loadWorkerConfig(withoutWorkerUser)).toThrow(/WORKER_USER_ID/);
  });

  it("SESSION_IDLE_MINUTES 를 env 로 덮어쓸 수 있다", () => {
    const c = loadWorkerConfig({ ...workerBase, SESSION_IDLE_MINUTES: "10" });
    expect(c.sessionIdleMinutes).toBe(10);
  });
});
