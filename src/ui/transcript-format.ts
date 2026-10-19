import { shellCommandDisplay } from "../../zapsdk/utils/shell.js";
// Pure formatter helpers used by Transcript and other UI surfaces. Migrated
// from src/ui/external-transcript.ts (which is now deleted along with the
// opentui surface API path).
import { shortAgentLabel } from "./group-logs.js"
import { countCodePoints, sliceHeadCodePoints } from "../utils/logicalLines.js"

export const MAX_GENERIC_OUTPUT_LINES = 3
export const MAX_LINE_CHARS = 200
export type ThinkingMode = "summary" | "full" | "off"
export const THINKING_SUMMARY_FLOOR_MS = 2000

export function readThinkingMode(): ThinkingMode {
  const raw = (process.env.ZAPCODE_TRANSCRIPT_THINKING ?? "").trim().toLowerCase()
  if (raw === "full" || raw === "off") return raw
  return "summary"
}

export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "<1s"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return secs >= 10 ? `${Math.round(secs)}s` : `${secs.toFixed(1)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs - m * 60)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

export function oneLine(value: unknown, max = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return countCodePoints(text) > max ? `${sliceHeadCodePoints(text, Math.max(1, max - 1))}...` : text
}

export function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  const cwd = process.cwd().replace(/\\/g, "/")
  if (normalized.startsWith(cwd + "/")) return normalized.slice(cwd.length + 1)
  const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/")
  if (home && normalized.startsWith(home)) return "~" + normalized.slice(home.length)
  return normalized
}

function formatArgs(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return ""
  if (name === "agent") return shortAgentLabel(args.task as string | undefined)
  if (name === "skill") return oneLine(args.name)
  // exit_plan_mode carries the markdown plan as `plan`. Show the first
  // non-empty line as the in-parens preview so the row reads as
  // `ExitPlanMode("install foo + wire it through bar…")` instead of an
  // empty `ExitPlanMode()`.
  if (name === "exit_plan_mode" && typeof args.plan === "string") {
    const firstLine = String(args.plan)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
    return firstLine ? oneLine(firstLine) : ""
  }
  const patternFirst = (name === "search_files" || name === "glob_files") && args.pattern
  if (patternFirst) return oneLine(args.pattern)
  // Path key aliases: zapcode builtins use `path`, Anthropic's official
  // Claude tools (Read / Write / Edit / MultiEdit / Glob) use `file_path`,
  // some legacy schemas use `filePath` / `file`. Coalesce all four so
  // delegated tool calls don't render as `Read()` / `Edit()` with empty
  // parens just because the underlying CLI emits a different key.
  // tool-use-summary.ts already does this same coalesce; the UI formatter
  // was the only place still hard-wired to `args.path`.
  const path = args.path ?? args.file_path ?? args.filePath ?? args.file
  if (path) return oneLine(normalizePath(String(path)))
  if (args.source) return oneLine(`${normalizePath(String(args.source))} -> ${normalizePath(String(args.destination ?? ""))}`)
  if (args.command ?? args.cmd) return oneLine(String(args.command ?? args.cmd).replace(/\s*\n\s*/g, " "))
  if (name === "bash" && args.check_steps) return oneLine(shellCommandDisplay(args))
  if (args.pattern) return oneLine(args.pattern)
  if (args.query) return oneLine(args.query)
  if (args.url) return oneLine(args.url)
  if (args.task ?? args.description) return oneLine(args.task ?? args.description)
  return ""
}

const TOOL_ALIASES: Record<string, string> = {
  read_file: "Read", write_file: "Write", append_file: "Append",
  edit_file: "Edit", multi_edit: "MultiEdit",
  delete_file: "Delete", move_file: "Move", list_directory: "List", list_tree: "ListTree",
  bash: "Bash", execute_command: "Bash",
  glob_files: "Glob", search_files: "Search",
  web_search: "WebSearch", http_fetch: "Fetch",
  agent: "Agent", skill: "Skill", delegate_agent: "Delegate",
  todo_write: "TodoWrite",
  enter_plan_mode: "EnterPlanMode", exit_plan_mode: "ExitPlanMode",
  read_document: "ReadDocument", read_pdf: "ReadPdf", read_docx: "ReadDocx",
  current_time: "Time", memory_save: "Memory", memory_review: "MemoryReview", memory_merge: "MemoryMerge",
  cron_create: "CronCreate", cron_delete: "CronDelete", cron_list: "CronList",
  monitor: "Monitor",
}

export function getToolAlias(name: string): string {
  return TOOL_ALIASES[name] ?? name
}

export function formatToolCall(name: string, args: Record<string, unknown> | undefined): string {
  return `${getToolAlias(name)}(${formatArgs(name, args)})`
}

// Module-scoped so the table isn't reallocated on every render — LiveActivity
// hits this on the streaming hot path. Single source of truth for tool icons
// across Transcript and LiveActivity (previously duplicated in both files,
// risk of drift was exactly the same hazard the alias refactor just removed).
const TOOL_ICONS: Record<string, string> = {
  read_file: "→", write_file: "←", append_file: "+", edit_file: "←", multi_edit: "←",
  delete_file: "✕", move_file: "↔", execute_command: "$", bash: "$",
  glob_files: "✱", search_files: "✱", web_search: "◈", http_fetch: "%",
  agent: "◇", list_directory: "→",
}

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? "⚙"
}

export function formatResultLabel(name: string, args: Record<string, unknown> | undefined): string {
  return `${getToolIcon(name)} ${formatToolCall(name, args)}`
}

export function truncateOutput(output: string): { lines: string[]; truncated: boolean; total: number } {
  const trimmed = output.replace(/\s+$/, "")
  if (!trimmed) return { lines: [], truncated: false, total: 0 }
  const rawLines = trimmed.split(/\r?\n/)
  const overByLines = rawLines.length > MAX_GENERIC_OUTPUT_LINES
  const kept = overByLines ? rawLines.slice(0, MAX_GENERIC_OUTPUT_LINES) : rawLines
  const clipped = kept.map(line => {
    const lineChars = countCodePoints(line)
    if (lineChars <= MAX_LINE_CHARS) return line
    const trimChars = lineChars - MAX_LINE_CHARS
    return `${sliceHeadCodePoints(line, MAX_LINE_CHARS)} … +${trimChars}c`
  })
  return { lines: clipped, truncated: overByLines, total: rawLines.length }
}
