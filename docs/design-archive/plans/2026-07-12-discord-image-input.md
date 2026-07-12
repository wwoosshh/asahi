---
title: "디스코드 이미지 입력(멀티모달) Implementation Plan"
status: Shipped
shippedIn: 7215725
---

# 디스코드 이미지 입력(멀티모달) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 디스코드 이미지 첨부를 받아 base64로 인코딩하고 SDKUserMessage 스트림으로 모델에 직접 전달해, AI가 이미지를 보고 답하게 한다(모든 대화).

**Architecture:** 순수 이미지 로직(images.ts: 필터·마커·다운로드) → 어댑터가 첨부 캡처 → 이벤트/힌트로 전달 → core가 마커 저장·라우팅(이미지는 봇 직접)·다운로드 → agent가 이미지 있을 때 prompt를 async-iterable(SDKUserMessage)로 구성. 새 스키마 없음. 이미지는 그 턴에만 전달(재주입 없음).

**Tech Stack:** TypeScript ESM(NodeNext, `.js` import), Node 22(global fetch/Buffer), vitest, @anthropic-ai/claude-agent-sdk.

## Global Constraints

- 모든 import `.js`. 텍스트 한국어. 이모지 금지.
- **이미지는 그 턴에만 모델에 전달**; messages엔 텍스트 마커만 저장; buildContextBlock은 과거 이미지를 재주입하지 않는다(변경 없음).
- **이미지 있는 턴은 워커로 위임하지 않는다**(봇 직접 멀티모달).
- 이미지 없으면 기존 문자열 prompt 경로 **완전 동일**(회귀 금지).
- 제한: image/png|jpeg|gif|webp만, 장수 4, 이미지당 5MB, 다운로드 타임아웃 10s. 초과·실패는 건너뜀.
- 각 태스크 종료 시 `cd agent && npx tsc --noEmit && npm test` 통과. 커밋 본문 끝 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. 브랜치 `feat/discord-image-input`.

---

### Task 1: images.ts — 필터·마커·다운로드 (순수 + 주입 fetch)

**Files:**
- Create: `agent/src/core/images.ts`
- Test: `agent/tests/images.test.ts`

**Interfaces:**
- Produces:
  - `type ImageRef = { url: string; mediaType: string; name: string; size: number }`
  - `type ImageInput = { mediaType: string; base64: string; name: string }`
  - `IMAGE_LIMITS`
  - `filterImageAttachments(atts: RawAttachment[], limits?): { images: ImageRef[]; skipped: string[] }`
  - `buildImageMarker(text: string, images: ImageRef[]): string`
  - `downloadImages(refs: ImageRef[], opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ inputs: ImageInput[]; failed: string[] }>`

- [ ] **Step 1: 실패 테스트 작성**

`agent/tests/images.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterImageAttachments, buildImageMarker, downloadImages } from "../src/core/images.js";

describe("filterImageAttachments", () => {
  const att = (o: Partial<{ url: string; contentType: string | null; name: string; size: number }>) =>
    ({ url: "u", contentType: "image/png", name: "a.png", size: 100, ...o });

  it("image/* 화이트리스트만 통과, 비이미지는 무시", () => {
    const r = filterImageAttachments([att({}), att({ contentType: "text/plain", name: "b.txt" }), att({ contentType: "image/bmp", name: "c.bmp" })]);
    expect(r.images.map((i) => i.name)).toEqual(["a.png"]);
    expect(r.skipped.some((s) => s.includes("c.bmp"))).toBe(true); // 지원 안 함
  });
  it("크기 초과·장수 초과를 skip 한다", () => {
    const big = att({ name: "big.png", size: 99 * 1024 * 1024 });
    const many = Array.from({ length: 6 }, (_, i) => att({ name: `x${i}.png` }));
    const r1 = filterImageAttachments([big]);
    expect(r1.images).toHaveLength(0);
    const r2 = filterImageAttachments(many);
    expect(r2.images).toHaveLength(4);
    expect(r2.skipped.length).toBe(2);
  });
  it("contentType 의 파라미터(;charset)·대문자를 정규화한다", () => {
    const r = filterImageAttachments([att({ contentType: "IMAGE/JPEG; charset=binary", name: "d.jpg" })]);
    expect(r.images[0]?.mediaType).toBe("image/jpeg");
  });
});

describe("buildImageMarker", () => {
  const img = (name: string) => ({ url: "u", mediaType: "image/png", name, size: 1 });
  it("이미지가 있으면 마커+원문, 없으면 원문 그대로", () => {
    expect(buildImageMarker("안녕", [img("a.png")])).toBe("[이미지 1장: a.png] 안녕");
    expect(buildImageMarker("", [img("a.png"), img("b.png")])).toBe("[이미지 2장: a.png, b.png]");
    expect(buildImageMarker("그냥 텍스트", [])).toBe("그냥 텍스트");
  });
});

describe("downloadImages", () => {
  it("성공 시 base64 로 인코딩, 실패는 failed 로", async () => {
    const fake: typeof fetch = (async (url: string) => {
      if (url === "bad") return { ok: false } as Response;
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("hi").buffer } as Response;
    }) as unknown as typeof fetch;
    const refs = [
      { url: "good", mediaType: "image/png", name: "a.png", size: 2 },
      { url: "bad", mediaType: "image/png", name: "b.png", size: 2 },
    ];
    const { inputs, failed } = await downloadImages(refs, { fetchImpl: fake });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].base64).toBe(Buffer.from("hi").toString("base64"));
    expect(failed).toEqual(["b.png"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/images.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`agent/src/core/images.ts`:

```ts
// 디스코드 이미지 첨부 → 모델 전달용 처리(순수 로직 + 얇은 fetch). 이미지는 그 턴에만 쓰이며
// DB엔 마커 텍스트만 저장한다(과거 이미지 재주입 없음 — 비용 방지).
export type ImageRef = { url: string; mediaType: string; name: string; size: number };
export type ImageInput = { mediaType: string; base64: string; name: string };
type RawAttachment = { url: string; contentType: string | null; name: string; size: number };

export const IMAGE_LIMITS = {
  maxCount: 4,
  maxBytes: 5 * 1024 * 1024,
  allowed: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

export function filterImageAttachments(
  atts: RawAttachment[],
  limits: { maxCount: number; maxBytes: number; allowed: string[] } = IMAGE_LIMITS,
): { images: ImageRef[]; skipped: string[] } {
  const images: ImageRef[] = [];
  const skipped: string[] = [];
  for (const a of atts) {
    const mt = (a.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (!mt.startsWith("image/")) continue; // 비이미지는 조용히 무시
    if (!limits.allowed.includes(mt)) { skipped.push(`${a.name}(지원 안 하는 형식)`); continue; }
    if (a.size > limits.maxBytes) { skipped.push(`${a.name}(너무 큼)`); continue; }
    if (images.length >= limits.maxCount) { skipped.push(`${a.name}(장수 초과)`); continue; }
    images.push({ url: a.url, mediaType: mt, name: a.name, size: a.size });
  }
  return { images, skipped };
}

export function buildImageMarker(text: string, images: ImageRef[]): string {
  if (images.length === 0) return text;
  const marker = `[이미지 ${images.length}장: ${images.map((i) => i.name).join(", ")}]`;
  return text.trim() ? `${marker} ${text}` : marker;
}

export async function downloadImages(
  refs: ImageRef[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ inputs: ImageInput[]; failed: string[] }> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const inputs: ImageInput[] = [];
  const failed: string[] = [];
  for (const ref of refs) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await f(ref.url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) { failed.push(ref.name); continue; }
      const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      inputs.push({ mediaType: ref.mediaType, base64, name: ref.name });
    } catch {
      failed.push(ref.name);
    }
  }
  return { inputs, failed };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd agent && npx vitest run tests/images.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/images.ts agent/tests/images.test.ts
git commit -m "feat(image): images.ts — 첨부 필터·마커·다운로드(순수+주입 fetch)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: bus 이벤트 + 어댑터 첨부 캡처

**Files:**
- Modify: `agent/src/events/bus.ts` (`UserMessageEvent.images?`)
- Modify: `agent/src/adapters/discord.ts` (Incoming.images + attachments 캡처 + publish)
- Test: `agent/tests/images.test.ts` (어댑터 매핑 순수부만 — 아래)

**Interfaces:**
- Consumes: `ImageRef`, `filterImageAttachments`(Task 1)
- Produces: `UserMessageEvent.images?: ImageRef[]`

- [ ] **Step 1: bus 타입 수정**

`agent/src/events/bus.ts`:
- 상단에 `import type { ImageRef } from "../core/images.js";`
- `UserMessageEvent` 를 `{ type: "user_message"; channel: ChannelKind; channelRef: string; text: string; ts: number; hint?: ConversationHint; images?: ImageRef[] }` 로.

- [ ] **Step 2: 어댑터 수정**

`agent/src/adapters/discord.ts`:
- 상단 import: `import { filterImageAttachments, type ImageRef } from "../core/images.js";`
- `Incoming` 타입에 `images: ImageRef[];` 추가(정의 위치는 파일 내 `Incoming` 타입 선언부).
- `onMessage`에서 `incoming` 구성 시 첨부를 매핑·필터:
```ts
    const { images } = filterImageAttachments(
      [...message.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType, name: a.name, size: a.size })),
    );
```
  이 `images`를 `incoming.images`에 넣는다(Incoming 리터럴에 `images,` 추가).
- publish에 이미지를 싣는다:
```ts
    this.bus.publish({
      type: "user_message",
      channel: "discord",
      channelRef: hint.discordChannelId,
      text: incoming.content,
      ts: Date.now(),
      hint,
      images: incoming.images.length > 0 ? incoming.images : undefined,
    });
```

- [ ] **Step 3: 매핑 회귀 테스트(순수부)**

어댑터 자체는 discord.js 의존이라 유닛 대상이 아니다. 대신 `filterImageAttachments`가 어댑터가 넘기는 형태(`{url, contentType, name, size}`)를 처리함은 Task 1 테스트가 이미 커버. 추가로 "contentType null(디스코드가 종종 null)"을 무시하는지 `images.test.ts`에 한 케이스 보강:
```ts
  it("contentType null 은 무시한다", () => {
    const r = filterImageAttachments([{ url: "u", contentType: null, name: "x", size: 1 }]);
    expect(r.images).toHaveLength(0);
  });
```

- [ ] **Step 4: 통과 확인(tsc 포함)**

Run: `cd agent && npx vitest run tests/images.test.ts && npx tsc --noEmit`
Expected: PASS, tsc 0(모든 필드 optional이라 core 미변경으로도 컴파일).

- [ ] **Step 5: 커밋**

```bash
git add agent/src/events/bus.ts agent/src/adapters/discord.ts agent/tests/images.test.ts
git commit -m "feat(image): user_message 이벤트 images + 어댑터 첨부 캡처

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: agent.ts — TurnRequest.images + 멀티모달 prompt

**Files:**
- Modify: `agent/src/core/agent.ts` (`TurnRequest.images`, `buildMultimodalMessage`, query prompt 조건부)
- Test: `agent/tests/agent.test.ts`

**Interfaces:**
- Consumes: `ImageInput`(Task 1), `SDKUserMessage`(SDK)
- Produces: `TurnRequest.images?: ImageInput[]`; `buildMultimodalMessage(text, images): SDKUserMessage`

- [ ] **Step 1: 실패 테스트 작성**

`agent/tests/agent.test.ts`에 추가:
```ts
import { buildMultimodalMessage } from "../src/core/agent.js";

describe("buildMultimodalMessage", () => {
  const img = { mediaType: "image/png", base64: "AAA", name: "a.png" };
  it("텍스트+이미지를 content 블록으로 만든다", () => {
    const m = buildMultimodalMessage("이게 뭐야", [img]) as any;
    expect(m.type).toBe("user");
    expect(m.message.role).toBe("user");
    expect(m.message.content[0]).toEqual({ type: "text", text: "이게 뭐야" });
    expect(m.message.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } });
  });
  it("텍스트가 비면 이미지 블록만 넣는다", () => {
    const m = buildMultimodalMessage("   ", [img]) as any;
    expect(m.message.content).toHaveLength(1);
    expect(m.message.content[0].type).toBe("image");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/agent.test.ts -t buildMultimodalMessage`
Expected: FAIL — export 없음.

- [ ] **Step 3: 구현**

`agent/src/core/agent.ts`:
- import 추가: `import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";` 와 `import type { ImageInput } from "./images.js";`
  (주의: `SDKUserMessage`가 메인 엔트리에서 type export 되는지 확인. 안 되면 로컬 최소 타입 `type UserMsg = { type: "user"; parent_tool_use_id: null; message: { role: "user"; content: unknown[] } }` 을 정의해 쓰고 query에는 그대로 넘긴다.)
- `TurnRequest` 타입에 `images?: ImageInput[];` 추가.
- 순수 함수 추가(파일 상단 유틸 근처):
```ts
// 이미지가 있는 턴의 SDK 입력 메시지(멀티모달). 텍스트가 비면 이미지 블록만 넣는다.
export function buildMultimodalMessage(text: string, images: ImageInput[]): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const img of images) {
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  }
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content } } as unknown as SDKUserMessage;
}
```
- 러너 안에서 `query({ prompt: ... })` 앞에 prompt 입력을 조건부로:
```ts
    const promptInput = req.images && req.images.length > 0
      ? (async function* () { yield buildMultimodalMessage(req.prompt, req.images!); })()
      : req.prompt;
```
  그리고 `query({ prompt: promptInput, options: { ... } })` 로(기존 `prompt: req.prompt` 를 `prompt: promptInput` 로 교체).

- [ ] **Step 4: 통과 확인**

Run: `cd agent && npx vitest run tests/agent.test.ts && npx tsc --noEmit`
Expected: PASS, tsc 0. (이미지 없으면 promptInput=string 그대로라 기존 경로 회귀 없음.)

- [ ] **Step 5: 커밋**

```bash
git add agent/src/core/agent.ts agent/tests/agent.test.ts
git commit -m "feat(image): agent 멀티모달 prompt — buildMultimodalMessage + async-iterable 입력

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: core.ts 배선 — 마커 저장·라우팅·다운로드 + 전체 검증

**Files:**
- Modify: `agent/src/core/core.ts` (fetchImpl dep, ingest 마커·images 전달, 위임 게이트 이미지 조건, runConversationTurn 다운로드·전달)
- Test: `agent/tests/coreMulti.test.ts`

**Interfaces:**
- Consumes: `buildImageMarker`·`downloadImages`·`ImageRef`(Task 1), `TurnRequest.images`(Task 3), `UserMessageEvent.images`(Task 2)

- [ ] **Step 1: 실패 테스트 작성**

`agent/tests/coreMulti.test.ts`에 추가. 상단 `setup`에 fetchImpl 주입 옵션이 필요하므로, setup 시그니처에 `imageFetch?`를 더하고(아래 Step 3에서 core가 받도록) AgentCore 생성에 전달한다. 그리고 이미지 이벤트를 쏘는 헬퍼로 검증:
```ts
describe("AgentCore — 이미지 입력", () => {
  const fakeFetch = (async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("img").buffer }) as Response) as unknown as typeof fetch;

  it("이미지 메시지는 마커로 저장되고, 다운로드된 이미지가 runTurn 에 전달된다", async () => {
    const t = await setup({ imageFetch: fakeFetch });
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "이게 뭐야", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "a.png", size: 3 }] });
    await t.core.drain();
    // runTurn 에 이미지 전달
    expect(t.calls[0].images).toHaveLength(1);
    expect(t.calls[0].images[0].base64).toBe(Buffer.from("img").toString("base64"));
    // 저장은 마커
    const conv = await t.repos.conversations.getByChannelId("dm-owner");
    const recent = await t.repos.messages.recent(conv!.id, 5);
    expect(recent.some((m) => m.role === "user" && m.content.includes("[이미지 1장: a.png]"))).toBe(true);
  });

  it("이미지가 있으면 워커가 온라인이어도 위임하지 않고 봇이 직접 처리한다", async () => {
    const t = await setup({ imageFetch: fakeFetch });
    await t.repos.jobs.heartbeat("owner"); // 워커 온라인으로
    const hint = dmHint("owner", "owner");
    t.bus.publish({ type: "user_message", channel: "discord", channelRef: hint.discordChannelId, text: "봐줘", ts: 1, hint,
      images: [{ url: "u", mediaType: "image/png", name: "a.png", size: 3 }] });
    await t.core.drain();
    expect(t.calls).toHaveLength(1); // 위임(enqueue) 아니라 직접 runTurn
    const pending = await t.repos.jobs.claimNext("owner", 999999);
    expect(pending).toBeNull(); // 위임된 job 없음
  });
});
```
(주의: `jobs.heartbeat`/`isOnline`은 DB 시계 기반이라 pg-mem에서 온라인 판정이 될 수도/안 될 수도 있다. 두 번째 테스트의 핵심 단언은 "위임 job 이 없다(claimNext null)"와 "calls===1" — 이미지가 위임을 막는지다. 만약 pg-mem 시계로 online 판정이 안 되면 이 테스트는 "이미지든 아니든 위임 안 됨"이 되어 약해지므로, 대신 **라우팅 순수 조건**을 직접 단언하는 방식으로 보강: core에 위임여부를 결정하는 부분을 그대로 두되, 이미지 turn에서 `delegateToWorker`가 호출되지 않음을 calls/claimNext로 확인한다. online 판정이 불확실하면 이 테스트를 `it`로 남기되 주석으로 실 Postgres 확인 필요를 명시.)

- [ ] **Step 2: 실패 확인**

Run: `cd agent && npx vitest run tests/coreMulti.test.ts -t 이미지`
Expected: FAIL — images가 runTurn에 안 실림/마커 없음.

- [ ] **Step 3: core.ts 수정**

1) import: `import { buildImageMarker, downloadImages, type ImageRef } from "./images.js";`
2) AgentCore deps/필드에 `fetchImpl`:
   - 생성자 deps 타입에 `fetchImpl?: typeof fetch;` 추가.
   - 필드 `private fetchImpl: typeof fetch;` 그리고 생성자에서 `this.fetchImpl = deps.fetchImpl ?? fetch;`
3) `onUserMessage(e)` → ingest 에 images 전달: `this.enqueue(this.ingestChains, hint.discordChannelId, () => this.ingest(hint, e.ts, e.text, e.images ?? []))`
4) `ingest(hint, ts, text, images: ImageRef[])` 시그니처 확장:
   - 예약어(parseSessionCommand) 분기는 그대로(명령어엔 이미지 무시).
   - 메시지 저장 content를 마커로: `content: buildImageMarker(text, images)` (기존 `content: text` 를 교체).
   - turn 큐에 images 전달: `this.enqueue(this.turnChains, hint.discordChannelId, () => this.runConversationTurn(conv.id, hint.userId, hint.role as "owner"|"allowed", text, messageId, images))`
5) `runConversationTurn(convId, userId, role, text, messageId, images: ImageRef[] = [])` 시그니처 확장:
   - **위임 게이트**에 이미지 조건 추가: 기존 `if (isOwner && conv.isPrivate && await this.repos.jobs.isOnline(userId, WORKER_ONLINE_CUTOFF_MS))` 를 `if (images.length === 0 && isOwner && conv.isPrivate && await this.repos.jobs.isOnline(userId, WORKER_ONLINE_CUTOFF_MS))` 로.
   - runTurn 호출 전에 이미지 다운로드: 
     ```ts
     const imageInputs = images.length > 0 ? (await downloadImages(images, { fetchImpl: this.fetchImpl })).inputs : [];
     ```
   - `runTurn({ prompt, systemPrompt, resume, cwd, context, onProgress, images: imageInputs })` (두 곳: 최초 호출과 resume 실패 후 재시도 호출 모두에 `images: imageInputs` 추가).
   - **주의**: 크래시복구(recoverPending)는 저장된 메시지(마커 텍스트)만 재개하므로 이미지가 없다(복구 시 images=[]). 이는 허용(복구된 이미지 턴은 텍스트만) — 마커에 이미지가 있었음이 남아 모델이 맥락은 앎.

- [ ] **Step 4: setup 헬퍼에 imageFetch 배선**

`coreMulti.test.ts`의 `setup` 함수: `over`에 `imageFetch?: typeof fetch` 를 받고, `new AgentCore({ ..., fetchImpl: over.imageFetch })` 로 넘긴다(기존 인자 옆에 추가).

- [ ] **Step 5: 통과 확인 + 전체**

Run: `cd agent && npx vitest run tests/coreMulti.test.ts -t 이미지 && npx tsc --noEmit && npm test && npm run build`
Expected: PASS 전체, `dist/index.js`·`dist/worker.js` 생성. 확인 후 `rm -rf agent/dist`.

- [ ] **Step 6: 커밋**

```bash
git add agent/src/core/core.ts agent/tests/coreMulti.test.ts
git commit -m "feat(image): core 배선 — 마커 저장·이미지턴 봇직접·다운로드→runTurn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 검증·마무리 (플랜 밖, 실행자 참고)
- 전체: `cd agent && npx tsc --noEmit && npm test && npm run build`.
- **런타임 스파이크(배포 스모크 — 유닛으로 불가)**: 재배포 후 디스코드에서 이미지+텍스트를 보내 (1) 모델이 이미지를 실제로 보고 답하는지, (2) 이어서 텍스트만 보냈을 때 resume가 정상인지(async-iterable prompt 이후 세션), (3) 손님/서버에서도 되는지, (4) 큰/비이미지 첨부가 무시·안내되는지. resume 문제 시 폴백(이미지 턴 새 세션)을 후속으로 반영.
- SDKUserMessage import가 tsconfig에서 해결 안 되면 Task 3의 로컬 최소 타입으로 대체(계획에 명시).

## Self-Review 메모(작성자 확인 완료)
- 스펙 커버리지: §3 흐름→T1~T4, §4 타입→T1/T3, §5 멀티모달→T3(+배포 스파이크), §6 마커·재주입없음→T4(마커)+buildContextBlock 무변경, §7 라우팅→T4(위임 게이트 이미지 조건), §8 제한→T1(filter/limits/download), §9 파일→T1~T4. 누락 없음.
- 타입 일관성: `ImageRef`(images.ts, bus·core), `ImageInput`(images.ts, agent·TurnRequest), `buildMultimodalMessage`, `filterImageAttachments`/`buildImageMarker`/`downloadImages` 시그니처가 T1→T4 동일.
- 위험: (a) 모든 새 필드 optional이라 태스크별 tsc 그린 유지(ripple 없음). (b) pg-mem online 판정 불확실 → T4 두 번째 테스트는 "위임 job 없음"을 핵심 단언으로. (c) SDK async-iterable+resume 런타임은 배포 스모크 필수(유닛 불가) — 은닉 없이 명시.
