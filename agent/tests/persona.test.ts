import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/core/persona.js";

describe("buildSystemPrompt", () => {
  it("이모지·이모티콘 사용 금지 지침을 항상 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/이모지|이모티콘/);
  });

  it("답변 품질 지침(정확성·간결함)을 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/정확/);
    expect(p).toMatch(/간결/);
  });

  it("기억(remember/recall) 도구 안내를 유지한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/remember/);
    expect(p).toMatch(/recall/);
  });

  it("외부 관찰 콘텐츠의 지시 실행 금지 문구를 유지한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/신뢰할 수 없는/);
  });

  it("owner+DM 이면 파일 도구·manage_access 능력 안내를 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/manage_access/);
    expect(p).toMatch(/파일/);
  });

  it("owner+DM 이면 Bash 봉쇄를 과장하지 않고, 폴더 밖·시스템·네트워크 작업은 하지 말라고 안내한다(보안리뷰 #2)", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/Bash/);
    // "Bash 도 허용 폴더 안에서만 가능하다"는 실제보다 강한(거짓) 보장 문구는 없어야 한다.
    expect(p).not.toMatch(/파일\s*[·,]?\s*셸\(?Bash\)?\s*작업은[^.]*허용\s*폴더\s*안에서만\s*가능/);
    expect(p).toMatch(/완전히 막지/);
    expect(p).toMatch(/네트워크/);
  });

  it("손님 DM 이면 대화·본인 기억만 가능하다는 안내를 포함하고, 파일/manage_access 능력은 언급하지 않는다", () => {
    const p = buildSystemPrompt({ role: "allowed", isPrivate: true, isOwner: false });
    expect(p).toMatch(/기억/);
    expect(p).not.toMatch(/manage_access/);
  });

  it("서버(비 DM) 대화면 공용 recall 전용 안내를 포함하고, manage_access 는 언급하지 않는다", () => {
    const p = buildSystemPrompt({ role: "allowed", isPrivate: false, isOwner: false });
    expect(p).toMatch(/recall/);
    expect(p).not.toMatch(/manage_access/);
  });

  it("항상 한국어 응답 지침을 포함한다", () => {
    const p = buildSystemPrompt({ role: "owner", isPrivate: true, isOwner: true });
    expect(p).toMatch(/한국어/);
  });
});
