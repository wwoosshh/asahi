import path from "node:path";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { Repo } from "./store/repo.js";
import { ensureMemoryDir } from "./memory/memory.js";
import { AgentCore } from "./core/core.js";
import { runAgentTurn } from "./core/agent.js";
import { DiscordAdapter } from "./adapters/discord.js";

// 비밀값(.env)은 리포 루트(agent/ 바깥, data/ 와 같은 위치)에서 읽는다.
// 혹시 agent/.env 에 뒀다면 두 번째 호출이 보완한다(이미 설정된 값은 덮어쓰지 않음).
dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

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
    await core.drain();     // 처리 중인 메시지를 마저 끝내고
    await discord.stop();   // 체인에 남은 전송을 흘려보낸 뒤 클라이언트 종료
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
