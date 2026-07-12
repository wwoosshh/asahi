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
