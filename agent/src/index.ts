import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { migrateFromPhase1 } from "./store/migrate.js";
import { UsersRepo } from "./store/usersRepo.js";
import { ConversationsRepo } from "./store/conversationsRepo.js";
import { ParticipantsRepo } from "./store/participantsRepo.js";
import { MessagesRepo } from "./store/messagesRepo.js";
import { SummariesRepo } from "./store/summariesRepo.js";
import { MemoriesRepo } from "./store/memoriesRepo.js";
import { TurnsRepo } from "./store/turnsRepo.js";
import { AgentCore } from "./core/core.js";
import { makeRunAgentTurn } from "./core/agent.js";
import { DiscordAdapter } from "./adapters/discord.js";

// 비밀값(.env)은 리포 루트(agent/ 바깥, data/ 와 같은 위치)에서 읽는다.
dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

async function main() {
  const config = loadConfig();

  const db = openDb(path.join(config.dataDir, "agent.db"));
  // 1단계 데이터(events/summaries/settings/마크다운 기억)를 v2 스키마로 멱등 이전(1회).
  migrateFromPhase1(db, { ownerId: config.ownerId, memoryDir: config.memoryDir });

  const users = new UsersRepo(db);
  const conversations = new ConversationsRepo(db);
  const repos = {
    users,
    conversations,
    participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db),
    summaries: new SummariesRepo(db),
    memories: new MemoriesRepo(db),
    turns: new TurnsRepo(db),
  };
  // 소유자를 users(owner)로 보장 — 게이트 통과 기본값.
  users.upsert(config.ownerId, { role: "owner" });

  const bus = new EventBus();
  // 에이전트 cwd 는 소스가 아닌 데이터 영역에 둔다 — 에이전트가 소스 트리를 훑지 않도록(1단계 점검 지적).
  const agentCwd = path.resolve(config.dataDir, "..", "agent-cwd");
  fs.mkdirSync(agentCwd, { recursive: true });
  const runTurn = makeRunAgentTurn({ memories: repos.memories, users: repos.users });
  const core = new AgentCore({ bus, config, runTurn, repos, agentCwd });
  core.start();

  const discord = new DiscordAdapter({ bus, config, users, conversations });
  await discord.start();

  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개

  // 유휴 세션 정리: 1분마다 대화별로 확인
  const idleTimer = setInterval(() => {
    void core.closeIdleConversations().catch((err) => console.error("[core] 유휴 정리 오류:", err));
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
