import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { EventBus } from "./events/bus.js";
import { openDb } from "./store/db.js";
import { UsersRepo } from "./store/usersRepo.js";
import { ConversationsRepo } from "./store/conversationsRepo.js";
import { ParticipantsRepo } from "./store/participantsRepo.js";
import { MessagesRepo } from "./store/messagesRepo.js";
import { SummariesRepo } from "./store/summariesRepo.js";
import { MemoriesRepo } from "./store/memoriesRepo.js";
import { TurnsRepo } from "./store/turnsRepo.js";
import { AllowedDirsRepo } from "./store/allowedDirsRepo.js";
import { JobsRepo } from "./store/jobsRepo.js";
import { SettingsRepo } from "./store/settingsRepo.js";
import { backfillLegacyAllowedDirs } from "./store/allowedDirsMigration.js";
import { AgentCore } from "./core/core.js";
import { makeRunAgentTurn } from "./core/agent.js";
import { DiscordAdapter } from "./adapters/discord.js";

// 비밀값(.env)은 리포 루트(agent/ 바깥, data/ 와 같은 위치)에서 읽는다.
dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

async function main() {
  const config = loadConfig();

  const db = await openDb(config.databaseUrl);

  const users = new UsersRepo(db);
  const conversations = new ConversationsRepo(db);
  const allowedDirs = new AllowedDirsRepo(db);
  const repos = {
    users,
    conversations,
    participants: new ParticipantsRepo(db),
    messages: new MessagesRepo(db),
    summaries: new SummariesRepo(db),
    memories: new MemoriesRepo(db),
    turns: new TurnsRepo(db),
    jobs: new JobsRepo(db),
    allowedDirs,
  };
  // 소유자를 users(owner)로 보장 — 게이트 통과 기본값.
  await users.upsert(config.ownerId, { role: "owner" });

  // 리뷰 #6(LOW): allowed_dirs 테이블 도입 전 owner.allowedDirs 단일 settings 키에 저장돼 있던
  // 소유자 허용 폴더를 이전한다(멱등이라 부팅마다 호출해도 안전).
  await backfillLegacyAllowedDirs(new SettingsRepo(db), allowedDirs, config.ownerId);

  const bus = new EventBus();
  // 에이전트 cwd 는 소스가 아닌 데이터 영역에 둔다 — 에이전트가 소스 트리를 훑지 않도록(1단계 점검 지적).
  const agentCwd = path.resolve(config.dataDir, "..", "agent-cwd");
  fs.mkdirSync(agentCwd, { recursive: true });
  const runTurn = makeRunAgentTurn({ memories: repos.memories, users: repos.users, allowedDirs: repos.allowedDirs }, config.deployTarget);
  const core = new AgentCore({ bus, config, runTurn, repos, agentCwd });
  core.start();

  const discord = new DiscordAdapter({ bus, config, users, conversations });
  await discord.start();

  await core.recoverPending(); // 크래시로 남은 미처리 메시지 재개
  // 리뷰 #5a(MED): 부팅 사이(재배포 등)에 위임 타임아웃 뒤 뒤늦게 끝났지만 아직 디스코드로
  // 못 보낸(delivered_ts 없음) job 결과가 있으면 지금 흘려보낸다.
  await core.deliverPendingJobResults().catch((err) => console.error("[core] 위임 결과 배달(부팅) 오류:", err));

  // 유휴 세션 정리 + 위임 결과 배달 스윕: 1분마다 확인
  const idleTimer = setInterval(() => {
    void core.closeIdleConversations().catch((err) => console.error("[core] 유휴 정리 오류:", err));
    void core.deliverPendingJobResults().catch((err) => console.error("[core] 위임 결과 배달 오류:", err));
  }, 60 * 1000);

  const shutdown = async () => {
    console.log("종료 중...");
    clearInterval(idleTimer);
    await core.drain();     // 처리 중인 메시지를 마저 끝내고
    await discord.stop();   // 체인에 남은 전송을 흘려보낸 뒤 클라이언트 종료
    await db.end();         // pg Pool 연결 정리
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
