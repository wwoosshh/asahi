import "dotenv/config";
import path from "node:path";
import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { Repo } from "./store/repo.js";
import { ensureMemoryDir } from "./memory/memory.js";
import { AgentCore } from "./core/core.js";
import { runAgentTurn } from "./core/agent.js";
import { DiscordAdapter } from "./adapters/discord.js";

async function main() {
  const config = loadConfig();
  ensureMemoryDir(config.memoryDir);

  const db = openDb(path.join(config.dataDir, "agent.db"));
  const repo = new Repo(db);
  const bus = new EventBus();

  const core = new AgentCore({ bus, repo, config, runTurn: runAgentTurn });
  core.start();

  const discord = new DiscordAdapter({ bus, config });
  await discord.start();

  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개

  // 유휴 세션 정리: 1분마다 확인
  const idleTimer = setInterval(() => {
    void core.closeIdleSessionIfNeeded().catch((err) => console.error("[core] 유휴 정리 오류:", err));
  }, 60 * 1000);

  const shutdown = async () => {
    console.log("종료 중...");
    clearInterval(idleTimer);
    await discord.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log("상주 비서가 시작되었습니다.");
}

main().catch((err) => {
  console.error("시작 실패:", err);
  process.exit(1);
});
