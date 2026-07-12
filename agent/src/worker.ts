import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadWorkerConfig } from "./config.js";
import { openDb } from "./store/db.js";
import { UsersRepo } from "./store/usersRepo.js";
import { ConversationsRepo } from "./store/conversationsRepo.js";
import { MessagesRepo } from "./store/messagesRepo.js";
import { SummariesRepo } from "./store/summariesRepo.js";
import { MemoriesRepo } from "./store/memoriesRepo.js";
import { AllowedDirsRepo } from "./store/allowedDirsRepo.js";
import { JobsRepo } from "./store/jobsRepo.js";
import { IntrospectRepo } from "./store/introspectRepo.js";
import { makeRunAgentTurn } from "./core/agent.js";
import { processJob } from "./worker/jobRunner.js";

// 로컬 워커 진입점(하이브리드 조각3, W2): 디스코드 연결 없이 이 사용자(WORKER_USER_ID)가 담당하는
// worker_jobs 를 폴링해 처리한다. 봇(Railway, src/index.ts)이 job 을 넣고(enqueue) 결과를 디스코드로
// 보내는 라우팅은 W3 몫 — 이 파일은 job 을 집어 실행하고 progress/result 를 job 행에 기록하는 데까지다.
//
// PC(파일/Bash) 작업은 언제나 이 워커가 실제로 동작하는 이 PC 위에서만 실행된다 — allowedDirs 로
// 등록된 폴더 밖은 canUseTool(경로 게이트)이 그대로 막는다(agent.ts 참고).

dotenv.config({ path: path.resolve("..", ".env") });
dotenv.config();

const HEARTBEAT_MS = 10_000;
const POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = loadWorkerConfig();
  const db = await openDb(config.databaseUrl);

  const users = new UsersRepo(db);
  const conversations = new ConversationsRepo(db);
  const messages = new MessagesRepo(db);
  const summaries = new SummariesRepo(db);
  const memories = new MemoriesRepo(db);
  const allowedDirs = new AllowedDirsRepo(db);
  const jobs = new JobsRepo(db);
  const introspect = new IntrospectRepo(db);
  const repos = { conversations, messages, summaries, memories, users, jobs };

  // 에이전트 cwd 는 소스가 아닌 데이터 영역에 둔다(index.ts 와 동일한 정책).
  const agentCwd = path.resolve(config.dataDir, "..", "agent-cwd");
  fs.mkdirSync(agentCwd, { recursive: true });

  // 워커는 항상 로컬 실행(자기 PC) — deployTarget 은 항상 "local".
  const runTurn = makeRunAgentTurn({ memories, users, allowedDirs, introspect }, "local", config.model);

  let stopped = false;

  // 리뷰 #5b(MED): 이 워커는 그 user 를 전담하는 단일 인스턴스다 — 재기동 시점에 running 인 job 이
  // 있다면 지난 프로세스가 claim 한 뒤 끝내지 못하고 죽은 것(영구 running 고아)이 확실하므로 failed
  // 로 되돌린다. 이렇게 하면 delivered_ts 가 아직 없는 채로 남아, 봇의 배달 스윕이 사용자에게
  // "실패했다"고 안내할 수 있다(#5a 와 맞물려 결과가 조용히 유실되지 않는다).
  await jobs.failStaleRunning(config.workerUserId, "워커가 재시작되어 이전 작업이 유실됐어요. 다시 요청해 주세요.", Date.now());

  // 하트비트: 봇이 isOnline(cutoff) 으로 "이 사용자의 워커가 떠 있는지" 판단하는 근거.
  // 리뷰 #7(LOW): 앱 시계가 아니라 DB 서버 시계로 찍는다(jobsRepo.heartbeat 참고) — 봇/워커 서버
  // 간 시계 스큐가 온라인 판정에 새지 않게 한다.
  const heartbeatTimer = setInterval(() => {
    void jobs.heartbeat(config.workerUserId).catch((err) => {
      console.error("[worker] 하트비트 실패:", err);
    });
  }, HEARTBEAT_MS);
  await jobs.heartbeat(config.workerUserId); // 기동 직후 바로 한 번(초기 오프라인 창 최소화)

  // 폴링 루프: job 을 잡으면 바로 다음 job 을 확인하고(버스트 처리), 없으면 POLL_MS 만큼 쉰다.
  const pollLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const job = await jobs.claimNext(config.workerUserId, Date.now());
        if (job) {
          await processJob({ repos, runTurn, agentCwd, ownerId: config.ownerId, idleMs: config.sessionIdleMinutes * 60 * 1000 }, job);
          continue;
        }
      } catch (err) {
        console.error("[worker] 폴링 오류:", err);
      }
      await sleep(POLL_MS);
    }
  };
  const pollPromise = pollLoop();

  const shutdown = async () => {
    console.log("워커 종료 중...");
    stopped = true;
    clearInterval(heartbeatTimer);
    await pollPromise;  // 진행 중인 job 처리를 마저 끝낸다
    await db.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log(`로컬 워커가 시작되었습니다 (WORKER_USER_ID=${config.workerUserId}).`);
}

main().catch((err) => {
  console.error("워커 시작 실패:", err);
  process.exit(1);
});
