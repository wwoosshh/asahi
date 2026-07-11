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
  dataDir: string;
  memoryDir: string;
  sessionIdleMinutes: number;
  maxTurnsPerHour: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["DISCORD_TOKEN", "DISCORD_OWNER_ID"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`환경변수 누락: ${missing.join(", ")} — .env 파일을 확인하세요 (.env.example 참고)`);
  }
  // 런타임 데이터의 기본 경로는 앱(agent/) 바깥, 리포 루트의 data/ 아래에 둔다.
  // cwd 는 agent/ (npm 스크립트와 PM2 cwd 기준). DATA_DIR / MEMORY_DIR 로 재정의 가능.
  return {
    discordToken: env.DISCORD_TOKEN as string,
    ownerId: env.DISCORD_OWNER_ID as string,
    channelId: env.DISCORD_CHANNEL_ID || undefined,
    dataDir: env.DATA_DIR || path.resolve("..", "data", "store"),
    memoryDir: env.MEMORY_DIR || path.resolve("..", "data", "memory"),
    sessionIdleMinutes: positiveNumberEnv(env, "SESSION_IDLE_MINUTES", 30),
    maxTurnsPerHour: positiveNumberEnv(env, "MAX_TURNS_PER_HOUR", 30),
  };
}
