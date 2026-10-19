/**
 * Compact → memory persistence.
 *
 * When a compact pass runs, the LLM-generated summary follows the
 * `STRUCTURED_COMPACT_PROMPT` structured section layout. The summary itself goes
 * back into the conversation as a single assistant turn — when the next
 * compact runs, that summary gets summarized again (compact-of-compact
 * decay).
 *
 * To survive that decay, extract the durable sections (intent, verbatim user
 * messages, status, facts, decisions, errors, code changes, next steps,
 * files/commands) and write them to project-typed memory files under the
 * AutoMemory dir.
 * `project_compact_state.md` is overwritten on each compact so it always
 * reflects the latest snapshot. `project_compact_timeline.md` keeps a
 * bounded recent history so multi-stage decisions do not disappear from
 * memory after the next compact.
 *
 * This is a best-effort persistence: if parsing fails, if the LLM
 * skipped a section, or if the disk write fails, we silently no-op
 * rather than block the compact path.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeCompactHeadingTitle } from "../context/autocompact.js";
import { countCodePoints, normalizeLogicalNewlines, sliceHeadCodePoints, sliceTailCodePoints, splitLogicalLines } from "../utils/logical-lines.js";
import { redactTextSecrets } from "../utils/redact.js";
import type { AutoMemory } from "./auto-memory.js";
import { openMdStore, type MdMemoryRecord } from "./md-store.js";

const MEMORY_NAME = "project_compact_state";
const TIMELINE_MEMORY_NAME = "project_compact_timeline";
const MEMORY_FILENAME = `${MEMORY_NAME}.md`;
const TIMELINE_MEMORY_FILENAME = `${TIMELINE_MEMORY_NAME}.md`;
const MAX_TIMELINE_SNAPSHOTS = 8;
const TIMELINE_ENTRY_START = "<!-- zap-compact-snapshot:start -->";
const TIMELINE_ENTRY_END = "<!-- zap-compact-snapshot:end -->";
const STATE_FINGERPRINT_RE = /<!-- zap-compact-state:fingerprint ([a-f0-9]{64}) -->/;
const TIMELINE_FINGERPRINT_RE = /<!-- zap-compact-snapshot:fingerprint ([a-f0-9]{64}) -->/;
const MAX_DURABLE_SECTION_LINES = 120;
const DURABLE_SECTION_HEAD_LINES = 80;
const DURABLE_SECTION_TAIL_LINES = 30;
const MAX_DURABLE_SECTION_CHARS = 24_000;
const DURABLE_SECTION_HEAD_CHARS = 12_000;
const DURABLE_SECTION_TAIL_CHARS = 6_000;
// Leave room for stable headings, fingerprints, and fold notices so the
// rendered state and one timeline entry stay below roughly 64k characters.
const MAX_DURABLE_AGGREGATE_SECTION_CHARS = 60_000;

interface ExtractedCompactSections {
  intent: string | null;
  userMessages: string | null;
  status: string | null;
  facts: string | null;
  decisions: string | null;
  errors: string | null;
  codeChanges: string | null;
  nextSteps: string | null;
  files: string | null;
  commands: string | null;
}

const AGGREGATE_OVERFLOW_SECTION_LIMITS: Record<keyof ExtractedCompactSections, number> = {
  intent: 8_000,
  userMessages: 8_000,
  status: 8_000,
  facts: 6_000,
  decisions: 6_000,
  errors: 5_000,
  codeChanges: 6_000,
  nextSteps: 6_000,
  files: 3_500,
  commands: 3_500,
};

export interface CompactSummaryPersistenceDiagnosticsLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Parse a compact summary and write durable sections to memory. Returns
 * the memory path on success, null on no-op (nothing extractable or write
 * failed).
 */
export async function persistCompactSummary(
  summary: string,
  autoMemory: AutoMemory,
  diagnosticsLogger?: CompactSummaryPersistenceDiagnosticsLogger,
): Promise<string | null> {
  const safeSummary = redactTextSecrets(summary);
  const sections = foldDurableCompactSections({
    intent: extractSection(safeSummary, "Primary Request and Intent"),
    userMessages: extractSection(safeSummary, "All user messages (verbatim)"),
    status: extractSection(safeSummary, "Current task status"),
    facts: extractSection(safeSummary, "Key facts discovered"),
    decisions: extractSection(safeSummary, "Decisions made"),
    errors: extractSection(safeSummary, "Errors encountered and their resolution"),
    codeChanges: extractSection(safeSummary, "Code changes summary"),
    nextSteps: extractSection(safeSummary, "Next steps"),
    files: extractSection(safeSummary, "Files read / modified"),
    commands: extractSection(safeSummary, "Commands run"),
  });
  const { intent, userMessages, status, facts, decisions, errors, codeChanges, nextSteps, files, commands } = sections;

  if (!intent && !userMessages && !status && !facts && !decisions && !errors && !codeChanges && !nextSteps && !files && !commands) return null;

  const updatedAt = new Date().toISOString();
  try {
    (autoMemory as { ensureSync?: () => void }).ensureSync?.();
    const store = openMdStore(autoMemory.memoryDir);
    const fingerprint = compactSectionsFingerprint(sections);
    const existing = store.get(MEMORY_FILENAME);
    if (existing && stateFingerprint(existing.body) === fingerprint) {
      if (compactTimelineNeedsRepair(store.get(TIMELINE_MEMORY_FILENAME), fingerprint)) {
        persistCompactTimelineBestEffort(store, sections, updatedAt, fingerprint, diagnosticsLogger);
      }
      return join(autoMemory.memoryDir, existing.filename);
    }
    const body = renderCompactStateBody(sections, updatedAt, fingerprint);
    const rec = store.save({
      name: MEMORY_NAME,
      description: "Durable snapshot from the most recent compact pass — intent, user messages, status, facts, decisions, next steps, files, commands.",
      type: "project",
      tags: ["compact", "summary", "files", "status", "pinned"],
      source: "compact summary",
      lifecycle: { confidence: "medium" },
      provenance: { origin: "compact_summary" },
      body,
    });
    persistCompactTimelineBestEffort(store, sections, updatedAt, fingerprint, diagnosticsLogger);
    return join(autoMemory.memoryDir, rec.filename);
  } catch (err) {
    logCompactSummaryPersistenceFailure(diagnosticsLogger, err);
    return null;
  }
}

function compactTimelineNeedsRepair(
  timeline: MdMemoryRecord | undefined,
  latestFingerprint: string,
): boolean {
  if (!timeline) return true;
  const entries = extractTimelineEntries(timeline.body);
  if (entries.length === 0) return true;
  return !entries.some((entry) => timelineEntryFingerprint(entry) === latestFingerprint);
}

function logCompactSummaryPersistenceFailure(
  diagnosticsLogger: CompactSummaryPersistenceDiagnosticsLogger | undefined,
  err: unknown,
): void {
  if (!diagnosticsLogger) return;
  try {
    diagnosticsLogger.warn("memory_operation_failed", {
      operation: "compact_summary",
      error: err instanceof Error ? err.message : String(err),
    });
  } catch {
    // Diagnostics must never block compact recovery.
  }
}

function renderCompactStateBody(
  sections: ExtractedCompactSections,
  updatedAt: string,
  fingerprint: string,
): string {
  return [
    `Snapshot from compact at ${updatedAt}. Each compact overwrites this file with the latest extracted sections. Recent older snapshots live in project_compact_timeline.md and full history remains in the session JSONL.`,
    `<!-- zap-compact-state:fingerprint ${fingerprint} -->`,
    "",
    "## Primary request and intent",
    sections.intent || "_(none captured)_",
    "",
    "## User messages",
    sections.userMessages || "_(none captured)_",
    "",
    "## Current task status",
    sections.status || "_(none captured)_",
    "",
    "## Key facts discovered",
    sections.facts || "_(none captured)_",
    "",
    "## Decisions made",
    sections.decisions || "_(none captured in the latest summary)_",
    "",
    "## Errors encountered and resolution",
    sections.errors || "_(none captured)_",
    "",
    "## Code changes summary",
    sections.codeChanges || "_(none captured)_",
    "",
    "## Next steps",
    sections.nextSteps || "_(none captured)_",
    "",
    "## Files read / modified",
    sections.files || "_(none captured)_",
    "",
    "## Commands run",
    sections.commands || "_(none captured)_",
    "",
  ].join("\n");
}

function stateFingerprint(body: string): string | null {
  return STATE_FINGERPRINT_RE.exec(body)?.[1] ?? null;
}

function compactSectionsFingerprint(sections: ExtractedCompactSections): string {
  return createHash("sha256")
    .update(JSON.stringify({
      intent: sections.intent ?? "",
      userMessages: sections.userMessages ?? "",
      status: sections.status ?? "",
      facts: sections.facts ?? "",
      decisions: sections.decisions ?? "",
      errors: sections.errors ?? "",
      codeChanges: sections.codeChanges ?? "",
      nextSteps: sections.nextSteps ?? "",
      files: sections.files ?? "",
      commands: sections.commands ?? "",
    }))
    .digest("hex");
}

function foldDurableCompactSections(sections: ExtractedCompactSections): ExtractedCompactSections {
  const folded = foldDurableCompactSectionsWithLimits(sections);
  if (durableCompactSectionChars(folded) <= MAX_DURABLE_AGGREGATE_SECTION_CHARS) {
    return folded;
  }
  return foldDurableCompactSectionsWithLimits(sections, AGGREGATE_OVERFLOW_SECTION_LIMITS);
}

function foldDurableCompactSectionsWithLimits(
  sections: ExtractedCompactSections,
  limits?: Record<keyof ExtractedCompactSections, number>,
): ExtractedCompactSections {
  return {
    intent: foldDurableCompactSection(sections.intent, limits?.intent),
    userMessages: foldDurableCompactSection(sections.userMessages, limits?.userMessages),
    status: foldDurableCompactSection(sections.status, limits?.status),
    facts: foldDurableCompactSection(sections.facts, limits?.facts),
    decisions: foldDurableCompactSection(sections.decisions, limits?.decisions),
    errors: foldDurableCompactSection(sections.errors, limits?.errors),
    codeChanges: foldDurableCompactSection(sections.codeChanges, limits?.codeChanges),
    nextSteps: foldDurableCompactSection(sections.nextSteps, limits?.nextSteps),
    files: foldDurableCompactSection(sections.files, limits?.files),
    commands: foldDurableCompactSection(sections.commands, limits?.commands),
  };
}

function durableCompactSectionChars(sections: ExtractedCompactSections): number {
  return Object.values(sections).reduce(
    (total, section) => total + countCodePoints(section ?? ""),
    0,
  );
}

function foldDurableCompactSection(
  section: string | null,
  maxChars = MAX_DURABLE_SECTION_CHARS,
): string | null {
  if (!section) return section;
  const normalized = normalizeLogicalNewlines(section);
  const lines = splitLogicalLines(normalized);
  if (lines.length > MAX_DURABLE_SECTION_LINES) {
    const head = lines.slice(0, DURABLE_SECTION_HEAD_LINES);
    const tail = lines.slice(-DURABLE_SECTION_TAIL_LINES);
    const omitted = lines.length - head.length - tail.length;
    const folded = [
      durableSectionFoldNotice(`${omitted} lines`, `${lines.length} lines`),
      ...head,
      durableSectionFoldGap(`${omitted} lines`),
      ...tail,
    ].join("\n");
    return countCodePoints(folded) <= maxChars
      ? folded
      : foldDurableCompactSectionByChars(normalized, maxChars);
  }
  if (countCodePoints(normalized) > maxChars) {
    return foldDurableCompactSectionByChars(normalized, maxChars);
  }
  return normalized;
}

function foldDurableCompactSectionByChars(
  section: string,
  maxChars = MAX_DURABLE_SECTION_CHARS,
): string {
  const scale = maxChars / MAX_DURABLE_SECTION_CHARS;
  const head = sliceHeadCodePoints(section, Math.max(1, Math.floor(DURABLE_SECTION_HEAD_CHARS * scale)));
  const tail = sliceTailCodePoints(section, Math.max(1, Math.floor(DURABLE_SECTION_TAIL_CHARS * scale)));
  return [
    durableSectionCharFoldNotice(),
    head,
    durableSectionCharFoldGap(),
    tail,
  ].join("\n");
}

function durableSectionFoldNotice(omitted: string, total: string): string {
  return `[... durable compact memory folded: ${omitted} omitted; full ${total} remains in the session JSONL ...]`;
}

function durableSectionFoldGap(omitted: string): string {
  return `[... ${omitted} omitted from durable compact memory ...]`;
}

function durableSectionCharFoldNotice(): string {
  return "[... durable compact memory folded by chars; full section remains in the session JSONL ...]";
}

function durableSectionCharFoldGap(): string {
  return "[... middle chars omitted from durable compact memory ...]";
}

function persistCompactTimelineBestEffort(
  store: ReturnType<typeof openMdStore>,
  sections: ExtractedCompactSections,
  updatedAt: string,
  fingerprint: string,
  diagnosticsLogger: CompactSummaryPersistenceDiagnosticsLogger | undefined,
): void {
  try {
    const existing = store.get(`${TIMELINE_MEMORY_NAME}.md`);
    const existingEntries = extractTimelineEntries(existing?.body ?? "")
      .filter((entry) => timelineEntryFingerprint(entry) !== fingerprint);
    const entries = [
      renderTimelineEntry(sections, updatedAt, fingerprint),
      ...existingEntries,
    ].slice(0, MAX_TIMELINE_SNAPSHOTS);
    store.save({
      name: TIMELINE_MEMORY_NAME,
      description: "Bounded recent compact history for recovering multi-stage task decisions.",
      type: "project",
      tags: ["compact", "summary", "history", "status", "pinned"],
      source: "compact summary",
      lifecycle: { confidence: "medium" },
      provenance: { origin: "compact_summary" },
      body: [
        `Recent compact snapshots, newest first. Kept to the latest ${MAX_TIMELINE_SNAPSHOTS} entries so memory recall stays bounded.`,
        "",
        entries.join("\n\n"),
        "",
      ].join("\n"),
    });
  } catch (err) {
    logCompactSummaryPersistenceFailure(diagnosticsLogger, err);
  }
}

function renderTimelineEntry(sections: ExtractedCompactSections, updatedAt: string, fingerprint: string): string {
  return [
    TIMELINE_ENTRY_START,
    `## Snapshot ${updatedAt}`,
    `<!-- zap-compact-snapshot:fingerprint ${fingerprint} -->`,
    "",
    "### Primary request and intent",
    sections.intent || "_(none captured)_",
    "",
    "### User messages",
    sections.userMessages || "_(none captured)_",
    "",
    "### Current task status",
    sections.status || "_(none captured)_",
    "",
    "### Key facts discovered",
    sections.facts || "_(none captured)_",
    "",
    "### Decisions made",
    sections.decisions || "_(none captured)_",
    "",
    "### Errors encountered and resolution",
    sections.errors || "_(none captured)_",
    "",
    "### Code changes summary",
    sections.codeChanges || "_(none captured)_",
    "",
    "### Next steps",
    sections.nextSteps || "_(none captured)_",
    "",
    "### Files read / modified",
    sections.files || "_(none captured)_",
    "",
    "### Commands run",
    sections.commands || "_(none captured)_",
    TIMELINE_ENTRY_END,
  ].join("\n");
}

function extractTimelineEntries(body: string): string[] {
  const entries: string[] = [];
  const re = new RegExp(
    `${escapeRegExp(TIMELINE_ENTRY_START)}[\\s\\S]*?${escapeRegExp(TIMELINE_ENTRY_END)}`,
    "g",
  );
  for (const match of body.matchAll(re)) {
    const entry = match[0]?.trim();
    if (entry) entries.push(entry);
  }
  return entries;
}

function timelineEntryFingerprint(entry: string): string | null {
  const explicit = TIMELINE_FINGERPRINT_RE.exec(entry)?.[1];
  if (explicit) return explicit;
  const normalizedEntry = splitLogicalLines(entry)
    .filter((line) =>
      line.trim() !== TIMELINE_ENTRY_START &&
      line.trim() !== TIMELINE_ENTRY_END &&
      !TIMELINE_FINGERPRINT_RE.test(line)
    )
    .join("\n");
  const sections: ExtractedCompactSections = {
    intent: extractSection(normalizedEntry, "Primary Request and Intent"),
    userMessages: extractSection(normalizedEntry, "All user messages (verbatim)"),
    status: extractSection(normalizedEntry, "Current task status"),
    facts: extractSection(normalizedEntry, "Key facts discovered"),
    decisions: extractSection(normalizedEntry, "Decisions made"),
    errors: extractSection(normalizedEntry, "Errors encountered and their resolution"),
    codeChanges: extractSection(normalizedEntry, "Code changes summary"),
    nextSteps: extractSection(normalizedEntry, "Next steps"),
    files: extractSection(normalizedEntry, "Files read / modified"),
    commands: extractSection(normalizedEntry, "Commands run"),
  };
  if (
    !sections.intent &&
    !sections.userMessages &&
    !sections.status &&
    !sections.facts &&
    !sections.decisions &&
    !sections.errors &&
    !sections.codeChanges &&
    !sections.nextSteps &&
    !sections.files &&
    !sections.commands
  ) {
    return null;
  }
  return compactSectionsFingerprint(foldDurableCompactSections(sections));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pull the body of a single `# Section` block out of an LLM summary.
 *  Tolerates `# `, `## `, and `### ` prefixes — different summarisers
 *  emit different heading levels. Stops at the next heading of equal or
 *  shallower depth, or at end-of-input.
 *
 *  Implemented as a line-walk rather than a single regex: JS regex has no
 *  end-of-string anchor that survives the `m` flag (`\Z` doesn't exist in
 *  JS — it's a literal `Z`, and `$` in multiline mode matches line ends),
 *  so a `(?=heading|\Z)` lookahead silently failed to terminate the
 *  last section. The compact prompt puts "Errors encountered and their
 *  resolution" near the end of the section list, so under the old regex
 *  it was the section most likely to be missed. */
function extractSection(summary: string, title: string): string | null {
  const lines = splitLogicalLines(summary);
  const headingRe = /^(#{1,3})\s+(.+?)\s*$/;
  const targetTitle = normalizeCompactHeadingTitle(title);
  let start = -1;
  let startDepth = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(headingRe);
    if (start < 0) {
      if (m && normalizeCompactHeadingTitle(m[2]!) === targetTitle) {
        start = i + 1;
        startDepth = m[1]!.length;
      }
    } else if (m && m[1]!.length <= startDepth) {
      end = i;
      break;
    }
  }
  if (start < 0) return null;
  const body = lines.slice(start, end).join("\n").trim();
  return body.length > 0 ? body : null;
}
