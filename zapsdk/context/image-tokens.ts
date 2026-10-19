import { canonicalModelId } from "../core/model-identity.js";
import type { ImageContent } from "../core/types.js";
import { imageDimensions } from "../utils/image-dimensions.js";

export type ImageTokenRule =
  | { kind: "deepseek" }
  | { kind: "claude"; maxEdge: number; maxTokens: number }
  | { kind: "tiles"; base: number; tile: number }
  | { kind: "patches"; maxEdge: number; maxPatches: number; multiplier: number; resizeToBudget?: boolean };

export interface ImageTokenContext {
  model?: string;
  /** Catalog identity is local accounting metadata, never a request model override. */
  canonicalModelId?: string;
  supportsVision?: boolean;
  /** Anthropic image blocks have no OpenAI detail field. */
  supportsImageDetail?: boolean;
  /** Explicit rule for private deployments/aliases; no endpoint-brand inference. */
  imageTokenRule?: ImageTokenRule;
}
export interface ImageTokenEstimate {
  tokens: number;
  basis: "model-rule" | "model-upper-bound" | "heuristic" | "not-sent";
  rule: ImageTokenRule["kind"] | "unknown";
}

// Verified against official calculators/docs on 2026-10-18. See docs/architecture/59-image-token-estimation.md.
const tiles: Record<string, [number, number]> = {
  "gpt-4o": [85, 170], "gpt-4.1": [85, 170], "gpt-4o-mini": [2833, 5667],
  "gpt-5": [70, 140], "gpt-5.1": [70, 140], "o1": [75, 150], "o1-pro": [75, 150], "o3": [75, 150],
};
const patches: Record<string, [number, number, number]> = {
  "gpt-4.1-mini": [2048, 6144, 1.62], "gpt-5.2": [2048, 6144, 1.2],
  "gpt-5.4": [2048, 2500, 1.2], "gpt-5.4-mini": [2048, 2500, 1.2], "gpt-5.4-nano": [2048, 2500, 1.2],
  "gpt-5.5": [6000, 10000, 1.2], "gpt-5.6-sol": [65535, 30000, 1.2],
  "gpt-5.6-terra": [65535, 30000, 1.2], "gpt-5.6-luna": [65535, 30000, 1.2],
  "gpt-6-astra": [65535, 30000, 1.2],
};

export function resolveImageTokenRule(context: ImageTokenContext, detail: ImageContent["detail"] = "auto"): ImageTokenRule | undefined {
  if (context.imageTokenRule) return context.imageTokenRule;
  const canonical = canonicalModelId(context.canonicalModelId);
  // A known identity supersedes a misleading alias. Unknown canonical models
  // fall back rather than silently borrowing the alias's rule.
  const identity = canonical ?? context.model ?? "";
  const model = identity.toLowerCase().split("/").at(-1)!.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (canonical) {
    const lab = canonical.split("/")[0];
    if (!(lab === "deepseek" && model.startsWith("deepseek-")) &&
        !(lab === "anthropic" && model.startsWith("claude-")) &&
        !(lab === "openai" && /^(gpt-|o[134])/.test(model))) return undefined;
  }
  if (["deepseek-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash-1017"].includes(model)) return { kind: "deepseek" };
  const claude = model.match(/^claude-(?:opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2}))?(?:-\d{8}|-latest)?$/);
  if (claude || /^claude-3(?:-[57])?-(?:opus|sonnet|haiku)(?:-\d{8}|-latest)?$/.test(model)) {
    const high = !!claude && (+claude[1]! > 4 || (+claude[1]! === 4 && +(claude[2] ?? 0) >= 7));
    return { kind: "claude", maxEdge: high ? 2576 : 1568, maxTokens: high ? 4784 : 1568 };
  }
  const tile = Object.hasOwn(tiles, model) ? tiles[model] : undefined;
  if (tile) return { kind: "tiles", base: tile[0], tile: tile[1] };
  const patch = Object.hasOwn(patches, model) ? patches[model] : undefined;
  if (!patch) return undefined;
  let [maxEdge, maxPatches, multiplier] = patch;
  if (/^gpt-5\.[456]|^gpt-6-astra$/.test(model)) {
    if (detail === "low") {
      [maxEdge, maxPatches] = model.startsWith("gpt-5.4") ? [2048, 6144] : [512, 256];
    } else if (detail === "high") {
      [maxEdge, maxPatches] = [model === "gpt-6-astra" ? 65535 : 2048, 2500];
    } else if (detail === "original" && model.startsWith("gpt-5.4")) {
      [maxEdge, maxPatches] = [6000, 10000];
    }
  }
  return { kind: "patches", maxEdge, maxPatches, multiplier, resizeToBudget: maxPatches !== 30000 };
}

export function estimateImageTokens(image: ImageContent, context: ImageTokenContext = {}): ImageTokenEstimate {
  if (context.supportsVision === false || !image.base64) return { tokens: 0, basis: "not-sent", rule: "unknown" };
  const detail = context.supportsImageDetail === false ? "auto" : image.detail ?? "auto";
  const rule = resolveImageTokenRule(context, detail);
  const dimensions = imageDimensions(image);
  if (!rule) {
    // Unknown tokenizers have no universal upper bound. Keep this visibly heuristic.
    const tokens = dimensions ? Math.min(32768, Math.max(1024, patchCount(dimensions.width, dimensions.height, 28))) : 4096;
    return { tokens, basis: "heuristic", rule: "unknown" };
  }
  if (rule.kind === "tiles" && detail === "low") return { tokens: rule.base, basis: "model-rule", rule: rule.kind };
  if (!dimensions) {
    const tokens = rule.kind === "deepseek" ? 1024 : rule.kind === "claude" ? rule.maxTokens
      : rule.kind === "tiles" ? rule.base + 8 * rule.tile : Math.ceil(rule.maxPatches * rule.multiplier);
    return { tokens, basis: "model-upper-bound", rule: rule.kind };
  }
  let { width, height } = dimensions;
  let tokens: number;
  if (rule.kind === "deepseek") {
    if (detail === "low") [width, height] = fitEdge(width, height, 512);
    tokens = deepseekImageTokens(width, height);
  } else if (rule.kind === "claude") {
    tokens = boundedPatchCount(width, height, 28, rule.maxEdge, rule.maxTokens, roundTiesToEven);
  } else if (rule.kind === "tiles") {
    [width, height] = fitEdge(width, height, 2048);
    const scale = Math.min(1, 768 / Math.min(width, height));
    tokens = rule.base + rule.tile * patchCount(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), 512);
  } else {
    [width, height] = fitEdge(width, height, rule.maxEdge);
    // Original on these models rejects >30k patches instead of resizing. Count
    // the actual size so budgeting doesn't silently assume a server resize.
    const original = rule.resizeToBudget === false;
    let count = patchCount(width, height, 32);
    if (!original && count > rule.maxPatches) {
      const scale = Math.sqrt(32 * 32 * rule.maxPatches / (width * height));
      const adjusted = scale * Math.min(Math.floor(width * scale / 32) / (width * scale / 32), Math.floor(height * scale / 32) / (height * scale / 32));
      if (adjusted > 0) count = patchCount(Math.max(1, Math.floor(width * adjusted)), Math.max(1, Math.floor(height * adjusted)), 32);
      else count = boundedPatchCount(width, height, 32, rule.maxEdge, rule.maxPatches);
    }
    tokens = Math.ceil(count * rule.multiplier);
  }
  return { tokens, basis: "model-rule", rule: rule.kind };
}

function patchCount(w: number, h: number, patch: number): number { return Math.ceil(w / patch) * Math.ceil(h / patch); }
function fitEdge(w: number, h: number, edge: number): [number, number] {
  const scale = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}
// Claude's reference implementation and API round exact half-pixel ties to
// even; Math.round alone can move the short edge across a token boundary.
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
function boundedPatchCount(w: number, h: number, patch: number, edge: number, budget: number, round = Math.round): number {
  if (h > w) return boundedPatchCount(h, w, patch, edge, budget, round);
  const fits = (a: number, b: number) => Math.ceil(a / patch) * patch <= edge && Math.ceil(b / patch) * patch <= edge && patchCount(a, b, patch) <= budget;
  if (fits(w, h)) return patchCount(w, h, patch);
  const aspectRatio = w / h;
  let lo = 1, hi = w;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(1, round(mid / aspectRatio)))) lo = mid;
    else hi = mid;
  }
  return patchCount(lo, Math.max(1, round(lo / aspectRatio)), patch);
}

/** DeepSeek's public v4.1 image calculator: 14px patches, 3x downsampling,
 * row separators + 2 framing tokens, min area 544², maximum 1024 tokens.
 * Width/height are intentionally not sorted: row separators are directional. */
export function deepseekImageTokens(width: number, height: number): number {
  let w = width, h = height, previous = "";
  for (let iteration = 0; iteration < 10; iteration++) {
    if (w * h < 544 * 544) {
      const scale = Math.sqrt(544 * 544 / (w * h));
      w = Math.trunc(w * scale); h = Math.trunc(h * scale);
    }
    const sourceWidth = w, sourceHeight = h;
    w = Math.ceil(w / 14) * 14; h = Math.ceil(h / 14) * 14;
    let rows = Math.ceil(h / 42), columns = Math.ceil(w / 42);
    let tokens = rows * (columns + 1) + 2;
    if (tokens > 1024) {
      const ratio = sourceHeight / sourceWidth;
      const targetColumns = Math.sqrt(1022 / ratio + 0.25) - 0.5;
      const targetRows = targetColumns * ratio;
      if (targetColumns < 1) { w = 42; h = Math.floor(1022 / 2) * 42; }
      else if (targetRows < 1) { h = 42; w = 1021 * 42; }
      else {
        const scale = Math.min(Math.trunc(targetColumns) * 42 / sourceWidth, Math.trunc(targetRows) * 42 / sourceHeight);
        w = Math.trunc(sourceWidth * scale / 14) * 14; h = Math.trunc(sourceHeight * scale / 14) * 14;
      }
      rows = Math.ceil(h / 42); columns = Math.ceil(w / 42);
      tokens = rows * (columns + 1) + 2;
    }
    const state = `${w},${h},${tokens}`;
    if (state === previous) return Math.min(1024, tokens);
    previous = state;
  }
  return 1024; // Nonconvergence: documented upper bound, never a fabricated precise count.
}
