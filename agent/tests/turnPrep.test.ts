import { describe, it, expect, beforeEach } from "vitest";
import { openTestDb, type Db } from "../src/store/db.js";
import { MemoriesRepo } from "../src/store/memoriesRepo.js";
import { SummariesRepo } from "../src/store/summariesRepo.js";
import { MessagesRepo } from "../src/store/messagesRepo.js";
import { ConversationsRepo } from "../src/store/conversationsRepo.js";
import { buildContextBlock } from "../src/core/turnPrep.js";

describe("buildContextBlock — 흉내 방지 안내", () => {
  let db: Db;
  beforeEach(async () => { db = await openTestDb(); });

  it("최근 대화 기록이 참고용이며 이전 답변 말투를 흉내내지 말고 캐릭터 지침을 따르라는 안내를 포함한다", async () => {
    const convs = new ConversationsRepo(db);
    await convs.create({ kind: "dm", discordChannelId: "c", primaryUserId: "u", isPrivate: true, lastActiveTs: 1 });
    const conv = (await convs.getByChannelId("c"))!;
    const repos = { memories: new MemoriesRepo(db), summaries: new SummariesRepo(db), messages: new MessagesRepo(db) };

    const block = await buildContextBlock(repos, conv, -1);
    expect(block).toMatch(/흉내/);
    expect(block).toMatch(/캐릭터|시스템 지침/);
    expect(block).toMatch(/참고용/);
  });
});
