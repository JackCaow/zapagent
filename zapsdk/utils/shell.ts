/**
 * Shell command parsing utilities shared between the bash tool executor
 * and the permission rule engine.
 */

/**
 * Split a shell command string into individual subcommands on the operators
 * ; && || | and unquoted newlines, while respecting quotes, backticks, and $(...) subshells.
 *
 * Examples:
 *   "git status && npm test"       → ["git status", "npm test"]
 *   "echo foo; echo bar"           → ["echo foo", "echo bar"]
 *   "python test.py 2>&1"          → ["python test.py 2>&1"]   (& not a separator)
 *   "curl $(cat url.txt) && echo"  → ["curl $(cat url.txt)", "echo"]
 *   "$(git status && npm test)"    → ["$(git status && npm test)"]  (inner && not split)
 *   "echo 'a && b'"                → ["echo 'a && b'"]              (quoted && not split)
 */
type ShellSyntax = "posix" | "cmd" | "unknown"
const hostShellSyntax: ShellSyntax = process.platform === "win32" ? "cmd" : "posix"

export function splitShellSubcommands(command: string, syntax: ShellSyntax = hostShellSyntax): string[] {
  const subCommands: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let parenDepth = 0  // tracks $(...) and (...) subshell nesting

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === "\\" && !inSingle) {
      current += ch
      if (i + 1 < command.length) current += command[++i]
      continue
    }
    if (ch === "<" && command[i + 1] === "<" && !inSingle && !inDouble && !inBacktick) {
      return [...subCommands, (current + command.slice(i)).trim()].filter(Boolean)
    }
    if (ch === "#" && !inSingle && !inDouble && !inBacktick && parenDepth === 0 && (!current || /\s$/.test(current))) {
      while (i < command.length && command[i] !== "\n") i++
      if (current.trim()) subCommands.push(current.trim())
      current = ""
      continue
    }

    if (ch === "'" && !inDouble && !inBacktick && parenDepth === 0) {
      inSingle = !inSingle; current += ch
    } else if (ch === '"' && !inSingle && !inBacktick && parenDepth === 0) {
      inDouble = !inDouble; current += ch
    } else if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick; current += ch
    } else if (ch === "(" && !inSingle && !inDouble && !inBacktick) {
      parenDepth++; current += ch
    } else if (ch === ")" && !inSingle && !inDouble && !inBacktick && parenDepth > 0) {
      parenDepth--; current += ch
    } else if (!inSingle && !inDouble && !inBacktick && parenDepth === 0 && /[;&|\r\n]/.test(ch)) {
      // Skip & that is part of a redirection like 2>&1 or >&2
      if (ch === "&" && current.match(/[>0-9]$/)) { current += ch; continue }
      if (current.trim()) subCommands.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) subCommands.push(current.trim())
  return subCommands
}

/** This splitter does not resolve execution hidden in substitutions or shell
 * control structures. Such calls need whole-tool consent rather than a prefix grant. */
export function requiresShellReview(command: string, syntax: ShellSyntax = hostShellSyntax): boolean {
  return splitShellSubcommands(command, syntax).some(requiresShellSegmentReview)
}

function requiresShellSegmentReview(command: string): boolean {
  let single = false, double = false, visible = ""
  for (let index = 0; index < command.length; index++) {
    const ch = command[index]
    if (single) { if (ch === "'") single = false; continue }
    if (ch === "\\") { index++; visible += " "; continue }
    if (ch === '"') { double = !double; visible += " "; continue }
    if (!double && ch === "'") { single = true; visible += " "; continue }
    if (ch === "`" || (ch === "$" && command[index + 1] === "(")) return true
    if (double) continue
    if (ch === "#" && (index === 0 || /[\s;&|]/.test(command[index - 1]))) {
      while (index < command.length && command[index] !== "\n") index++
      visible += "\n"; continue
    }
    if (ch === "(" || ch === ")" || (ch === "<" && command[index + 1] === "<")) return true
    visible += ch
  }
  return single || double || /(?:^|[;&|\r\n])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]*|time(?:\s+-p)?)\s+)*(?:(?:if|then|elif|else|for|while|until|case|select|function|do|coproc|eval|source|builtin|command)\b|exec\s+-(?!-)|!(?:\s|$)|\.(?:\s|$))/.test(visible)
    || /(?:^|[;&|\r\n])\s*\{(?:\s|$)/.test(visible)
}

/** Canonical display for raw model calls and normalized execution arguments. */
export function shellCommandDisplay(args: Record<string, unknown>): string {
  if (args.command !== undefined) return String(args.command);
  const steps = args.check_steps;
  return Array.isArray(steps) && steps.length > 0 && steps.every(step => typeof step === "string" && step.length > 0)
    ? steps.map(step => `(${step})`).join(" && ") : String(args.cmd ?? "");
}

/** Actual shell invocations for a structured check. Permission and exclusion
 * matching must inspect each step, rather than treating the display command's
 * parentheses as an opaque subcommand. Invalid declarations execute nothing. */
export function shellExecutionCommands(args: Record<string, unknown>): string[] {
  const steps = args.check_steps;
  if (Array.isArray(steps) && steps.length > 0 && steps.every((step) => typeof step === "string" && step.length > 0)
    && (args.command === undefined || args.command === steps.map((step) => `(${step})`).join(" && "))) return steps;
  return [String(args.command ?? "")];
}

/**
 * Bash pattern matcher. Two supported forms:
 *
 *   1. Colon-suffixed prefix (preferred, Claude Code compat):
 *        "git log:*"     → matches `git log` followed by anything (or nothing)
 *        "git commit:*"  → matches `git commit ...`
 *      The `:*` marks the boundary between command prefix and its args.
 *
 *   2. Legacy glob:
 *        "git *"         → traditional shell-style wildcard (kept for existing
 *                          settings.json files; still works but is less precise).
 *
 * Both forms are anchored to full-string match.
 */
export function matchCommandGlob(subject: string, pattern: string): boolean {
  // Form 1: prefix:*  — the `:` is a literal separator, strip it and require
  // the subject to start with the prefix optionally followed by whitespace+args.
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2)
    const escaped = prefix.replace(/[.+^${}()|[\]\\:*?]/g, "\\$&")
    return new RegExp(`^${escaped}(?:\\s+.*)?$`).test(subject)
  }
  // Form 2: legacy glob
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\:]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${regexStr}$`).test(subject)
}

/** True when `command`, or any of its subcommands, matches one of the patterns
 *  (same two forms as bash permission rules). The whole string is tested too so
 *  an indirect launch such as `CH="/Applications/X.app/..." && "$CH" --flag`
 *  still matches a pattern naming the path. */
export function matchesAnyCommandPattern(command: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length) return false
  const subjects = [command.trim(), ...splitShellSubcommands(command)]
  return patterns.some((pattern) => subjects.some((subject) => matchCommandGlob(subject, pattern)))
}
