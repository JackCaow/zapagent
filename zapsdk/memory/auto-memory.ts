import { readFile, stat } from "node:fs/promises";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { countCodePoints, normalizeLogicalNewlines, sliceHeadCodePoints, splitLogicalLines } from "../utils/logical-lines.js";
import { getAppDataDir } from "../utils/platform.js";
import { legacyProjectDataSegment, resolveProjectDataSegment } from "../utils/project-paths.js";
import { parseMdFile } from "./md-frontmatter.js";
import { mdMemoryAgeDays, resolveMdMemoryTimestamp } from "./md-types.js";
import { activeMdMemoryRecords } from "./md-lifecycle.js";
import { openMdStore, parseMdMemoryIndexLineFilename, type MdMemoryRecord } from "./md-store.js";

const MEMORY_LOCK_FILE = ".memory.lock";
const MEMORY_TEMP_FILE_RE = /^\..+\.tmp$/;

/** Per-project persistent memory system, stored under ~/.zapcode/projects/<id>/memory/ */
export class AutoMemory {
  /** Absolute path to this project's memory directory */
  readonly memoryDir: string;
  private readonly legacyMemoryDir: string;

  constructor(cwd: string) {
    const resolved = resolveMemoryDir(cwd);
    this.memoryDir = resolved.memoryDir;
    this.legacyMemoryDir = resolved.legacyMemoryDir;
  }

  /** Create memory directory and seed an empty MEMORY.md if missing.
   *  Seeding avoids ENOENT when the model probes MEMORY.md directly —
   *  an empty file is a cleaner "no memories yet" signal than a crash. */
  async ensure(): Promise<void> {
    this.ensureSync();
  }

  /** Synchronous counterpart used during singleton initialization before
   *  the global markdown store opens. Without this, openMdStore() can create
   *  the new git-backed memory directory first; an early /mem or memory_save
   *  write then makes legacy migration look unsafe and strands old memories. */
  ensureSync(): void {
    mkdirSync(this.memoryDir, { recursive: true });
    chmodSyncBestEffort(this.memoryDir, 0o700);
    migrateLegacyMemorySync(this.legacyMemoryDir, this.memoryDir);
    const indexPath = join(this.memoryDir, "MEMORY.md");
    if (existsSync(indexPath)) {
      chmodSyncBestEffort(indexPath, 0o600);
    } else {
      writeFileSync(indexPath, "", { encoding: "utf-8", mode: 0o600 });
      chmodSyncBestEffort(indexPath, 0o600);
    }
  }

  /**
   * Build the system prompt section for memory.
   *
   * Two modes:
   *   - includeContent=false (default): returns taxonomy-only. The MEMORY.md
   *     index comes out separately via buildContextAttachment() for injection
   *     as a per-turn user-context message — content-instruction separation
   *     (design reference: CCB's loadMemoryPrompt vs buildMemoryPrompt).
   *   - includeContent=true (legacy): returns taxonomy + MEMORY.md index
   *     inlined. Kept only for callers still doing the old one-shot
   *     inject-into-system-prompt flow; avoid it for cacheable prompts.
   */
  async buildSystemPromptSection(includeContent = false): Promise<string> {
    await this.ensure();
    if (!includeContent) return buildInstructionsOnly();
    const index = await readIndexSafe(this.memoryDir);
    return buildInstructions(this.memoryDir, index);
  }

  /**
   * Taxonomy-only instructions suitable for the cacheable system prompt.
   * Zero per-turn variation — the MEMORY.md index lives elsewhere.
   */
  async buildInstructions(): Promise<string> {
    await this.ensure();
    return buildInstructionsOnly();
  }

  /**
   * Per-turn user-context attachment: the current MEMORY.md index wrapped
   * so the model can tell it's system-injected context rather than user
   * input. Lifecycle-inactive topic records are removed before delivery.
   * Returns null when memory is empty (no attachment needed).
   *
   * The model is already instructed (via the taxonomy section in the
   * system prompt) how to interpret this; here we just deliver today's
   * data. Compatibility-only; current hosts use the query-ranked per-turn
   * attachment builder instead.
   */
  async buildContextAttachment(): Promise<string | null> {
    await this.ensure();
    const index = await readIndexSafe(this.memoryDir);
    if (!index.trim()) return null;
    return [
      "<system-context>",
      `Persistent memory (index from ${escapeContextText(join(this.memoryDir, "MEMORY.md"))}).`,
      "Read specific topic files with read_file when relevant. Do not quote this index verbatim in replies.",
      "",
      escapeContextText(index.trim()),
      "</system-context>",
    ].join("\n");
  }

  /** Returns true if the given (possibly relative) path is inside the memory directory */
  isMemoryPath(filePath: string): boolean {
    const rel = relative(resolve(this.memoryDir), resolve(filePath));
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  /** Returns a staleness note for a memory file, or empty string if fresh.
   *  Frontmatter timestamps are the semantic source of truth. Filesystem mtime
   *  remains a compatibility fallback for legacy records without timestamps. */
  async stalenessNote(filePath: string): Promise<string> {
    try {
      const [text, fileStat] = await Promise.all([
        readFile(filePath, "utf-8"),
        stat(filePath),
      ]);
      const parsed = parseMdFile(text);
      const resolution = parsed
        ? resolveMdMemoryTimestamp(parsed.frontmatter)
        : { kind: "missing" } as const;
      if (resolution.kind === "invalid") {
        return "\n\n[Memory timestamp metadata is invalid — age unknown; verify against current state]";
      }
      const timestamp = resolution.kind === "valid"
        ? resolution.timestamp
        : fileStat.mtimeMs;
      const ageDays = mdMemoryAgeDays(timestamp);
      if (ageDays < 1) return "";
      if (ageDays === 1) return "\n\n[Memory saved yesterday — verify if still accurate]";
      if (ageDays <= 7) return "\n\n[Memory from the last week — verify before relying on it]";
      if (ageDays <= 30) return "\n\n[Memory from the last month — likely still valid but worth checking]";
      return `\n\n[Memory from ${staleMemoryAgeLabel(ageDays)} — may be outdated, verify against current state]`;
    } catch {
      return "";
    }
  }
}

function staleMemoryAgeLabel(ageDays: number): string {
  if (ageDays < 90) return "more than 30 days ago";
  if (ageDays < 180) return "more than 90 days ago";
  if (ageDays < 365) return "more than 180 days ago";
  return "more than 1 year ago";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface MemoryDirResolution {
  memoryDir: string;
  legacyMemoryDir: string;
}

function resolveMemoryDir(cwd: string): MemoryDirResolution {
  const legacyMemoryDir = legacyCwdMemoryDir(cwd);
  const segment = resolveProjectDataSegment(cwd);
  if (segment === legacyProjectDataSegment(cwd)) {
    return { memoryDir: legacyMemoryDir, legacyMemoryDir };
  }
  return {
    memoryDir: join(getAppDataDir(), "projects", segment, "memory"),
    legacyMemoryDir,
  };
}

function legacyCwdMemoryDir(cwd: string): string {
  // Legacy path rule: flatten both separators and the Windows drive-letter
  // colon so Windows paths never create an illegal mid-path `C:` segment.
  return join(getAppDataDir(), "projects", legacyProjectDataSegment(cwd), "memory");
}

function migrateLegacyMemorySync(legacyDir: string, targetDir: string): void {
  if (legacyDir === targetDir) return;
  if (!hasMemoryContent(legacyDir) || hasMemoryContent(targetDir)) return;
  try {
    copyDirSync(legacyDir, targetDir);
  } catch {
    // Migration is best-effort. Failing open preserves the new directory path
    // and lets the agent continue with an empty memory store.
  }
}

function hasMemoryContent(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const st = statSync(path);
      if (st.isDirectory()) return true;
      if (!st.isFile()) continue;
      if (entry !== "MEMORY.md") return true;
      if (st.size > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function copyDirSync(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  chmodSyncBestEffort(target, 0o700);
  for (const entry of readdirSync(source)) {
    if (entry === MEMORY_LOCK_FILE || MEMORY_TEMP_FILE_RE.test(entry)) continue;
    const from = join(source, entry);
    const to = join(target, entry);
    const st = statSync(from);
    if (st.isDirectory()) {
      copyDirSync(from, to);
    } else if (st.isFile()) {
      copyFileSync(from, to);
      chmodSyncBestEffort(to, 0o600);
    }
  }
}

function chmodSyncBestEffort(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try { chmodSync(path, mode); } catch {}
}

function escapeContextText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readIndexSafe(memoryDir: string): Promise<string> {
  try {
    const content = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
    const normalized = filterInactiveMemoryIndexLines(
      memoryDir,
      normalizeLogicalNewlines(content),
    );
    // Cap at 200 lines / 25 KB
    const lines = splitLogicalLines(normalized);
    if (lines.length <= 200 && countCodePoints(normalized) <= 25_000) return normalized;
    const truncated = lines.slice(0, 200).join("\n");
    return sliceHeadCodePoints(truncated, 25_000) + "\n\n[MEMORY.md truncated — too large]";
  } catch {
    return "";
  }
}

function filterInactiveMemoryIndexLines(memoryDir: string, index: string): string {
  const lines = splitLogicalLines(index);
  let records: MdMemoryRecord[];
  try {
    records = openMdStore(memoryDir).list();
  } catch {
    records = [];
  }
  const active = new Set(activeMdMemoryRecords(records).map((record) => record.filename));
  const known = new Set(records.map((record) => record.filename));
  return lines.filter((line) => {
    const filename = parseMdMemoryIndexLineFilename(line);
    if (!filename) return true;
    if (known.has(filename)) return active.has(filename);
    // Preserve historical hand-authored index-only entries. If a referenced
    // topic file exists but could not be parsed, fail closed.
    return !existsSync(join(memoryDir, filename));
  }).join("\n");
}

function buildInstructions(memoryDir: string, indexContent: string): string {
  const lines: string[] = [];

  lines.push("# Persistent Memory");
  lines.push("");
  lines.push(`Your memory directory: ${memoryDir}`);
  lines.push(
    "This is your persistent, cross-session memory. " +
    "Use it to remember important things about the user, the project, and your own preferences."
  );

  lines.push("");
  lines.push("## Memory types");
  lines.push("");
  lines.push("- **user** — User's role, goals, expertise, preferences");
  lines.push("- **feedback** — How to approach work: corrections, conventions, what to avoid");
  lines.push("- **project** — Ongoing work, goals, bugs, decisions NOT derivable from code/git");
  lines.push("- **reference** — Pointers to external systems (dashboards, issue trackers, Slack)");
  appendScopeRules(lines);

  lines.push("");
  lines.push("## Admission policy");
  lines.push(
    "Save only information that is likely to remain useful across sessions and would materially change future work. " +
    "Prefer explicit user statements, verified tool results, accepted decisions, and stable external references.",
  );
  lines.push(
    "Do not promote speculation, transient progress, raw transcripts, or facts recoverable from a direct file read into high-confidence memory. " +
    "Use low confidence only for a candidate worth explicit review; low-confidence records are not recalled automatically.",
  );

  lines.push("");
  lines.push("## How to save a memory");
  lines.push("Use the `memory_save` tool whenever it is available. It writes the topic file, preserves metadata, and updates MEMORY.md atomically.");
  lines.push("Call it with:");
  lines.push("```");
  lines.push("type: <user|feedback|project|reference>");
  lines.push("name: <snake_case_or_kebab-case_identifier>");
  lines.push("description: <one-line relevance hook>");
  lines.push("tags: [optional relevance tags; use pinned only for always-eligible memories]");
  lines.push("source: <optional source note>");
  lines.push("confidence: <always declare: high for explicit/verified facts; medium when verification-sensitive; low for review-only candidates; omitted new saves default to medium>");
  lines.push("validFrom / expiresAt: <optional absolute ISO-8601 validity window>");
  lines.push("supersedes: [optional older same-scope, same-type memory names replaced by this high-confidence fact]");
  lines.push("content: <markdown body>");
  lines.push("```");
  lines.push(`Do not edit ${join(memoryDir, "MEMORY.md")} directly when ` + "`memory_save` is available; the markdown store owns the index.");
  lines.push("Update the same `name` when the identity is unchanged. Use `supersedes` when a newly named fact replaces an older auditable record.");
  lines.push("`memory_save` refuses duplicate bodies and logical-name conflicts across scopes. Inspect `/mem` before changing existing durable memory; routine work never deletes or moves records automatically.");
  appendMemoryBodySizeRules(lines);

  lines.push("");
  lines.push("## When to save");
  lines.push("- User corrects your approach or states a preference → **feedback**");
  lines.push("- You learn something about the user's role or expertise → **user**");
  lines.push("- Important project decision, deadline, or initiative → **project**");
  lines.push("- External system reference (URL, channel, tracker) → **reference**");

  lines.push("");
  lines.push("## When to access");
  lines.push("The current project MEMORY.md (below) is loaded here. Any global personal memory index is delivered separately as per-turn context.");
  lines.push("Read specific topic files with read_file when relevant.");
  lines.push("Convert relative dates to absolute when saving; use the current date from the dynamic environment context.");

  if (indexContent.trim()) {
    lines.push("");
    lines.push("## MEMORY.md (current index)");
    lines.push("");
    lines.push(indexContent);
  } else {
    lines.push("");
    lines.push("## MEMORY.md");
    lines.push("(empty — no memories saved yet)");
  }

  return lines.join("\n");
}

/**
 * Taxonomy / how-to-save / when-to-save — everything the model needs to
 * understand the memory system, with NO MEMORY.md content. The index
 * travels separately via buildContextAttachment().
 *
 * Stable across turns and across sessions (only changes when the memory
 * directory itself changes) — safe to place in the cacheable system
 * prefix.
 */
function buildInstructionsOnly(): string {
  const lines: string[] = [];

  lines.push("# Persistent Memory");
  lines.push("");
  lines.push(
    "This is your persistent, cross-session memory. " +
    "Use it to remember important things about the user, the project, and your own preferences."
  );
  lines.push(
    "A compact, query-ranked MEMORY.md index is delivered for each available " +
    "memory scope each turn as a <system-context> message in the user-visible " +
    "history. Consult it there; do not expect the full index inside this section."
  );

  lines.push("");
  lines.push("## Memory types");
  lines.push("");
  lines.push("- **user** — User's role, goals, expertise, preferences");
  lines.push("- **feedback** — How to approach work: corrections, conventions, what to avoid");
  lines.push("- **project** — Ongoing work, goals, bugs, decisions NOT derivable from code/git");
  lines.push("- **reference** — Pointers to external systems (dashboards, issue trackers, Slack)");
  appendScopeRules(lines);

  lines.push("");
  lines.push("## Admission policy");
  lines.push(
    "Save only information that is likely to remain useful across sessions and would materially change future work. " +
    "Prefer explicit user statements, verified tool results, accepted decisions, and stable external references.",
  );
  lines.push(
    "Do not promote speculation, transient progress, raw transcripts, or facts recoverable from a direct file read into high-confidence memory. " +
    "Use low confidence only for a candidate worth explicit review; low-confidence records are not recalled automatically.",
  );

  lines.push("");
  lines.push("## How to save a memory");
  lines.push("Use the `memory_save` tool whenever it is available. It writes the topic file, preserves metadata, and updates MEMORY.md atomically.");
  lines.push("Call it with:");
  lines.push("```");
  lines.push("type: <user|feedback|project|reference>");
  lines.push("name: <snake_case_or_kebab-case_identifier>");
  lines.push("description: <one-line relevance hook>");
  lines.push("tags: [optional relevance tags; use pinned only for always-eligible memories]");
  lines.push("source: <optional source note>");
  lines.push("confidence: <always declare: high for explicit/verified facts; medium when verification-sensitive; low for review-only candidates; omitted new saves default to medium>");
  lines.push("validFrom / expiresAt: <optional absolute ISO-8601 validity window>");
  lines.push("supersedes: [optional older same-scope, same-type memory names replaced by this high-confidence fact]");
  lines.push("content: <markdown body>");
  lines.push("```");
  lines.push("Do not edit MEMORY.md directly when `memory_save` is available; the markdown store owns the index.");
  lines.push("Update the same `name` when the identity is unchanged. Use `supersedes` when a newly named fact replaces an older auditable record.");
  lines.push("`memory_save` refuses duplicate bodies and logical-name conflicts across scopes. Inspect `/mem` before changing existing durable memory; routine work never deletes or moves records automatically.");
  appendMemoryBodySizeRules(lines);

  lines.push("");
  lines.push("## When to save");
  lines.push("- User corrects your approach or states a preference → **feedback**");
  lines.push("- You learn something about the user's role or expertise → **user**");
  lines.push("- Important project decision, deadline, or initiative → **project**");
  lines.push("- External system reference (URL, channel, tracker) → **reference**");
  lines.push("- Convert relative dates to absolute when saving (e.g., \"Thursday\" → actual date).");

  return lines.join("\n");
}

function appendMemoryBodySizeRules(lines: string[]): void {
  lines.push(
    "Keep memory bodies concise and durable. Do not save long pasted text, full transcripts, or large tool output verbatim; " +
    "summarize the reusable facts and store a reference pointer when the raw artifact matters. " +
    "`memory_save` rejects content over 24,000 characters.",
  );
  lines.push("Never save credentials. Credential-like values in memory metadata or content are redacted before storage, and credential-like memory names are rejected.");
}

function appendScopeRules(lines: string[]): void {
  lines.push("");
  lines.push("## Memory scopes");
  lines.push("- **user** and **feedback** are global personal memories: they may apply across projects.");
  lines.push("- **project** and **reference** are current-project memories: use them for repository-specific facts, decisions, tasks, links, and external resources.");
  lines.push("- Never save repository-specific implementation details, deadlines, or tracker links as **user** or **feedback** just to make them easier to recall.");
}
