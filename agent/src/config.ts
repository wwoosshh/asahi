import path from "node:path";

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
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 30),
    maxTurnsPerHour: Number(env.MAX_TURNS_PER_HOUR || 30),
  };
}
