import { inflateSync } from "node:zlib";
import { CODEX_RESPONSES_BASE_URL } from "./openai-responses.js";
import { parseImageDimensions } from "../../utils/image-dimensions.js";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 300_000;
export interface ImageGenerationRequest {
  prompt: string;
  quality?: "auto" | "low" | "medium" | "high";
  size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  background?: "auto" | "opaque" | "transparent";
}
export interface GeneratedImage {
  bytes: Buffer;
  width: number;
  height: number;
  requestBytes: number;
  responseBytes: number;
}
export interface CodexImageOptions {
  model: string;
  getCredentials: (signal?: AbortSignal) => Promise<{ accessToken: string; accountId?: string }>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  idleMs?: number;
  maxResponseBytes?: number;
}


const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function validPngPixels(bytes: Buffer, width: number, height: number): boolean {
  const compressed: Buffer[] = [];
  let offset = 8, header = false, ended = false, palette = false, depth = 0, color = 0, interlace = 0;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 8 + length;
    if (end + 4 > bytes.length) return false;
    const kind = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(kind)) return false;
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end)) return false;
    if (!header && kind !== "IHDR") return false;
    if (kind === "IHDR") {
      if (header || length !== 13) return false;
      header = true; depth = bytes[offset + 16]!; color = bytes[offset + 17]!; interlace = bytes[offset + 20]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1) return false;
    } else if (kind === "IDAT") compressed.push(bytes.subarray(offset + 8, end));
    else if (kind === "PLTE") { if (!length || length > 768 || length % 3) return false; palette = true; }
    else if (kind === "IEND") { ended = length === 0 && end + 4 === bytes.length; break; }
    else if (kind === "acTL" || !/^[a-z]/.test(kind)) return false;
    offset = end + 4;
  }
  if (!ended || !compressed.length || (color === 3 && !palette)) return false;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  try {
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: 68 * 1024 * 1024 });
    let cursor = 0;
    for (const [x, y, dx, dy] of passes) {
      const w = Math.max(0, Math.ceil((width - x!) / dx!)), h = Math.max(0, Math.ceil((height - y!) / dy!));
      if (!w || !h) continue;
      const row = Math.ceil(w * depth * channels[color]! / 8) + 1;
      for (let line = 0; line < h; line++) { if (cursor + row > raw.length || raw[cursor]! > 4) return false; cursor += row; }
    }
    return cursor === raw.length;
  } catch { return false; }
}

export function validateGeneratedPng(bytes: Buffer): { width: number; height: number } {
  const dimensions = parseImageDimensions(bytes);
  if (bytes.length > IMAGE_MAX_BYTES || bytes.length < 32 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || !dimensions || dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 16_777_216 || !validPngPixels(bytes, dimensions.width, dimensions.height)) {
    throw new Error("Generated image is not a supported PNG or exceeds the image size limit.");
  }
  return dimensions;
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("Image generation cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Host-owned model request, like the conversation provider. It has its own
 * bounded HTTP budget, not the ordinary tool HTTP-fetch budget. No retries:
 * retrying an interrupted generation can charge for another image. */
export async function generateCodexImage(options: CodexImageOptions, args: ImageGenerationRequest, signal?: AbortSignal): Promise<GeneratedImage> {
  if (!options.model || options.model.length > 256 || /[\x00-\x1f\x7f]/.test(options.model)) throw new Error("Select a valid Codex model before generating images.");
  if (!args.prompt.trim() || Buffer.byteLength(args.prompt) > 16_000) throw new Error("Image prompt must be 1–16000 UTF-8 bytes.");
  const requestSignal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? IMAGE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  requestSignal.throwIfAborted();
  const credentials = await abortable(options.getCredentials(requestSignal), requestSignal);
  requestSignal.throwIfAborted();
  const body = JSON.stringify({ model: options.model, instructions: "Generate exactly one image with the image generation tool, following the user's prompt.",
    input: [{ role: "user", content: args.prompt }], store: false, stream: true,
    tools: [{ type: "image_generation", model: "gpt-image-2", output_format: "png", quality: args.quality ?? "auto",
      size: args.size ?? "auto", background: args.background ?? "auto" }], tool_choice: { type: "image_generation" } });
  const requestBytes = Buffer.byteLength(body);
  const response = await abortable((options.fetch ?? fetch)(`${CODEX_RESPONSES_BASE_URL}/responses`, {
    method: "POST", headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json", originator: "zap",
      ...(credentials.accountId ? { "ChatGPT-Account-ID": credentials.accountId } : {}) },
    body, signal: requestSignal, redirect: "error",
  }), requestSignal);
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Codex image generation failed (HTTP ${response.status}). Check Codex sign-in, model access and usage limits.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const images = new Map<string, { bytes: Buffer; width: number; height: number }>();
  let responseBytes = 0, buffer = "", data: string[] = [], completed = false;
  const capture = (item: any) => {
    if (item?.type !== "image_generation_call") return;
    if (item.status !== "completed" || typeof item.id !== "string" || typeof item.result !== "string") {
      throw new Error("Codex returned an incomplete image generation result.");
    }
    if (item.result.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)) {
      throw new Error("Codex returned an invalid or oversized image payload.");
    }
    if (images.has(item.id)) {
      if (images.get(item.id)!.bytes.toString("base64") !== item.result) throw new Error("Codex returned conflicting image results.");
      return;
    }
    if (images.size) throw new Error("Codex returned more than one image for a single-image request.");
    const bytes = Buffer.from(item.result, "base64");
    if (bytes.toString("base64") !== item.result) throw new Error("Codex returned an invalid image encoding.");
    images.set(item.id, { bytes, ...validateGeneratedPng(bytes) });
  };
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (payload === "[DONE]") return;
    let event: any;
    try { event = JSON.parse(payload); } catch { throw new Error("Invalid Codex image generation stream."); }
    if (event.type === "response.output_item.done") capture(event.item);
    if (event.type === "response.completed") {
      if (event.response?.status !== "completed") throw new Error("Codex image generation did not complete.");
      for (const item of event.response.output ?? []) capture(item);
      completed = true;
    } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
      throw new Error("Codex image generation failed or was incomplete. It was not automatically retried.");
    }
  };
  const consume = (text: string) => {
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
      if (!line) dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  };
  try {
    while (!completed) {
      requestSignal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { void reader.cancel().catch(() => {}); };
      requestSignal.addEventListener("abort", onAbort, { once: true });
      try {
        const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new Error("Codex image generation stream timed out.")); void reader.cancel().catch(() => {}); }, options.idleMs ?? 90_000);
        })]);
        requestSignal.throwIfAborted();
        if (part.done) { consume(decoder.decode() + "\n\n"); break; }
        responseBytes += part.value.byteLength;
        if (responseBytes > Math.min(options.maxResponseBytes ?? IMAGE_RESPONSE_MAX_BYTES, IMAGE_RESPONSE_MAX_BYTES)) throw new Error("Codex image generation response exceeds its byte limit.");
        consume(decoder.decode(part.value, { stream: true }));
      } finally { if (timer) clearTimeout(timer); requestSignal.removeEventListener("abort", onAbort); }
    }
    requestSignal.throwIfAborted();
    if (!completed || images.size !== 1) throw new Error("Codex stream ended without a completed image. It was not automatically retried.");
    return { ...images.values().next().value!, requestBytes, responseBytes };
  } finally { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
}
