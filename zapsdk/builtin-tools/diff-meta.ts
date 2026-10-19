/**
 * Tool-side diff metadata.
 *
 * Write/edit tools compute a compact unified-diff string at the moment of
 * modification and place it under `ToolResult.meta`. Consumers (UI, telemetry,
 * session restore) read it directly — no re-computation, no need to persist
 * the full pre-/post-file bytes.
 *
 * Design contract:
 *   - `diff` is already-formatted unified diff text (feeds straight into
 *     OpenTUI's <diff> renderable, or any git-diff consumer).
 *   - `filetype` is a tree-sitter identifier derived from the file extension,
 *     carried alongside so downstream rendering doesn't need the path.
 *   - `oldBytes` / `newBytes` let UI show a size delta without re-reading.
 *   - Produced once at the SDK level — UI should not need diff algorithms.
 */
export interface DiffMeta {
  diff: string;
  filetype: string;
  oldBytes: number;
  newBytes: number;
  /** Set when diff generation was skipped (e.g. binary file, read error). */
  skipped?: "binary" | "read_error" | "too_large";
}

import { createPatch } from "diff";
import { pathToFiletype } from "../utils/filetype.js";

/** 5s timeout inside jsdiff aborts the Myers walk on very large / pathological
 *  inputs. Matches Claude Code's cap. */
const DIFF_TIMEOUT_MS = 5_000;

/** Bail out before even calling jsdiff when the input is absurdly large.
 *  Anything past this is almost certainly a machine-generated blob — showing
 *  a diff helps nobody. Prevents main-thread stalls for multi-megabyte files. */
const DIFF_MAX_BYTES = 1_000_000; // 1 MB per side

/**
 * Build a unified-diff string covering only the changed region (+context).
 *
 * Delegates to jsdiff's `createPatch` (Myers with internal timeout). We could
 * use `structuredPatch` + format manually, but `createPatch` already returns
 * the exact unified-diff text the UI consumes.
 *
 * Returns empty string when either side exceeds `DIFF_MAX_BYTES`, when jsdiff
 * times out, or when there are no changes — callers MUST treat empty diff as
 * "don't render a hunk" rather than "identical".
 */
export function buildUnifiedDiff(
  oldText: string,
  newText: string,
  filePath: string,
  contextLines = 3,
): string {
  if (oldText.length > DIFF_MAX_BYTES || newText.length > DIFF_MAX_BYTES) return "";

  // Pass a short opaque name to createPatch — we strip the `--- / +++` header
  // below anyway, and if the real path contains non-ASCII chars (Chinese file
  // names, etc.) jsdiff quotes it with C-style octal escapes (\345\205\250...)
  // which leaks into consumer UIs.
  const patch = createPatch("file", oldText, newText, undefined, undefined, {
    context: contextLines,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (!patch) return "";

  // jsdiff emits:
  //   Index: <name>
  //   ===================================================================
  //   --- <name>
  //   +++ <name>
  //   @@ ... @@
  //    ...
  //   \ No newline at end of file
  //
  // For UI rendering we only want the `@@` hunks and their body. The path
  // is already shown separately in the approval dialog, and the "\ No newline"
  // trailer clutters every single edit without conveying useful information
  // to humans.
  const stripped = patch
    .replace(/^Index:.*\n=+\n/, "")
    .replace(/^---[^\n]*\n/m, "")
    .replace(/^\+\+\+[^\n]*\n/m, "")
    .replace(/\\ No newline at end of file\n?/g, "");

  // Empty patch (no hunks after stripping) — detect and return "".
  if (!/^@@/m.test(stripped)) return "";
  return stripped;
}

/** Extension overrides applied BEFORE opentui's resolver.
 *
 *  Use case: opentui returns a filetype name we don't have a parser for,
 *  but a different parser we DO have can produce a usable approximation.
 *  Example: .vue files are <template> HTML + <script> JS + <style> CSS.
 *  We don't bundle a vue grammar, but routing to `html` highlights the
 *  template (the bulk of any .vue file) — script/style render plain.
 *  Better than fully colorless. */
const ZAP_FILETYPE_OVERRIDES: Record<string, string> = {
  vue: "html",
};

/** Extract filetype hint from path for tree-sitter syntax highlight.
 *
 *  Order: Zap-side overrides → `pathToFiletype` (canonical for 80+
 *  extensions and basenames like Makefile, Dockerfile) → raw lowercased
 *  extension fallback. Returning "" is fine — `<code>`/`<diff>` just
 *  render plain. */
export function filetypeFromPath(path: string): string {
  const ext = path.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext && ZAP_FILETYPE_OVERRIDES[ext]) return ZAP_FILETYPE_OVERRIDES[ext];
  const resolved = pathToFiletype(path);
  if (resolved) return resolved;
  return ext ?? "";
}

/**
 * Heuristic: does this blob look like UTF-8 text?
 *
 * Tests the first 8 KB for NUL bytes and any byte outside printable-ish ranges
 * that isn't a valid UTF-8 continuation. Returns false for typical binary
 * payloads (images, executables, archives) without false-flagging CJK text.
 */
export function isProbablyText(buf: Buffer | string): boolean {
  if (typeof buf === "string") return true;
  const sample = buf.subarray(0, 8192);
  // NUL byte is a reliable binary indicator
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return false;
  }
  // Count bytes outside common text ranges (printable ASCII, tab/LF/CR, and
  // high bytes that would be UTF-8 multibyte sequences)
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    const ok = b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 128;
    if (!ok) suspicious++;
  }
  return sample.length === 0 || suspicious / sample.length < 0.02;
}

/**
 * Build a DiffMeta for a write/edit operation.
 *
 * `oldText` / `newText` are already-decoded strings. Callers responsible for
 * reading the file and handling binary detection; this function is pure.
 */
export function buildDiffMeta(
  oldText: string,
  newText: string,
  filePath: string,
): DiffMeta {
  const oldBytes = Buffer.byteLength(oldText, "utf-8");
  const newBytes = Buffer.byteLength(newText, "utf-8");

  // Mark too_large so the UI shows "(diff suppressed — file too large)"
  // instead of an empty panel that looks like "nothing changed".
  if (oldText.length > DIFF_MAX_BYTES || newText.length > DIFF_MAX_BYTES) {
    return {
      diff: "",
      filetype: filetypeFromPath(filePath),
      oldBytes,
      newBytes,
      skipped: "too_large",
    };
  }

  return {
    diff: buildUnifiedDiff(oldText, newText, filePath || "file"),
    filetype: filetypeFromPath(filePath),
    oldBytes,
    newBytes,
  };
}
