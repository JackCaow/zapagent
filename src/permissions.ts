import { existsSync, readFileSync } from "node:fs"
import { join, dirname, relative, isAbsolute, resolve, basename, sep } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { matchGlob } from "../zapsdk/builtin-tools/glob-util.js"
import { approvalFacts, opaqueShell } from "./approval-facts.js"
import type { ApprovalContext } from "../zapsdk/tools/executor.js"
import type { Logger } from "../zapsdk/debug/logger.js"
import { writeFileAtomic } from "./utils/secure-write.js"
import { canonicalizeWithNearestExistingAncestorSync, resolveToolPathCanonical } from "../zapsdk/builtin-tools/filesystem.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export const SANDBOX_ESCAPE_RULE = "SandboxEscape(*)"

export type RuleType = "allow" | "deny" | "ask"

export interface PermissionRule {
  /** e.g. "Bash(git *)", "Write(src/**)", "bash", "edit_file".
   *  `ask` rules force the prompt even when a blanket mode (acceptEdits,
   *  memory_path auto-allow) would otherwise auto-approve. Across all sources,
   *  deny wins over ask, and ask wins over allow, including bypass mode. */
  pattern: string
  type: RuleType
}

export interface PermissionSettings {
  rules: PermissionRule[]
}

export interface RuleGroup {
  source: string
  label: string
  rules: PermissionRule[]
}

/** A rule displayed in `/permissions` along with shadow info.
 *  `shadowedBy` is set when an earlier-checked rule fully covers this rule's
 *  pattern — meaning this rule is dead code and will never fire. */
export interface AnnotatedRule {
  rule: PermissionRule
  shadowedBy?: { rule: PermissionRule; scope: RuleScope }
}

export interface AnnotatedRuleGroup {
  source: string
  label: string
  rules: AnnotatedRule[]
}

/** Which settings layer (or session) a matched rule came from. */
export type RuleScope = "session" | "local" | "project" | "global"
export type RuleRemovalScope = RuleScope | "project-grants"

/** Output of PermissionManager.checkPermission — carries decision + evidence. */
export interface PermissionDecision {
  decision: "allow" | "deny" | "ask"
  /** The matched rule (when decision is allow/deny and came from rules). */
  rule?: PermissionRule
  /** Settings layer the rule lives in. */
  scope?: RuleScope
  reason?: string
}

/** Short, stable, non-reversible fingerprint of tool args — safe to log. */
export function argsFingerprint(args: Record<string, unknown>): string {
  try {
    return createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 12)
  } catch {
    return "unhashable"
  }
}

// ─── File paths ───────────────────────────────────────────────────────────────

/** Shared project settings — committed to git, visible to whole team. */
export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".zapcode", "settings.json")
}

/** Personal project overrides — gitignored, never committed. */
export function getProjectLocalSettingsPath(cwd: string): string {
  return join(cwd, ".zapcode", "settings.local.json")
}

/** Host-owned project grants stay outside the repository. Canonical directory
 * identity prevents a checkout or another clone from granting itself escape. */
export function getProjectAuthorizationSettingsPath(cwd: string): string {
  const root = canonicalizeWithNearestExistingAncestorSync(resolve(cwd))
  return join(getAppDataDir(), "permissions", "projects", createHash("sha256").update(root).digest("hex"), "settings.json")
}

export function getGlobalSettingsPath(): string {
  return join(getAppDataDir(), "settings.json")
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

function isValidRule(r: unknown): r is PermissionRule {
  if (typeof r !== "object" || r === null) return false
  const rec = r as Record<string, unknown>
  if (typeof rec.pattern !== "string") return false
  return rec.type === "allow" || rec.type === "deny" || rec.type === "ask"
}

export function loadPermissionSettings(filePath: string): PermissionSettings {
  if (!existsSync(filePath)) return { rules: [] }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown
    const rules = Array.isArray((parsed as Record<string, unknown>)?.rules)
      ? ((parsed as Record<string, unknown>).rules as unknown[]).filter(isValidRule)
      : []
    return { rules }
  } catch {
    return { rules: [] }
  }
}

export function savePermissionSettings(filePath: string, settings: PermissionSettings): void {
  writeFileAtomic(filePath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
}

/**
 * Source order breaks ties within the same decision type. Evaluation always
 * gives deny precedence over ask and allow, independent of source order.
 */
export function loadMergedSettings(cwd: string): PermissionSettings {
  const global  = loadPermissionSettings(getGlobalSettingsPath())
  const shared  = loadPermissionSettings(getProjectSettingsPath(cwd))
  const local   = loadPermissionSettings(getProjectLocalSettingsPath(cwd))
  const grants = loadPermissionSettings(getProjectAuthorizationSettingsPath(cwd))
  return { rules: [...grants.rules.filter(rule => rule.pattern !== SANDBOX_ESCAPE_RULE), ...local.rules, ...shared.rules, ...global.rules] }
}

// ─── Process wrapper stripping ────────────────────────────────────────────────
// e.g. "timeout 30 npm test" → ["npm", "test"]

const PROCESS_WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "exec"])

function stripProcessWrappers(parts: string[]): string[] {
  let i = 0
  while (i < parts.length && PROCESS_WRAPPERS.has(parts[i])) {
    const wrapper = parts[i++]
    if (wrapper === "timeout") {
      // skip optional flags like --signal=KILL or -s SIGTERM
      while (i < parts.length && parts[i].startsWith("-")) {
        if (!parts[i].includes("=")) i++ // flag with separate value arg
        i++
      }
      // skip duration like "30" or "1.5s"
      if (i < parts.length && /^\d/.test(parts[i])) i++
    } else if (wrapper === "nice") {
      // skip -n N or --adjustment=N
      if (i < parts.length && parts[i].startsWith("-")) {
        if (!parts[i].includes("=")) i++ // -n needs next arg
        i++
      }
    } else if (wrapper === "exec") {
      while (i < parts.length && parts[i].startsWith("-")) {
        const flag = parts[i++]
        if (flag === "--") break
        if (flag === "-a") i++
      }
    } else if (wrapper === "stdbuf") {
      // skip all -iX -oX -eX flags
      while (i < parts.length && parts[i].startsWith("-")) i++
    }
    // time, nohup: no args to skip
  }
  return parts.slice(i)
}

// Import and re-export from shared utility so callers only need one import
import { matchCommandGlob, matchesAnyCommandPattern, shellCommandDisplay, shellExecutionCommands, splitShellSubcommands } from "../zapsdk/utils/shell.js"
import { effectiveCommandCwd, isReadOnlyCommand } from "./readonly-commands.js"
export { splitShellSubcommands }

// ─── Pattern parsing ──────────────────────────────────────────────────────────

const TOOL_ALIASES: Record<string, string[]> = {
  bash:   ["bash"],
  write:  ["write_file", "create_file"],
  edit:   ["edit_file"],
  read:   ["read_file", "search_files", "glob_files", "read_document", "read_tool_output"],
  delete: ["delete_file"],
  move:   ["move_file"],
  list:   ["list_tree"],
  listtree: ["list_tree"],
  readdocument: ["read_document"],
}

/** Tools whose rule subjects and generated scopes are file paths. */
const FILE_TOOLS = new Set([
  "write_file", "edit_file", "multi_edit", "delete_file",
  "create_file", "move_file", "read_file",
  "list_tree",
  // read_tool_output is a session capability, not a project filesystem path.
  "search_files", "glob_files", "read_document",
])

const MUTATION_TOOLS = new Set(["write_file", "create_file", "edit_file", "multi_edit", "delete_file", "move_file"])

const PATH_READ_TOOLS = new Set([
  "read_file", "list_tree", "search_files", "glob_files", "read_document",
])
const DIRECTORY_READ_TOOLS = new Set([
  "list_tree", "search_files", "glob_files",
])

const DELEGATE_AGENT_SUBJECT_ARG = "__zapDelegateAgentSubject"

/**
 * Coordinate normalization: turn an arbitrary file path into the
 * cwd-relative form used by every rule pattern.
 *
 * Rules in settings.json are stored cwd-relative (so they're portable
 * across machines and users) — see `inferPattern`. But `args.path` from
 * a tool call may be absolute, relative, or `./prefixed`. Without this
 * normalization, a rule written as `Edit(src/**)` never matches a
 * subject like `/abs/.../src/foo.ts`, and "don't ask again" silently
 * no-ops — the user gets reprompted on the same path.
 *
 * Idempotent: passing an already-relative path yields the same path
 * back. Paths outside cwd (e.g. `/etc/hosts`) stay absolute, mirroring
 * `inferPattern`'s existing handling for out-of-tree edits.
 */
export function pathToCwdRelative(p: string, cwd: string): string {
  if (!p) return p
  try {
    // Resolve against OUR cwd, not process.cwd. Node's `relative()`
    // would otherwise pass `p` through `path.resolve()` which is
    // anchored on process.cwd — wrong when the agent's working dir
    // differs (always true in tests, often true in production where
    // zap is launched from a parent dir of the project).
    const abs = isAbsolute(p) ? p : resolve(cwd, p)
    const rel = relative(cwd, abs)
    // Outside cwd → keep original. `../escape` and abs paths outside
    // cwd both end up here; the original form is the only stable
    // identifier across runs.
    if (rel.startsWith("..") || isAbsolute(rel)) return p
    return rel || "."
  } catch {
    return p
  }
}

export function isPathReadTool(toolName: string): boolean {
  return PATH_READ_TOOLS.has(toolName)
}

function isDirectoryReadTool(toolName: string): boolean {
  return DIRECTORY_READ_TOOLS.has(toolName)
}

export function pathReadOutsideCwdReason(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string | null {
  if (!isPathReadTool(toolName)) return null
  const rawPath = args.path
  if (typeof rawPath !== "string" || !rawPath.trim()) return null
  const lexicalCwd = resolve(cwd)
  const resolvedCwd = canonicalizeWithNearestExistingAncestorSync(lexicalCwd)
  const expanded = rawPath.startsWith("~/")
    ? join(homedir(), rawPath.slice(2))
    : rawPath === "~"
      ? homedir()
      : rawPath
  const lexicalPath = isAbsolute(expanded) ? resolve(expanded) : resolve(lexicalCwd, expanded)
  const absPath = canonicalizeWithNearestExistingAncestorSync(lexicalPath)
  const rel = relative(resolvedCwd, absPath)
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) return null
  const lexicalRel = relative(lexicalCwd, lexicalPath)
  const displayPath = lexicalRel.startsWith("..") || isAbsolute(lexicalRel)
    ? lexicalPath
    : absPath
  return `path outside cwd: ${displayPath}`
}

function directoryScopePattern(scope: string): string {
  const normalized = scope.replace(/\/+$/g, "")
  if (!normalized || normalized === ".") return "**"
  return `${normalized}{,/**}`
}

function fileRuleScope(toolName: string, rel: string): string {
  if (isDirectoryReadTool(toolName)) return directoryScopePattern(rel)
  const dir = dirname(rel)
  return dir === "." ? "**" : `${dir}/**`
}

function normalizeDelegateCwd(value: unknown, cwd: string): string {
  const raw = typeof value === "string" && value.trim() ? value : cwd
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  const rel = relative(cwd, abs)
  if (!rel) return "."
  if (rel.startsWith("..") || isAbsolute(rel)) return abs
  return rel
}

function delegateAgentSubject(args: Record<string, unknown>, cwd: string): string | null {
  const provider = typeof args.provider === "string" ? args.provider.trim() : ""
  if (!provider) return null
  const delegateCwd = normalizeDelegateCwd(args.cwd, cwd)
  return `${encodeURIComponent(provider)}@${encodeURIComponent(delegateCwd)}`
}

/**
 * Apply `pathToCwdRelative` to the path-like fields of a file-tool's
 * args. Called at every PermissionManager public entry so that pattern
 * matching and rule construction share the same
 * coordinate system. Single source of truth — kept here, not inlined
 * across callers, so a future field addition (say `target`) only needs
 * editing one list.
 */
function normalizeFileArgs(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  context?: Readonly<ApprovalContext>,
  canonical: boolean | "entry" = true,
): Record<string, unknown> {
  if (toolName === "delegate_agent") {
    const subject = delegateAgentSubject(args, cwd)
    return subject ? { ...args, [DELEGATE_AGENT_SUBJECT_ARG]: subject } : args
  }
  if (!FILE_TOOLS.has(toolName)) return args
  let mutated: Record<string, unknown> | null = null
  for (const k of ["path", "source", "destination"]) {
    const v = args[k]
    if (typeof v !== "string" || !v) continue
    const anchor = resolve(context?.workspaceRoot ?? cwd)
    const expanded = v === "~" ? homedir() : v.startsWith("~/") ? join(homedir(), v.slice(2)) : v
    const absolute = resolve(context?.cwd ?? anchor, expanded)
    const base = canonical ? canonicalizeWithNearestExistingAncestorSync(anchor) : anchor
    const target = canonical === "entry" ? resolve(canonicalizeWithNearestExistingAncestorSync(dirname(absolute)), basename(absolute))
      : canonical ? canonicalizeWithNearestExistingAncestorSync(absolute) : absolute
    const rel = relative(base, target)
    const norm = rel === "" ? "." : rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel) ? rel : target
    if (norm !== v) {
      mutated ??= { ...args }
      mutated[k] = norm
    }
  }
  return mutated ?? args
}

interface ParsedPattern {
  toolNames: string[]
  argPattern: string | null
}

function parsePattern(pattern: string): ParsedPattern {
  const parenIdx = pattern.indexOf("(")
  if (parenIdx !== -1 && pattern.endsWith(")")) {
    const alias = pattern.slice(0, parenIdx).toLowerCase()
    const argPattern = pattern.slice(parenIdx + 1, -1)
    const toolNames = TOOL_ALIASES[alias] ?? [pattern.slice(0, parenIdx)]
    return { toolNames, argPattern }
  }
  const lower = pattern.toLowerCase()
  const toolNames = TOOL_ALIASES[lower] ?? [pattern]
  return { toolNames, argPattern: null }
}

function isWholeToolRule(rule: PermissionRule, name: string): boolean {
  const { toolNames, argPattern } = parsePattern(rule.pattern)
  return toolNames.includes(name) && (argPattern === null || argPattern === "*" || argPattern === ":*")
}

function extractArgString(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return shellCommandDisplay(args)
  if (FILE_TOOLS.has(toolName)) {
    return String(args.path ?? args.source ?? "")
  }
  if (toolName === "delegate_agent") {
    return typeof args[DELEGATE_AGENT_SUBJECT_ARG] === "string"
      ? args[DELEGATE_AGENT_SUBJECT_ARG]
      : ""
  }
  const first = Object.values(args).find(v => typeof v === "string")
  return typeof first === "string" ? first : ""
}

function matchFilePattern(path: string, pattern: string): boolean {
  if (!isAbsolute(pattern) && (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\"))) return false
  return matchGlob(path, pattern) || (isAbsolute(pattern) && matchGlob(path, canonicalizeWithNearestExistingAncestorSync(pattern)))
}

/** Directory readers may touch every descendant. When a restriction could
 * intersect that tree, stop the whole scan before the handler sees contents.
 * A wildcard inside a segment uses its parent as a conservative boundary. */
function directoryRuleIntersects(rule: PermissionRule, tool: string, args: Record<string, unknown>, cwd: string, context?: Readonly<ApprovalContext>): boolean {
  const { toolNames, argPattern } = parsePattern(rule.pattern)
  if (!toolNames.includes(tool) || argPattern === null) return toolNames.includes(tool)
  const pattern = argPattern.replace(/\{,\/\*\*\}$/, "/**")
  const wildcard = pattern.search(/[*?{]/)
  const literal = wildcard < 0 ? pattern : pattern.slice(0, wildcard)
  const boundary = wildcard < 0 ? literal : literal.endsWith("/") ? literal.slice(0, -1) || "/" : dirname(literal || ".")
  const ruleContext = context ? { ...context, cwd: context.workspaceRoot } : undefined
  for (const canonical of [false, true]) {
    const path = String(normalizeFileArgs(tool, { path: args.path ?? "." }, cwd, context, canonical).path)
    const restricted = String(normalizeFileArgs(tool, { path: boundary || "." }, cwd, ruleContext, canonical).path)
    if (isAbsolute(path) !== isAbsolute(restricted)) continue
    const overlap = (parent: string, child: string) => {
      const rel = relative(resolve(parent), resolve(child))
      return !rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    }
    if (overlap(path, restricted) || overlap(restricted, path)) return true
  }
  return false
}

export function ruleMatchesTool(
  rule: PermissionRule,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const { toolNames, argPattern } = parsePattern(rule.pattern)
  if (!toolNames.some(n => n === toolName)) return false
  if (toolName === "delegate_agent" && argPattern === null) return rule.type === "deny"
  if (argPattern === null) return true
  if (toolName === "move_file") {
    const paths = [args.source, args.destination].filter((value): value is string => typeof value === "string" && !!value)
    return rule.type === "allow" ? paths.length === 2 && paths.every(path => matchFilePattern(path, argPattern)) : paths.some(path => matchFilePattern(path, argPattern))
  }
  const subject = extractArgString(toolName, args)
  if (toolName === "bash") return matchCommandGlob(subject, argPattern)
  if (toolName === "delegate_agent") return subject === argPattern
  return FILE_TOOLS.has(toolName) ? matchFilePattern(subject, argPattern) : matchGlob(subject, argPattern)
}

// ─── Shadow detection ─────────────────────────────────────────────────────────

/** Does `a`'s arg pattern match any possible arg for the tool?
 *  Used by `patternCovers` when `b` has no argPattern (tool-only match). */
function isUniversalArg(pattern: string, tool: string): boolean {
  if (tool === "bash") return pattern === "*" || pattern === ":*"
  return pattern === "**" || pattern === "*"
}

/** Does bash pattern `a` cover every invocation bash pattern `b` matches?
 *  Conservative — only handles `prefix:*` whitespace-boundary nesting and
 *  universal wildcards. */
function bashArgCovers(a: string, b: string): boolean {
  if (a === b) return true
  if (a === "*" || a === ":*") return true
  const aEnds = a.endsWith(":*")
  const bEnds = b.endsWith(":*")
  if (aEnds && bEnds) {
    const aPrefix = a.slice(0, -2)
    const bPrefix = b.slice(0, -2)
    if (aPrefix === "") return true
    if (bPrefix === aPrefix) return true
    // aPrefix must be a whitespace-bounded prefix of bPrefix
    return bPrefix.startsWith(aPrefix + " ") || bPrefix.startsWith(aPrefix + "\t")
  }
  return false
}

/** Does file glob `a` cover every path file glob `b` matches?
 *  Handles `**` and `dir/**` nesting + literal paths. Anything more
 *  exotic (mid-pattern `*`, brace alternation) is treated conservatively
 *  as "doesn't cover" — false negatives preferred over false positives. */
function fileArgCovers(a: string, b: string): boolean {
  if (a === b) return true
  if (a === "**" || a === "*") return matchFilePattern(b, a)
  if (a.endsWith("/**")) {
    const aBase = a.slice(0, -3)
    // a = "dir/**" covers b = "dir/*/..." forms:
    if (b.startsWith(aBase + "/")) return true
  }
  return false
}

/** Does rule pattern `a` cover every invocation matched by rule pattern `b`?
 *  If true, `b` is shadowed by `a` — `b` will never fire when evaluated
 *  after `a`. Conservative: unknown cases return false. */
export function patternCovers(aPattern: string, bPattern: string): boolean {
  if (aPattern === bPattern) return true
  const a = parsePattern(aPattern)
  const b = parsePattern(bPattern)
  if (!b.toolNames.every(t => a.toolNames.includes(t))) return false
  if (a.argPattern === null) return true
  const primaryTool = a.toolNames[0] ?? "bash"
  if (b.argPattern === null) return !b.toolNames.some(tool => FILE_TOOLS.has(tool)) && isUniversalArg(a.argPattern, primaryTool)
  if (primaryTool === "bash") return bashArgCovers(a.argPattern, b.argPattern)
  return fileArgCovers(a.argPattern, b.argPattern)
}

// ─── Pattern inference ────────────────────────────────────────────────────────

function extractBinary(command: string): string {
  return extractCommandPrefix(command, 1)
}

/**
 * Extract the first `maxTokens` meaningful tokens from a command — skips
 * shell prefixes (cd && ...) and process wrappers (timeout/nohup/...), then
 * walks forward only through bare-word tokens (not flags, paths, quotes, or
 * env-var assignments). Used to form Claude-Code-style command prefixes:
 *
 *   "git commit -m x"           → "git commit"   (2 bare tokens)
 *   "git log"                   → "git log"
 *   "python script.py"          → "python"       (script.py has a dot)
 *   "ls -la"                    → "ls"           (-la is a flag)
 *   "timeout 30 npm test"       → "npm test"     (wrappers stripped)
 *   "cd /tmp && git status"     → "git status"
 */
function extractCommandPrefix(command: string, maxTokens: number): string {
  const raw = command.trim()
  const cdAndMatch = raw.match(/^cd\s+[^\s;&|]+\s*&&\s*(.+)$/)
  const effective = cdAndMatch ? cdAndMatch[1].trim() : raw
  const parts = effective.split(/\s+/).filter(Boolean)
  const stripped = stripProcessWrappers(parts)
  if (stripped.length === 0) return ""
  const kept: string[] = []
  for (const token of stripped) {
    if (kept.length >= maxTokens) break
    // Accept bare alphanumeric (and `_` / `-`) only; reject anything that smells
    // like a flag, a path, a quoted string, or a var=value pair.
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) break
    kept.push(token)
  }
  return kept.join(" ")
}

/**
 * Normalize a single shell subcommand for matching. Strips the same things
 * `extractCommandPrefix` does — `cd X && ` prefix and process wrappers
 * (`timeout`, `nohup`, `nice`, `time`, `stdbuf`) — but returns the FULL
 * remaining command (not just a prefix). Used to make rule matching
 * symmetric with rule saving:
 *   save:  `nohup python3 a.py` →  inferPattern strips wrapper →  Bash(python3:*)
 *   match: `nohup python3 a.py` →  normalizeBashSubcommand strips wrapper
 *                                  →  "python3 a.py"  →  matches python3:*
 * Without this, a rule like Bash(python3:*) never matched the very command
 * that produced it whenever the model added a `nohup` / `cd && ` wrapper.
 */
export function normalizeBashSubcommand(sub: string): string {
  const trimmed = sub.trim();
  if (!trimmed) return "";
  const cdAndMatch = trimmed.match(/^cd\s+[^\s;&|]+\s*&&\s*(.+)$/);
  const effective = cdAndMatch ? cdAndMatch[1].trim() : trimmed;
  const parts = effective.split(/\s+/).filter(Boolean);
  return stripProcessWrappers(parts).join(" ");
}

/**
 * Infer a pattern from a specific invocation (used for "allow always").
 *
 * Returns null when the invocation lacks the info needed to produce a
 * *bounded* pattern — callers MUST refuse to save in that case. This closes
 * two past landmines:
 *   1. `write_file` with no args.path used to save the bare tool name, which
 *      ruleMatchesTool then treated as "match all write_file calls".
 *   2. `bash` with no extractable binary used to save the bare token "bash",
 *      matching every bash command ever.
 */
export function inferPattern(toolName: string, args: Record<string, unknown>, cwd: string): string | null {
  if (toolName === "bash") {
    // Prefer a two-token prefix so approving `git commit -m "x"` saves
    // `Bash(git commit:*)` rather than giving away all of git.
    const prefix = extractCommandPrefix(shellCommandDisplay(args), 2)
    return prefix ? `Bash(${prefix}:*)` : null
  }
  if (toolName === "delegate_agent") {
    const subject = delegateAgentSubject(args, cwd)
    return subject ? `delegate_agent(${subject})` : null
  }
  const aliases: Record<string, string> = {
    write_file: "Write", create_file: "Write",
    edit_file: "Edit", multi_edit: "multi_edit", delete_file: "Delete",
    read_file: "Read", move_file: "Move",
    list_tree: "ListTree", read_document: "ReadDocument",
  }
  const alias = aliases[toolName]
  if (alias) {
    // move_file uses `destination` (and `source`), not `path`
    const filePath = toolName === "move_file"
      ? String(args.destination ?? args.source ?? "")
      : String(args.path ?? "")
    if (!filePath) return null
    const rel = pathToCwdRelative(filePath, cwd)
    // Out-of-cwd path stays absolute → exact match, not a glob.
    if (isAbsolute(rel)) return `${alias}(${rel})`
    return `${alias}(${fileRuleScope(toolName, rel)})`
  }
  // Non-aliased tools: exact tool-name match is fine (no args to wildcard).
  // High-risk tools that need arg scoping should get a dedicated branch above.
  return toolName
}

/** The same complete rule set powers previews and both persistence lifetimes. */
export function inferInvocationRules(name: string, args: Record<string, unknown>, cwd: string, context?: Readonly<ApprovalContext>): PermissionRule[] {
  const pathPatterns = name === "bash" ? shellPathRequests(args, context?.cwd ?? cwd)
    .map(request => inferPattern(request.tool, { path: request.path }, cwd)).filter((pattern): pattern is string => !!pattern) : []
  if (opaqueShell(approvalFacts(name, args, context), context)) return [name, ...pathPatterns].map(pattern => ({ pattern, type: "allow" }))
  const views = [normalizeFileArgs(name, args, cwd, context)]
  if (MUTATION_TOOLS.has(name)) views.push(normalizeFileArgs(name, args, cwd, context, "entry"))
  const invocations = views.flatMap(normalized => name === "bash"
    ? shellExecutionCommands(normalized).flatMap(command => splitShellSubcommands(command, context?.shell?.syntax)).map(command => ({ ...normalized, command }))
    : name === "move_file" ? [normalized.source, normalized.destination].map(path => ({ source: path, destination: path })) : [normalized])
  const patterns = invocations.map(value => inferPattern(name, value, cwd)).filter((pattern): pattern is string => !!pattern)
  patterns.push(...pathPatterns)
  return [...new Set(patterns)].map(pattern => ({ pattern, type: "allow" }))
}

function shellPathRequests(args: Record<string, unknown>, cwd: string): Array<{ tool: "read_file" | "write_file"; path: string }> {
  const runCwd = resolveToolPathCanonical(typeof args.cwd === "string" ? args.cwd : cwd, cwd)
  return ([ ["read_paths", "read_file"], ["write_paths", "write_file"] ] as const).flatMap(([field, tool]) =>
    Array.isArray(args[field]) ? args[field].filter((path): path is string => typeof path === "string")
      .map(path => ({ tool, path: resolve(runCwd, path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path) })) : [])
}

// ─── PermissionManager ────────────────────────────────────────────────────────

export class PermissionManager {
  private readonly cwd: string
  private readonly logger?: Logger
  private merged: PermissionSettings
  /** Fast lookup map for session rules: key → rule type. */
  /** Session rules (for display in /permissions, and to surface scope in decisions). */
  private sessionRules: PermissionRule[] = []
  private sandboxSessionId?: string
  private sessionSandboxEscape?: PermissionRule
  /**
   * Whether bash commands really run inside the OS sandbox or the VM. The
   * built-in read-only allowance is only safe then: without a sandbox every
   * command prompts as before, so a gap in the read-only parser can never reach
   * an unconfined shell. Set by whoever builds the execution environment.
   */
  private sandboxConfined = false

  /** Auto-allow every command that runs inside the sandbox (not just the
   *  read-only list). Escapes, dangerous patterns and user deny/ask rules
   *  still prompt. Default on; config `autoAllowSandboxedCommands: false`
   *  keeps only the read-only allowance. */
  private sandboxAutoAllow = true

  /** Patterns from config `sandboxExcludedCommands`; empty when escapes are disabled. */
  private sandboxExcluded: string[] = []
  setSandboxExcludedCommands(patterns: string[] | undefined): void { this.sandboxExcluded = patterns ?? [] }

  setSandboxConfined(confined: boolean, autoAllowAll = true): void {
    this.sandboxConfined = confined
    this.sandboxAutoAllow = autoAllowAll
  }

  constructor(cwd: string, logger?: Logger) {
    this.cwd = cwd
    this.logger = logger
    this.merged = loadMergedSettings(cwd)
  }

  /** All session consent expires on /new or a restored fork. */
  setSessionId(sessionId: string): void {
    if (this.sandboxSessionId === sessionId) return
    this.sandboxSessionId = sessionId
    this.sessionSandboxEscape = undefined
    this.sessionRules = []
  }

  /** Dedicated consent is separate from ordinary Bash command allow rules. */
  checkSandboxEscape(): PermissionDecision {
    const rules = loadPermissionSettings(getProjectAuthorizationSettingsPath(this.cwd)).rules
      .filter(rule => rule.pattern === SANDBOX_ESCAPE_RULE)
    const restriction = rules.find(rule => rule.type === "deny") ?? rules.find(rule => rule.type === "ask")
    if (restriction) return { decision: restriction.type, rule: restriction, scope: "project" }
    if (this.sessionSandboxEscape) return { decision: "allow", rule: this.sessionSandboxEscape, scope: "session" }
    const grant = rules.find(rule => rule.type === "allow")
    return grant ? { decision: "allow", rule: grant, scope: "project" } : { decision: "ask" }
  }

  grantSandboxEscape(scope: "session" | "project"): void {
    const rule: PermissionRule = { pattern: SANDBOX_ESCAPE_RULE, type: "allow" }
    if (scope === "session") {
      this.sessionSandboxEscape = rule
      this.logRuleAdded(rule, scope, "bash", { sandboxEscape: true })
      return
    }
    const path = getProjectAuthorizationSettingsPath(this.cwd)
    const current = loadPermissionSettings(path)
    if (!current.rules.some(value => value.pattern === rule.pattern && value.type === rule.type)) {
      current.rules.push(rule)
      savePermissionSettings(path, current)
    }
    this.logRuleAdded(rule, scope, "bash", { sandboxEscape: true }, path)
  }

  /** Product grants use one atomic write and never mutate the shared repo settings. */
  addToolRules(rules: PermissionRule[], lifetime: "session" | "project"): void {
    if (!rules.length || rules.some(rule => rule.type !== "allow" || rule.pattern === SANDBOX_ESCAPE_RULE)) throw new Error("Invalid tool grant")
    const path = getProjectAuthorizationSettingsPath(this.cwd)
    const existing = lifetime === "session" ? [...this.sessionRules] : loadPermissionSettings(path).rules
    const added = rules.filter((rule, index) => !existing.some(value => value.type === rule.type && value.pattern === rule.pattern)
      && rules.findIndex(value => value.type === rule.type && value.pattern === rule.pattern) === index)
    const next = [...existing, ...added]
    if (lifetime === "session") this.sessionRules = next
    else savePermissionSettings(path, { rules: next })
    for (const rule of added) this.logRuleAdded(rule, lifetime, "tool_grant", {}, lifetime === "project" ? path : undefined)
    this.reload()
  }

  grantCoversCall(rules: PermissionRule[], name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): boolean {
    const normalized = normalizeFileArgs(name, args, this.cwd, context)
    const facts = approvalFacts(name, args, context)
    if (name === "bash" && !shellPathRequests(args, context?.cwd ?? this.cwd).every(({ tool, path }) => {
      const field = tool === "read_file" ? "read_paths" : "write_paths"
      if (this.checkShellPaths({ [field]: [path] }, context).decision === "allow") return true
      const fileArgs = normalizeFileArgs(tool, { path }, this.cwd, context)
      return rules.some(rule => rule.type === "allow" && ruleMatchesTool(rule, tool, fileArgs))
    })) return false
    if (opaqueShell(facts, context)) return rules.some(rule => rule.type === "allow" && isWholeToolRule(rule, name))
    if (name === "bash") {
      const commands = shellExecutionCommands(normalized).flatMap(command => splitShellSubcommands(command, context?.shell?.syntax))
      return commands.length > 0 && commands.every(command => rules.some(rule =>
        ruleMatchesTool(rule, name, { command }) || ruleMatchesTool(rule, name, { command: normalizeBashSubcommand(command) })))
    }
    const views = [normalized]
    if (MUTATION_TOOLS.has(name)) views.push(normalizeFileArgs(name, args, this.cwd, context, "entry"))
    return views.every(view => name === "move_file" ? [view.source, view.destination].every(path =>
      typeof path === "string" && !!path && rules.some(rule => ruleMatchesTool(rule, name, { source: path, destination: path })))
      : rules.some(rule => ruleMatchesTool(rule, name, view)))
  }

  /**
   * Evaluate a tool invocation against rules. Returns decision + the matching
   * rule/scope when applicable, so callers can log *why* a decision was made.
   *
   * Bash takes a special path (`checkShellCommand`): the command is split on
   * shell operators and EVERY subcommand must clear the rules independently.
   * Without this split, the save side (`addProjectRule`) would write a rule
   * per subcommand, but the match side would test the whole compound string
   * against each rule and fail — saved rules wouldn't match the very
   * commands that produced them. See `normalizeBashSubcommand` for the
   * companion fix that strips wrappers (nohup/cd&&/timeout/...) symmetrically.
   */
  checkPermission(toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): PermissionDecision {
    const base = this.checkPermissionCore(toolName, args, context)
    if (toolName !== "bash" || base.decision === "deny") return base
    const decisions = [base, this.checkShellPaths(args, context)]
    return decisions.find(value => value.decision === "deny")
      ?? decisions.find(value => value.decision === "ask" && value.rule)
      ?? decisions.find(value => value.decision === "ask") ?? base
  }

  /** Shell patterns cannot silently authorize new filesystem roots. */
  checkShellPaths(args: Record<string, unknown>, context?: Readonly<ApprovalContext>): PermissionDecision {
    this.merged = loadMergedSettings(this.cwd)
    const decisions = shellPathRequests(args, context?.cwd ?? this.cwd).map(({ tool, path }) => {
      // Grants cover descendants and write roots also permit reads/edits/removal.
      const names = tool === "read_file" ? [tool] : ["read_file", "write_file", "edit_file", "delete_file"]
      const restriction = this.matchRules(rule => rule.type !== "allow" && names.some(name =>
        directoryRuleIntersects(rule, name, { path }, this.cwd, context)))
      if (restriction) return restriction
      const decision = this.checkPermissionCore(tool, { path }, context)
      if (decision.decision === "allow") return decision
      if (!pathReadOutsideCwdReason("read_file", { path }, context?.workspaceRoot ?? this.cwd)) return { decision: "allow" as const }
      return { decision: "ask" as const, reason: `Shell ${tool === "read_file" ? "read" : "write"} path requires authorization: ${path}` }
    })
    return decisions.find(value => value.decision === "deny")
      ?? decisions.find(value => value.decision === "ask" && value.rule)
      ?? decisions.find(value => value.decision === "ask") ?? { decision: "allow" }
  }

  private checkPermissionCore(toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): PermissionDecision {
    // Normalize once at the entry; rule evaluation and generation both
    // operate in cwd-relative space afterwards. This is the fix for the
    // "I selected 'always allow' but keep getting reprompted" bug —
    // patterns are saved cwd-relative but subjects can arrive absolute.
    this.merged = loadMergedSettings(this.cwd)
    const a = normalizeFileArgs(toolName, args, this.cwd, context)
    if (FILE_TOOLS.has(toolName)) {
      const lexical = normalizeFileArgs(toolName, args, this.cwd, context, false)
      const views = [a]
      if (MUTATION_TOOLS.has(toolName)) views.push(normalizeFileArgs(toolName, args, this.cwd, context, "entry"))
      const restriction = this.matchRules(rule => rule.type !== "allow" && (
        [...views, lexical].some(view => ruleMatchesTool(rule, toolName, view))
        || isDirectoryReadTool(toolName) && directoryRuleIntersects(rule, toolName, args, this.cwd, context)))
      if (restriction) return restriction
      const matches = views.flatMap(view => toolName === "move_file" ? [view.source, view.destination].map(path =>
        typeof path === "string" && !!path ? this.matchRules(rule => rule.type === "allow" && ruleMatchesTool(rule, toolName, { source: path, destination: path })) : null)
        : [this.matchRules(rule => rule.type === "allow" && ruleMatchesTool(rule, toolName, view))])
      return matches.every(Boolean) ? matches[0]! : { decision: "ask" }
    }

    const facts = approvalFacts(toolName, args, context)
    if (facts.shellCommands !== undefined) {
      const wholeRestriction = this.matchRules(rule => rule.type !== "allow" && isWholeToolRule(rule, toolName))
      if (wholeRestriction?.decision === "deny") return wholeRestriction
      const commands = facts.shellCommands ?? []
      const leavesSandbox = facts.sandboxEscape || commands.some(command => matchesAnyCommandPattern(command, this.sandboxExcluded))
      const runDir = leavesSandbox || !facts.workspaceShell ? null : effectiveCommandCwd(this.cwd, args.cwd)
      const decisions = commands.map(command => this.checkShellCommand(command, runDir, context?.shell?.syntax, toolName))
      const restriction = decisions.find(decision => decision.decision === "deny")
        ?? wholeRestriction
        ?? decisions.find(decision => decision.decision === "ask" && decision.rule)
      if (restriction) return restriction
      if (opaqueShell(facts, context)) {
        const unresolved = this.matchRules(rule => rule.type !== "allow" && parsePattern(rule.pattern).toolNames.includes(toolName))
        if (unresolved) return { ...unresolved, decision: "ask", reason: `cannot verify command restriction ${unresolved.rule?.pattern} for opaque shell input` }
        const whole = this.matchRules(rule => isWholeToolRule(rule, toolName))
        if (whole) return whole
        if (commands.length && this.sandboxConfined && this.sandboxAutoAllow && runDir !== null)
          return { decision: "allow", reason: "sandbox execution capability" }
        return { decision: "ask" }
      }
      return decisions.find(decision => decision.decision === "ask") ?? decisions[0] ?? { decision: "ask" }
    }

    return this.matchRules(rule => ruleMatchesTool(rule, toolName, a)) ?? { decision: "ask" }
  }

  private matchRules(matches: (rule: PermissionRule) => boolean): PermissionDecision | null {
    const candidates = [...this.sessionRules, ...this.merged.rules].filter(matches)
    for (const type of ["deny", "ask", "allow"] as const) {
      const rule = candidates.find(rule => rule.type === type)
      if (rule) return { decision: type, rule, scope: this.sessionRules.includes(rule) ? "session" : this.locateRuleScope(rule) }
    }
    return null
  }

  /**
   * Bash-specific permission check: split the command on shell operators
   * (; && || | &), then evaluate each subcommand independently. Combine:
   *   - any deny  → overall deny  (short-circuits)
   *   - any explicit ask rule → overall ask (with that rule)
   *   - any subcommand with no matching rule → overall ask (no rule attached)
   *   - all subcommands matched allow → overall allow
   * Returning the first matched allow rule lets the UI show a representative
   * rule when explaining why a compound was approved.
   */
  private checkShellCommand(command: string, runDir: string | null = this.cwd, syntax?: "posix" | "cmd" | "unknown", toolName = "bash"): PermissionDecision {
    if (!command.trim()) return { decision: "ask" }
    const subs = splitShellSubcommands(command, syntax)
    if (subs.length === 0) return { decision: "ask" }

    let firstAllowRule: PermissionRule | undefined
    let firstAllowScope: RuleScope | undefined
    let ask: PermissionDecision | undefined
    for (const sub of subs) {
      const r = this.checkShellSubcommand(sub, runDir, toolName)
      if (r === null) {
        ask ??= { decision: "ask" }
        continue
      }
      if (r.decision === "deny") return r
      if (r.decision === "ask") {
        // Keep checking for a later deny; retain explicit asks so callers
        // cannot mistake them for the fallback on an unmatched command.
        if (!ask?.rule) ask = r
        continue
      }
      if (!firstAllowRule) {
        firstAllowRule = r.rule
        firstAllowScope = r.scope
      }
    }
    return ask ?? { decision: "allow", rule: firstAllowRule, scope: firstAllowScope }
  }

  /**
   * Per-subcommand match. Returns null when no rule matched (so the caller
   * can treat the whole compound as "ask, no rule"). Tests the rule against
   * BOTH the raw subcommand and its wrapper-stripped form, so a rule saved
   * as Bash(python3:*) matches a subcommand like `nohup python3 server.py`.
   */
  private checkShellSubcommand(sub: string, runDir: string | null = this.cwd, toolName = "bash"): PermissionDecision | null {
    const normalized = normalizeBashSubcommand(sub)
    const decision = this.matchRules(rule => {
      const { toolNames, argPattern } = parsePattern(rule.pattern)
      return toolNames.includes(toolName) && (argPattern === null || matchCommandGlob(sub, argPattern)
        || !!(normalized && normalized !== sub && matchCommandGlob(normalized, argPattern)))
    })
    if (decision) return decision
    // After every user rule, so an explicit deny or ask still wins. Only while
    // commands really run in the OS sandbox or VM, and never for a `cwd`
    // outside the workspace (runDir === null).
    if (this.sandboxConfined && runDir !== null) {
      if (this.sandboxAutoAllow) {
        return { decision: "allow", rule: { pattern: "(built-in sandboxed command)", type: "allow" }, scope: "session" }
      }
      if (isReadOnlyCommand(sub, runDir)) {
        return { decision: "allow", rule: { pattern: "(built-in read-only command)", type: "allow" }, scope: "session" }
      }
    }
    return null
  }

  /** Allow for the rest of this session (in-memory only). Bash compounds are
   *  split into per-subcommand session rules — symmetric with `addProjectRule`
   *  and required for `checkShellCommand`'s per-subcommand lookup to find them. */
  addSessionRule(toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): void {
    const rules = inferInvocationRules(toolName, args, this.cwd, context)
    if (!rules.length) { this.logRuleRefused(toolName, args, "session", "allow"); return }
    this.addToolRules(rules, "session")
  }

  /** Deny for the rest of this session (in-memory only). */
  addSessionDenyRule(toolName: string, args: Record<string, unknown>): void {
    const a = normalizeFileArgs(toolName, args, this.cwd)
    if (toolName === "bash") {
      const subs = shellExecutionCommands(a).flatMap(command => splitShellSubcommands(command))
      for (const sub of subs) {
        this._writeSessionRule(toolName, { ...a, command: sub }, "deny")
      }
    } else {
      this._writeSessionRule(toolName, a, "deny")
    }
  }

  private _writeSessionRule(toolName: string, args: Record<string, unknown>, type: RuleType): void {
    const pattern = inferPattern(toolName, args, this.cwd)
    if (!pattern) {
      this.logRuleRefused(toolName, args, "session", type)
      return
    }
    if (this.sessionRules.some(rule => rule.pattern === pattern && rule.type === type)) return
    this.sessionRules.push({ pattern, type })
    this.logRuleAdded({ pattern, type }, "session", toolName, args)
  }

  /**
   * Persist every approved subcommand as one atomic host-owned project grant.
   */
  addProjectRule(toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): void {
    const rules = inferInvocationRules(toolName, args, this.cwd, context)
    if (!rules.length) { this.logRuleRefused(toolName, args, "project", "allow"); return }
    this.addToolRules(rules, "project")
  }

  /**
   * Deny always — writes a deny rule to .zapcode/settings.local.json (personal, gitignored).
   */
  addProjectDenyRule(toolName: string, args: Record<string, unknown>): void {
    const a = normalizeFileArgs(toolName, args, this.cwd)
    if (toolName === "bash") {
      const subCmds = splitShellSubcommands(String(a.command ?? ""))
      for (const sub of subCmds.slice(0, 5)) {
        this._writeLocalDenyRule(toolName, { ...a, command: sub })
      }
    } else {
      this._writeLocalDenyRule(toolName, a)
    }
    this.merged = loadMergedSettings(this.cwd)
  }

  private _writeLocalDenyRule(toolName: string, args: Record<string, unknown>): void {
    const pattern = inferPattern(toolName, args, this.cwd)
    if (!pattern) {
      this.logRuleRefused(toolName, args, "local", "deny")
      return
    }
    const settingsPath = getProjectLocalSettingsPath(this.cwd)
    const current = loadPermissionSettings(settingsPath)
    if (current.rules.some(r => r.pattern === pattern && r.type === "deny")) return
    current.rules.push({ pattern, type: "deny" })
    savePermissionSettings(settingsPath, current)
    this.logRuleAdded({ pattern, type: "deny" }, "local", toolName, args, settingsPath)
  }

  /** Attribute a rule object to the settings layer it lives in. */
  private locateRuleScope(rule: PermissionRule): RuleScope {
    const findsIt = (p: string) =>
      loadPermissionSettings(p).rules.some(r => r.pattern === rule.pattern && r.type === rule.type)
    if (findsIt(getProjectAuthorizationSettingsPath(this.cwd))) return "project"
    if (findsIt(getProjectLocalSettingsPath(this.cwd))) return "local"
    if (findsIt(getProjectSettingsPath(this.cwd))) return "project"
    if (findsIt(getGlobalSettingsPath())) return "global"
    return "session"
  }

  private logRuleAdded(
    rule: PermissionRule,
    scope: RuleScope,
    toolName: string,
    args: Record<string, unknown>,
    writtenTo?: string,
  ): void {
    this.logger?.log("info", "permission_rule_added", {
      pattern: rule.pattern,
      type: rule.type,
      scope,
      writtenTo,
      triggeredByTool: toolName,
      argsHash: argsFingerprint(args),
    })
  }

  private logRuleRefused(
    toolName: string,
    args: Record<string, unknown>,
    scope: RuleScope,
    type: RuleType,
  ): void {
    this.logger?.log("warn", "permission_rule_refused", {
      reason: "pattern_would_be_unbounded",
      scope,
      type,
      triggeredByTool: toolName,
      argsHash: argsFingerprint(args),
    })
  }

  /**
   * Remove a rule by pattern+type. Searches session, local, project, global in
   * that order and removes from the first layer where it's found. Returns the
   * scope it was removed from, or null if no rule matched. An explicit removal
   * scope targets the displayed group, separating host grants from repo rules.
   */
  removeRule(pattern: string, type: RuleType, scope?: RuleRemovalScope): RuleScope | null {
    if ((!scope || scope === "session") && this.sessionSandboxEscape?.pattern === pattern && this.sessionSandboxEscape.type === type) {
      this.sessionSandboxEscape = undefined
      this.logger?.log("info", "permission_rule_removed", { pattern, type, scope: "session" })
      return "session"
    }
    // Session first (in-memory)
    const sessionIdx = this.sessionRules.findIndex(r => r.pattern === pattern && r.type === type)
    if (sessionIdx >= 0 && (!scope || scope === "session")) {
      this.sessionRules.splice(sessionIdx, 1)
      this.logger?.log("info", "permission_rule_removed", { pattern, type, scope: "session" })
      return "session"
    }
    // Disk layers
    const layers: Array<{ scope: RuleRemovalScope; path: string }> = [
      { scope: "project-grants", path: getProjectAuthorizationSettingsPath(this.cwd) },
      { scope: "local",   path: getProjectLocalSettingsPath(this.cwd) },
      { scope: "project", path: getProjectSettingsPath(this.cwd) },
      { scope: "global",  path: getGlobalSettingsPath() },
    ]
    for (const layer of layers) {
      if (scope && layer.scope !== scope) continue
      const { scope: layerScope, path } = layer
      const settings = loadPermissionSettings(path)
      const idx = settings.rules.findIndex(r => r.pattern === pattern && r.type === type)
      if (idx >= 0) {
        settings.rules.splice(idx, 1)
        savePermissionSettings(path, settings)
        this.merged = loadMergedSettings(this.cwd)
        this.logger?.log("info", "permission_rule_removed", { pattern, type, scope: layerScope, removedFrom: path })
        return layerScope === "project-grants" ? "project" : layerScope
      }
    }
    return null
  }

  /** Return all rule groups by source, for /permissions display. */
  getSummary(): RuleGroup[] {
    const home = homedir()
    const shorten = (p: string) => {
      if (p.startsWith(this.cwd + "/") || p.startsWith(this.cwd + "\\")) return p.slice(this.cwd.length + 1)
      if (p.startsWith(home)) return "~" + p.slice(home.length)
      return p
    }

    const localPath  = getProjectLocalSettingsPath(this.cwd)
    const sharedPath = getProjectSettingsPath(this.cwd)
    const globalPath = getGlobalSettingsPath()

    const authorizationPath = getProjectAuthorizationSettingsPath(this.cwd)
    return [
      { source: shorten(authorizationPath), label: "project grants", rules: loadPermissionSettings(authorizationPath).rules },
      { source: shorten(localPath),  label: "personal",  rules: loadPermissionSettings(localPath).rules  },
      { source: shorten(sharedPath), label: "project",   rules: loadPermissionSettings(sharedPath).rules },
      { source: shorten(globalPath), label: "global",    rules: loadPermissionSettings(globalPath).rules  },
      { source: "session",           label: "session",   rules: [...this.sessionRules, ...(this.sessionSandboxEscape ? [this.sessionSandboxEscape] : [])] },
    ].filter(g => g.rules.length > 0)
  }

  /** Annotate fully covered rules using decision priority, then source order. */
  getSummaryAnnotated(): AnnotatedRuleGroup[] {
    const groups = this.getSummary()
    const scopeOf = (label: string): RuleScope =>
      label === "personal" ? "local" :
      (label === "project" || label === "project grants") ? "project" :
      label === "global"   ? "global" : "session"

    // Build check-order list: session first, then local, project, global.
    const checkOrder: Array<{ rule: PermissionRule; scope: RuleScope }> = []
    const sessionGroup = groups.find(g => g.label === "session")
    if (sessionGroup) for (const r of sessionGroup.rules) checkOrder.push({ rule: r, scope: "session" })
    for (const label of ["project grants", "personal", "project", "global"] as const) {
      const g = groups.find(gr => gr.label === label)
      if (g) for (const r of g.rules) checkOrder.push({ rule: r, scope: scopeOf(label) })
    }

    checkOrder.sort((a, b) => ["deny", "ask", "allow"].indexOf(a.rule.type) - ["deny", "ask", "allow"].indexOf(b.rule.type))

    // Object identity distinguishes equal rules in different storage groups.
    const shadowMap = new Map<PermissionRule, { rule: PermissionRule; scope: RuleScope }>()
    for (let i = 0; i < checkOrder.length; i++) {
      const cur = checkOrder[i]
      for (let j = 0; j < i; j++) {
        const earlier = checkOrder[j]
        if (patternCovers(earlier.rule.pattern, cur.rule.pattern)) {
          shadowMap.set(cur.rule, earlier)
          break
        }
      }
    }

    return groups.map(g => ({
      source: g.source,
      label: g.label,
      rules: g.rules.map<AnnotatedRule>(r => {
        if (r.pattern === SANDBOX_ESCAPE_RULE) {
          return g.label === "project grants" && r.type === "allow" && this.sessionSandboxEscape && this.checkSandboxEscape().scope === "session"
            ? { rule: r, shadowedBy: { rule: this.sessionSandboxEscape, scope: "session" } } : { rule: r }
        }
        const shadowedBy = shadowMap.get(r)
        return shadowedBy ? { rule: r, shadowedBy } : { rule: r }
      }),
    }))
  }

  reload(): void {
    this.merged = loadMergedSettings(this.cwd)
  }

}
