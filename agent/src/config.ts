import path from "node:path";

// 숫자 환경변수를 파싱·검증한다. 값이 없으면 기본값, 있으면 양의 유한수여야 하며
// 아니면(오타·0 등) 시작 시점에 명확히 실패한다 — NaN 으로 봇이 조용히 먹통 되는 것을 막는다.
function positiveNumberEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`환경변수 ${key} 는 양의 숫자여야 합니다 (현재 값: "${raw}")`);
  }
  return n;
}

export type Config = {
  discordToken: string;
  ownerId: string;
  channelId?: string;
  databaseUrl: string;
  dataDir: string;
  memoryDir: string;
  sessionIdleMinutes: number;
  maxTurnsPerHour: number;
  // 멀티유저 한도(2B): 코어는 이 3개를 사용한다. maxTurnsPerHour 는 하위호환용으로 남긴다.
  maxTurnsPerHourPerUser: number; // 유저별 시간당 상한 (기본 20)
  maxTurnsPerHourGlobal: number;  // 전역 시간당 상한 (기본 40)
  ownerReserve: number;           // (현재 미사용) 소유자는 무제한 정책이라 예약 불필요 — 하위호환 위해 로드만 유지
  // 배포 대상(Railway 조각2): cloud 는 소유자 PC 가 없는 컨테이너 실행을 뜻하며, PC 도구(파일/Bash)를 비활성한다.
  // 기본은 local(기존 동작 그대로). DEPLOY_TARGET 값이 정확히 "cloud" 일 때만 cloud, 그 외(미설정·오타)는 local.
  deployTarget: "local" | "cloud";
  model: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["DISCORD_TOKEN", "DISCORD_OWNER_ID", "DATABASE_URL"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  // 런타임 데이터의 기본 경로는 앱(agent/) 바깥, 리포 루트의 data/ 아래에 둔다.
  // cwd 는 agent/ (npm 스크립트와 PM2 cwd 기준). DATA_DIR / MEMORY_DIR 로 재정의 가능.
  return {
    discordToken: env.DISCORD_TOKEN as string,
    ownerId: env.DISCORD_OWNER_ID as string,
    channelId: env.DISCORD_CHANNEL_ID || undefined,
    databaseUrl: env.DATABASE_URL as string,
    dataDir: env.DATA_DIR || path.resolve("..", "data", "store"),
    memoryDir: env.MEMORY_DIR || path.resolve("..", "data", "memory"),
    sessionIdleMinutes: positiveNumberEnv(env, "SESSION_IDLE_MINUTES", 30),
    maxTurnsPerHour: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR", 30),
    maxTurnsPerHourPerUser: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR_PER_USER", 20),
    maxTurnsPerHourGlobal: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR_GLOBAL", 40),
    ownerReserve: positiveNumberEnv(env, "OWNER_RESERVE", 10),
    deployTarget: env.DEPLOY_TARGET === "cloud" ? "cloud" : "local",
    model: env.ANTHROPIC_MODEL || "claude-opus-4-8",
  };
}

// 하이브리드 조각3(사용자별 로컬 워커) 전용 설정. 봇(loadConfig/Config)과 완전히 분리 —
// 워커는 디스코드 토큰이 필요 없고(디스코드 연결 없음, DB 로만 job 을 주고받는다), 대신 자신이
// 담당할 사용자(WORKER_USER_ID)와 소유자 신원 판정용 DISCORD_OWNER_ID 가 필요하다.
export type WorkerConfig = {
  databaseUrl: string;
  ownerId: string;       // DISCORD_OWNER_ID — isOwner(신원) 판정용. 봇과 동일한 값이어야 한다.
  workerUserId: string;  // WORKER_USER_ID — 이 워커가 담당하는 디스코드 사용자 ID(job 을 claim 할 대상).
  workerSecret?: string; // WORKER_SECRET(옵션) — 지금은 로드만 한다(추후 워커 인증에 사용 예정).
  dataDir: string;
  memoryDir: string;
  sessionIdleMinutes: number;
  model: string;
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing = ["DATABASE_URL", "DISCORD_OWNER_ID", "WORKER_USER_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  return {
    databaseUrl: env.DATABASE_URL as string,
    ownerId: env.DISCORD_OWNER_ID as string,
    workerUserId: env.WORKER_USER_ID as string,
    workerSecret: env.WORKER_SECRET || undefined,
    dataDir: env.DATA_DIR || path.resolve("..", "data", "store"),
    memoryDir: env.MEMORY_DIR || path.resolve("..", "data", "memory"),
    sessionIdleMinutes: positiveNumberEnv(env, "SESSION_IDLE_MINUTES", 30),
    model: env.ANTHROPIC_MODEL || "claude-opus-4-8",
  };
}
