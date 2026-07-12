// 디스코드 이미지 첨부 → 모델 전달용 처리(순수 로직 + 얇은 fetch). 이미지는 그 턴에만 쓰이며
// DB엔 마커 텍스트만 저장한다(과거 이미지 재주입 없음 — 비용 방지).
export type ImageRef = { url: string; mediaType: string; name: string; size: number };
export type ImageInput = { mediaType: string; base64: string; name: string };
type RawAttachment = { url: string; contentType: string | null; name: string; size: number };

export const IMAGE_LIMITS = Object.freeze({
  maxCount: 4,
  maxBytes: 5 * 1024 * 1024,
  allowed: Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"] as const),
} as const);

export function filterImageAttachments(
  atts: RawAttachment[],
  limits: { maxCount: number; maxBytes: number; allowed: readonly string[] } = IMAGE_LIMITS,
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
