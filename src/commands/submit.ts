import { existsSync, readFileSync, statSync } from "node:fs"
import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"
import type { MCPManager } from "../../zapsdk/index.js"

type AddLog = (
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  images?: UserImageRef[],
  agentPath?: string[],
  extra?: Partial<LogEntry>,
) => void

/** Below this, files are inlined verbatim — same shape as Claude Code's
 *  small-file path. ~8k tokens at 4 chars/token, leaves plenty of headroom
 *  for the @-reference to fit alongside other prompt content. */
const INLINE_FULL_MAX = 32 * 1024
/** Above INLINE_FULL_MAX, truncate to this many lines before inlining and
 *  add a hint pointing the model at the read_file tool for the rest. 500
 *  lines ≈ enough to grok structure of most files (imports + top-level
 *  symbols + a few function bodies). */
const INLINE_TRUNCATED_LINES = 500
/** Hard floor — anything bigger than this rejects entirely because a
 *  multi-MB blob will eat the disk-read I/O cost and stress the readFileSync
 *  call before we can even truncate sensibly. The user should be calling
 *  read_file directly for files this size, not @-mentioning them. */
const INLINE_HARD_MAX = 5 * 1024 * 1024

/**
 * Resolve `@path` file references in user input into `<file_content>` blocks.
 *
 * Scans the UNEXPANDED `value` so paste-folded blocks (still `[Pasted #N]`
 * placeholders) can't trip false matches for `@something` text that lives
 * inside pasted code/comments. The lazy `\S+?` + lookahead pattern strips
 * trailing punctuation (`,.;:!?`) so `@src/App.tsx, what's wrong?` resolves
 * correctly.
 *
 * Three tiers, mirroring Claude Code's @-mention behaviour:
 *   - small (≤ INLINE_FULL_MAX): inline whole file
 *   - medium: inline first INLINE_TRUNCATED_LINES lines + hint
 *   - huge (> INLINE_HARD_MAX): block submit, point at read_file tool
 *
 * Validation runs BEFORE pushHistory so a typo'd path doesn't pollute
 * history.jsonl. Returns null on the first hard-fail (missing / read
 * error / above the hard cap).
 */
export function resolveAtPathReferences(
  value: string,
  addLog: AddLog,
): string[] | null {
  const fileBlocks: string[] = []
  if (!value.includes("@")) return fileBlocks
  for (const { path: refPath } of extractAtPathReferences(value)) {
    if (!existsSync(refPath)) {
      addLog("error", `File not found: ${refPath}`)
      return null
    }
    let fileBytes: number
    try {
      fileBytes = statSync(refPath).size
    } catch (e) {
      addLog(
        "error",
        `Read failed: ${refPath} — ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
    // Hard cap: refuse to load multi-MB files into a single user message.
    // Check the filesystem size before reading so an accidental @large-file
    // cannot synchronously pull the whole blob into the TUI process.
    if (fileBytes > INLINE_HARD_MAX) {
      addLog(
        "error",
        `File too large to @-mention: ${refPath} (${(fileBytes / 1024 / 1024).toFixed(1)} MB). ` +
        `Drop the @-ref and ask the agent to read the file directly with the read_file tool.`,
      )
      return null
    }

    let content: string
    try {
      content = readFileSync(refPath, "utf-8")
    } catch (e) {
      addLog(
        "error",
        `Read failed: ${refPath} — ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
    if (content.length <= INLINE_FULL_MAX) {
      // Small file: inline whole content (legacy behaviour for the
      // common case of small config / test / fixture files).
      fileBlocks.push(renderFileContentBlock(refPath, content))
      continue
    }
    // Medium / large: truncate at line boundary + add a hint so the
    // model knows it CAN reach for read_file if it needs the tail.
    const lines = content.split("\n")
    const totalLines = lines.length
    const kept = lines.slice(0, INLINE_TRUNCATED_LINES).join("\n")
    const sizeNote = `${(fileBytes / 1024).toFixed(0)} KB`
    const lineNote = totalLines > INLINE_TRUNCATED_LINES
      ? `${INLINE_TRUNCATED_LINES} of ${totalLines} lines`
      : `${(kept.length / 1024).toFixed(0)} KB of ${sizeNote}`
    const hint = `[file truncated — showing ${lineNote}. Use the read_file tool with offset+limit to read more of this file.]`
    fileBlocks.push(renderFileContentBlock(refPath, `${kept}\n${hint}`))
    // Log it so the user knows their @ got truncated rather than full-
    // inlined. Surfaces as a system row in the transcript pre-submit.
    addLog(
      "system",
      `ℹ @${refPath} truncated to first ${INLINE_TRUNCATED_LINES} lines (${sizeNote} total). Agent can read the rest via the read_file tool.`,
    )
  }
  return fileBlocks
}

interface AtPathReference {
  path: string
  quoted: boolean
}

function extractAtPathReferences(value: string): AtPathReference[] {
  const refs: AtPathReference[] = []
  const seen = new Set<string>()
  const re = /(?:^|\s)@(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+?))(?=[.,;:!?]?(?:\s|$))/g
  for (const m of value.matchAll(re)) {
    const quotedRaw = m[1] ?? m[2]
    const raw = quotedRaw ?? m[3]
    if (!raw) continue
    const quoted = quotedRaw !== undefined
    const path = quoted ? unescapeAtPath(raw) : raw
    // Let MCP resource resolution handle @server:uri. Quote a local path
    // containing ":" if it should be treated as a filesystem reference.
    if (!quoted && /^[A-Za-z0-9_-]+:/.test(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    refs.push({ path, quoted })
  }
  return refs
}

function unescapeAtPath(path: string): string {
  return path.replace(/\\(["'\\])/g, "$1")
}

export interface SubmittedTextParts {
  /** Normalized control/display value used for command routing and history. */
  value: string
  /** What the transcript should show for the submitted user row. */
  displayForm: string
  /** Placeholder-expanded model input. Preserves pasted text verbatim. */
  modelInput: string
}

/**
 * Split submit-time text into the UI/control form and the model-facing form.
 *
 * The input box often contains compact placeholders such as
 * `[Pasted #1 · ...]`. The transcript and history should keep that compact
 * display, but the model must receive the expanded paste exactly as stored.
 * Do not trim after expansion: leading/trailing whitespace can be meaningful
 * in copied code, config files, heredocs, Markdown, and expected-output text.
 */
export function buildSubmittedTextParts(
  rawValue: string,
  expandPastes: (input: string) => string,
): SubmittedTextParts {
  const value = rawValue.replace(/^\s+|\s+$/g, "")
  return {
    value,
    displayForm: value.trim(),
    modelInput: expandPastes(rawValue),
  }
}

/** Compose the final model-facing text from user input + resolved
 *  @path file blocks. Strips `[Image #N]` placeholders (visual markers only;
 *  images flow as ImageContent[] alongside), while preserving the user's
 *  newlines and spacing so pasted code/config remains intact.
 *
 *  The user's `@path` mentions stay in `text` as-is — modern Claude models
 *  match them to the appended <file_content> blocks without needing an
 *  explicit "see below" marker. */
export interface BuildModelTextOptions {
  /** Defaults to stripping all canonical image placeholders for legacy callers.
   *  Submit-time code should strip concrete pending-image ids before expanding
   *  paste placeholders, then pass false so literal "[Image #N]" text inside
   *  pasted content is preserved. */
  stripImagePlaceholders?: boolean | Iterable<number>
}

const IMAGE_PLACEHOLDER_RE = /\[Image #([1-9]\d*)\]/g

export function stripImagePlaceholders(
  input: string,
  placeholders: boolean | Iterable<number> = true,
): string {
  if (placeholders === false) return input
  const ids = placeholders === true
    ? null
    : new Set([...placeholders].filter((id) => Number.isSafeInteger(id) && id > 0))
  if (ids && ids.size === 0) return input
  return input.replace(IMAGE_PLACEHOLDER_RE, (match, id) =>
    ids === null || ids.has(Number(id)) ? "" : match)
}

export function buildModelText(
  input: string,
  fileBlocks: string[],
  options: BuildModelTextOptions = {},
): string {
  const text = stripImagePlaceholders(input, options.stripImagePlaceholders ?? true)
  if (fileBlocks.length === 0) return text
  return text ? `${text}\n\n${fileBlocks.join("\n\n")}` : fileBlocks.join("\n\n")
}

// ── MCP @-reference resolution ──────────────────────────────────────────

const MCP_REF_MAX = 256 * 1024;
const MCP_REF_RE = /(?:^|\s)@([A-Za-z0-9_-]+):([^\s]+?)(?=[.,;:!?]?(?:\s|$))/g;
const PASTED_PLACEHOLDER_AT_START_RE = /^\[Pasted #[1-9]\d* · \d+ lines · \d+ chars\]/;

/**
 * Detect MCP resource references of the form `@<server>:<uri>` in user
 * input and fetch their contents inline. Returns an array of XML-wrapped
 * blocks the caller appends to the user message (same shape as the
 * `<file_content>` blocks produced by resolveAtPathReferences).
 *
 * Returns null on any unrecoverable error (server unknown / read failed /
 * content too large) — caller aborts submit and the user can fix it.
 *
 * Distinguishing `@server:uri` from a bare `@path` is done by requiring a
 * colon AND a matching registered MCP server name. `@src/App.tsx` keeps
 * working as a plain file ref because no server is named "src" (and the
 * file resolver runs against the same input).
 */
export async function resolveMCPReferences(
  value: string,
  manager: MCPManager | null,
  addLog: AddLog,
): Promise<string[] | null> {
  if (!manager || !value.includes("@")) return [];

  // Limit to active servers' names so plain `@something:foo` (where
  // "something" is not an MCP server) falls through to other resolvers.
  const known = new Set(manager.snapshots().filter((s) => s.status === "ready").map((s) => s.name));
  if (known.size === 0) return [];

  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const m of value.matchAll(MCP_REF_RE)) {
    const server = m[1];
    const uri = m[2];
    if (!server || !uri || !known.has(server)) continue;
    const key = `${server}::${uri}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let contents;
    try {
      contents = await manager.readResource(server, uri);
    } catch (err) {
      addLog(
        "error",
        `MCP resource read failed: @${server}:${uri} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    for (const c of contents) {
      const inline = c.text ?? (c.blob ? `[binary ${c.mimeType ?? "application/octet-stream"} omitted]` : "");
      if (inline.length > MCP_REF_MAX) {
        addLog(
          "error",
          `MCP resource too large: @${server}:${uri} (${(inline.length / 1024).toFixed(0)} KB, max ${MCP_REF_MAX / 1024} KB)`,
        );
        return null;
      }
      const attrs = `server="${escapeXmlAttr(server)}" uri="${escapeXmlAttr(c.uri)}"${
        c.mimeType ? ` mimeType="${escapeXmlAttr(c.mimeType)}"` : ""
      }`;
      blocks.push(`<mcp_resource ${attrs}>\n${escapeXmlText(inline)}\n</mcp_resource>`);
    }
  }
  return blocks;
}

// ── MCP slash-prompt dispatch ───────────────────────────────────────────

const MCP_PROMPT_RE = /^\/mcp\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)(?:\s+(.*))?$/s;

export interface MCPPromptInvocation {
  server: string;
  name: string;
  args: Record<string, string>;
}

/** Parse `/mcp.<server>.<prompt> k1=v1 k2="hello world"` into a structured
 *  invocation. Returns null if the input isn't an MCP prompt command. */
export function parseMCPPromptInvocation(input: string): MCPPromptInvocation | null {
  const m = MCP_PROMPT_RE.exec(input.trim());
  if (!m) return null;
  const [, server, name, rest] = m;
  const args = rest ? parseMCPPromptArgs(rest) : {};
  return { server: server!, name: name!, args };
}

function parseMCPPromptArgs(rest: string): Record<string, string> {
  const args: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest.slice(i));
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[0]!;
    i += key.length;
    if (rest[i] !== "=") continue;
    i++;
    const parsed = parseMCPPromptArgValue(rest, i);
    args[key] = parsed.value;
    i = parsed.next;
  }
  return args;
}

function parseMCPPromptArgValue(rest: string, start: number): { value: string; next: number } {
  const quote = rest[start];
  if (quote === '"' || quote === "'") {
    let value = "";
    let i = start + 1;
    while (i < rest.length) {
      const ch = rest[i]!;
      if (ch === "\\") {
        const next = rest[i + 1];
        if (next === quote || next === "\\") {
          value += next;
          i += 2;
          continue;
        }
        value += ch;
        i++;
        continue;
      }
      if (ch === quote) return { value, next: i + 1 };
      value += ch;
      i++;
    }
    return { value, next: i };
  }

  let value = "";
  let i = start;
  while (i < rest.length) {
    const pastedPlaceholder = PASTED_PLACEHOLDER_AT_START_RE.exec(rest.slice(i))?.[0];
    if (pastedPlaceholder) {
      value += pastedPlaceholder;
      i += pastedPlaceholder.length;
      continue;
    }
    const ch = rest[i]!;
    if (/\s/.test(ch)) break;
    value += ch;
    i++;
  }
  return { value, next: i };
}

/** Drag-drop image: terminal types the file path char-by-char into stdin
 *  (no paste protocol), so it lands in inputValue. Strip drag-drop shell
 *  escapes + surrounding quotes; caller decides whether the result is a
 *  supported image to attach. */
export function stripDropPathQuoting(trimmed: string): string {
  return trimmed
    .replace(/\\ /g, " ")
    .replace(/^['"]|['"]$/g, "")
    .trim()
}

/** Decide whether an input that starts with `/` is actually a slash command
 *  vs a drag-dropped absolute path (e.g. /Users/foo/bar.png). A real slash
 *  command is a single lowercase token like "/help" — anything that contains
 *  a SECOND slash before the first whitespace is almost certainly a file
 *  path, so route it as plain user text. */
export function looksLikeDroppedFilePath(input: string): boolean {
  if (!input.startsWith("/")) return false
  const head = input.split(/\s/, 1)[0] ?? ""
  return head.indexOf("/", 1) >= 0
}

function renderFileContentBlock(path: string, content: string): string {
  return `<file_content path="${escapeXmlAttr(path)}">\n${escapeXmlText(content)}\n</file_content>`
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value.replace(/\s+/g, " ").trim()).replace(/"/g, "&quot;")
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
