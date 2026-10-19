/**
 * Static/dynamic boundary marker for system prompts.
 *
 * The app-level prompt builder emits this literal string between the
 * cache-stable prefix and the per-turn dynamic suffix. LoopAgent uses it to
 * keep only the stable prefix in the leading system message and relocate the
 * dynamic suffix to transient tail context. Provider adapters also understand
 * it for direct SDK callers (Anthropic cache_control; OpenAI-compatible marker
 * stripping).
 *
 * Kept in zapsdk core so both app-side (src/prompts) and provider-side
 * (zapsdk/core/providers) share the same string without a circular import.
 */
export const DYNAMIC_BOUNDARY = "<!-- __ZAPCODE_DYNAMIC_BOUNDARY__ -->";
const ESCAPED_DYNAMIC_BOUNDARY = "<!-- __ZAPCODE_DYNAMIC_BOUNDARY_LITERAL__ -->";

/**
 * Neutralize user/project-provided copies of the internal boundary marker.
 * Only prompt assembly code should be able to create real cache boundaries;
 * otherwise AGENTS.md, tool prompt text, or a custom system prompt can
 * accidentally move stable sections into the dynamic suffix.
 */
export function escapeDynamicBoundaryText(text: string): string {
  return text.includes(DYNAMIC_BOUNDARY)
    ? text.split(DYNAMIC_BOUNDARY).join(ESCAPED_DYNAMIC_BOUNDARY)
    : text;
}

/**
 * Split a system prompt string at the dynamic boundary. Returns
 * (staticPrefix, dynamicSuffix). If the marker is absent, returns
 * (whole, "") — caller can treat the whole prompt as static.
 */
export function splitAtBoundary(prompt: string): [staticPart: string, dynamicPart: string] {
  const idx = prompt.indexOf(DYNAMIC_BOUNDARY);
  if (idx === -1) return [prompt, ""];
  const before = prompt.slice(0, idx).trimEnd();
  const after = prompt.slice(idx + DYNAMIC_BOUNDARY.length).trimStart();
  return [before, after];
}

/**
 * Remove the boundary marker from the prompt, producing a clean single
 * string. Used by providers that don't support explicit cache breakpoints
 * (OpenAI-compatible) — they just need the marker not to appear in the
 * actual sent prompt.
 */
export function stripBoundary(prompt: string): string {
  if (!prompt.includes(DYNAMIC_BOUNDARY)) return prompt;
  const [first = "", ...rest] = prompt.split(DYNAMIC_BOUNDARY);
  const staticPart = first.trimEnd();
  const dynamicPart = rest
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  return dynamicPart ? `${staticPart}\n\n${dynamicPart}` : staticPart;
}
