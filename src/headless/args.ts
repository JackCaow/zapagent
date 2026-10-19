// Argv parser for zap's non-interactive (headless) mode. Hand-rolled to
// avoid pulling in a parser dependency — the surface is small and stable.
//
// Accepts:
//   -p, --print <text>           prompt string
//   --permission-mode <mode>     default | acceptEdits | bypassPermissions | plan
//   --result-schema <schema>      outcome-v1 (default) | legacy
//   --output-format <fmt>        text | json | stream-json
//   --max-turns <n>              integer cap
//   --timeout-ms <n>              wall-clock run budget; reserves final synthesis time
//   --continue-on-tool-denial    keep a completed run gradeable after a denied tool
//   -c, --continue               resume last session
//   --session-id <id>            explicit session id (read or write)
//   --model <id>                 override active model for this run
//   --service-owner <path>        Connect to an independently started Host service owner
//   --result-source-policy <p>   Host JSON policy for source-bearing tool results
//   --system-prompt-append <s>   append to default system prompt
//   --system-prompt-prepend <s>  prepend before default system prompt
//   --allowed-tools <csv>        comma-separated tool names to allow
//   --disallowed-tools <csv>     comma-separated tool names to block
//   --cwd <dir>                  override working directory
//   --dangerously-disable-os-sandbox
//                                trust an existing outer sandbox (CI/evals only)
//   --no-devtools                force-skip ZAPCODE_DEVTOOLS_PORT (default)
//   --quiet                      suppress stderr progress (text mode only)
//
// Any positional arg before flags is treated as the prompt (unless -p was
// given). Multiple positionals are joined with spaces.

import type { PermissionMode } from "../config.js"
import { isValidSessionId } from "../utils/session-id.js"

export type ResultSchema = "outcome-v1" | "legacy"

export type OutputFormat = "text" | "json" | "stream-json"

export interface HeadlessArgs {
  prompt: string
  permissionMode: PermissionMode
  outputFormat: OutputFormat
  resultSchema?: ResultSchema
  maxTurns?: number
  /** Self-managed wall-clock cap for this run. The loop reserves its final
   * synthesis window instead of waiting for an outer evaluator to kill it. */
  timeoutMs?: number
  /** Explicit declarative public acceptance and bounded repair configuration. */
  publicChecks?: string
  /** Explicit Host policy applied before tool results enter model history. */
  resultSourcePolicy?: string
  /** Explicit Host descriptor for an independently started local owner. */
  serviceOwner?: string
  /** Preserve a denied tool result in the transcript but do not turn an
   * otherwise completed run into process exit 4. Intended for evaluators,
   * where the verifier is the authority on whether the denial was material. */
  continueOnToolDenial: boolean
  continueLast: boolean
  sessionId?: string
  model?: string
  systemPromptAppend?: string
  systemPromptPrepend?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  cwd?: string
  quiet: boolean
  /** Run process tools without Zap's OS sandbox. Policy approvals and tool
   *  path checks still apply. Intended only for disposable outer sandboxes
   *  such as Terminal-Bench/Harbor containers. */
  dangerouslyDisableOsSandbox: boolean
  /** When true, suppress DevTools server startup even if ZAPCODE_DEVTOOLS_PORT
   *  is set. Headless runs already skip the bootstrap call in index.tsx; this
   *  flag is a parser-level escape hatch in case the env var was set in a
   *  parent shell and shouldn't apply to scripts. */
  noDevtools: boolean
}

export interface ParseResult {
  ok: true
  args: HeadlessArgs
}
export interface ParseError {
  ok: false
  message: string
}

function isPermissionMode(s: string): s is PermissionMode {
  return s === "default" || s === "acceptEdits" || s === "bypassPermissions" || s === "plan"
}

function isOutputFormat(s: string): s is OutputFormat {
  return s === "text" || s === "json" || s === "stream-json"
}

function splitCsv(s: string): string[] {
  return s.split(",").map(x => x.trim()).filter(Boolean)
}

const KNOWN_FLAGS = new Set([
  "-p",
  "--print",
  "--permission-mode",
  "--output-format",
  "--result-schema",
  "--max-turns",
  "--timeout-ms",
  "--public-checks",
  "--result-source-policy",
  "--service-owner",
  "--continue-on-tool-denial",
  "--dev",
  "--help-headless",
  "--no-devtools",
  "-c",
  "--continue",
  "--session-id",
  "--model",
  "--system-prompt-append",
  "--system-prompt-prepend",
  "--allowed-tools",
  "--disallowed-tools",
  "--cwd",
  "--dangerously-disable-os-sandbox",
  "--quiet",
])

/** Parse argv tail (everything after `zap`). Returns either parsed args
 *  or a structured error suitable for printing to stderr + exit(2). */
export function parseHeadlessArgs(argv: readonly string[]): ParseResult | ParseError {
  const positionals: string[] = []
  let prompt: string | undefined
  let promptSeen = false  // distinguishes -p "" (explicit empty) from absent -p
  let permissionMode: PermissionMode = "default"
  let outputFormat: OutputFormat = "text"
  let resultSchema: ResultSchema = "outcome-v1"
  let resultSchemaSeen = false
  let maxTurns: number | undefined
  let timeoutMs: number | undefined
  let publicChecks: string | undefined
  let resultSourcePolicy: string | undefined
  let serviceOwner: string | undefined
  let continueOnToolDenial = false
  let continueLast = false
  let sessionId: string | undefined
  let model: string | undefined
  let systemPromptAppend: string | undefined
  let systemPromptPrepend: string | undefined
  let allowedTools: string[] | undefined
  let disallowedTools: string[] | undefined
  let cwd: string | undefined
  let quiet = false
  let dangerouslyDisableOsSandbox = false
  let noDevtools = false

  const take = (i: number, flag: string, opts: { allowFlagLikeValue?: boolean } = {}): string | ParseError => {
    const v = argv[i + 1]
    if (v === undefined) return { ok: false, message: `${flag} requires a value` }
    // For structured flags, reject another flag as the value (e.g.
    // `--model --quiet`). Free-form text flags allow dash-prefixed values
    // because prompts and system-prompt appendices commonly start with bullets
    // like "- fix ...", but still reject known flag names so `-p --quiet`
    // reports a missing prompt instead of silently using "--quiet" as text.
    // Numeric values that start with `-` are passed through so --max-turns can
    // report the more specific "must be positive" error downstream.
    if (
      v.startsWith("-") &&
      !/^-?\d/.test(v) &&
      (!opts.allowFlagLikeValue || KNOWN_FLAGS.has(v))
    ) {
      return { ok: false, message: `${flag} requires a value` }
    }
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "-p":
      case "--print": {
        if (promptSeen) return { ok: false, message: `${a} given more than once — the prompt is ambiguous` }
        const v = take(i, a, { allowFlagLikeValue: true }); if (typeof v !== "string") return v
        prompt = v; promptSeen = true; i++; break
      }
      case "--permission-mode": {
        const v = take(i, a); if (typeof v !== "string") return v
        if (!isPermissionMode(v)) return { ok: false, message: `invalid --permission-mode: ${v}` }
        permissionMode = v; i++; break
      }
      case "--output-format": {
        const v = take(i, a); if (typeof v !== "string") return v
        if (!isOutputFormat(v)) return { ok: false, message: `invalid --output-format: ${v}` }
        outputFormat = v; i++; break
      }
      case "--result-schema": {
        const v = take(i, "--result-schema"); if (typeof v !== "string") return v
        if (v !== "outcome-v1" && v !== "legacy") return { ok: false, message: `invalid --result-schema: ${v}` }
        if (resultSchemaSeen && resultSchema !== v) return { ok: false, message: "conflicting --result-schema values" }
        resultSchema = v; resultSchemaSeen = true; i++; break
      }
      case "--max-turns": {
        const v = take(i, a); if (typeof v !== "string") return v
        const n = Number(v)
        if (!Number.isInteger(n) || n <= 0) return { ok: false, message: `--max-turns must be a positive integer, got: ${v}` }
        maxTurns = n; i++; break
      }
      case "--timeout-ms": {
        const v = take(i, a); if (typeof v !== "string") return v
        const n = Number(v)
        if (!Number.isInteger(n) || n <= 0) return { ok: false, message: `--timeout-ms must be a positive integer, got: ${v}` }
        timeoutMs = n; i++; break
      }
      case "--service-owner": {
        const v = take(i, a); if (typeof v !== "string") return v
        if (serviceOwner !== undefined || !v.trim()) return { ok: false, message: "--service-owner requires one nonempty descriptor path" }
        serviceOwner = v; i++; break
      }
      case "--result-source-policy": {
        const v = take(i, a); if (typeof v !== "string") return v
        if (resultSourcePolicy !== undefined || !v.trim()) return { ok: false, message: "--result-source-policy requires one nonempty path" }
        resultSourcePolicy = v; i++; break
      }
      case "--public-checks": {
        const v = take(i, "--public-checks"); if (typeof v !== "string") return v
        if (publicChecks !== undefined || !v.trim()) return { ok: false, message: "--public-checks requires one nonempty path" }
        publicChecks = v; i++; break
      }
      case "--continue-on-tool-denial": {
        continueOnToolDenial = true; break
      }
      case "--no-devtools": {
        noDevtools = true; break
      }
      case "-c":
      case "--continue": {
        continueLast = true; break
      }
      case "--session-id": {
        const v = take(i, a); if (typeof v !== "string") return v
        if (!isValidSessionId(v)) {
          return { ok: false, message: "--session-id must be a valid session id, not a path" }
        }
        sessionId = v; i++; break
      }
      case "--model": {
        const v = take(i, a); if (typeof v !== "string") return v
        model = v; i++; break
      }
      case "--system-prompt-append": {
        const v = take(i, a, { allowFlagLikeValue: true }); if (typeof v !== "string") return v
        systemPromptAppend = v; i++; break
      }
      case "--system-prompt-prepend": {
        const v = take(i, a, { allowFlagLikeValue: true }); if (typeof v !== "string") return v
        systemPromptPrepend = v; i++; break
      }
      case "--allowed-tools": {
        const v = take(i, a); if (typeof v !== "string") return v
        allowedTools = splitCsv(v); i++; break
      }
      case "--disallowed-tools": {
        const v = take(i, a); if (typeof v !== "string") return v
        disallowedTools = splitCsv(v); i++; break
      }
      case "--cwd": {
        const v = take(i, a); if (typeof v !== "string") return v
        cwd = v; i++; break
      }
      case "--quiet": {
        quiet = true; break
      }
      case "--dangerously-disable-os-sandbox": {
        dangerouslyDisableOsSandbox = true; break
      }
      default: {
        if (a.startsWith("-")) return { ok: false, message: `unknown flag: ${a}` }
        positionals.push(a)
      }
    }
  }

  if (promptSeen && positionals.length > 0) {
    return { ok: false, message: "positional prompt text cannot be combined with -p/--print" }
  }

  if (continueLast && sessionId !== undefined) {
    return { ok: false, message: "--continue cannot be combined with --session-id" }
  }

  if (prompt === undefined && positionals.length > 0) prompt = positionals.join(" ")

  if (prompt === undefined) {
    return { ok: false, message: "no prompt provided (use -p <text>, a positional arg, or pipe stdin)" }
  }
  // -p "" passes through `prompt !== undefined` because the empty string is
  // still "defined". Reject it explicitly — an empty prompt would either
  // 400 from the provider or generate noise, neither helpful for a script.
  if (prompt.trim() === "") {
    return { ok: false, message: "prompt is empty (after trimming whitespace)" }
  }

  return {
    ok: true,
    args: {
      prompt,
      permissionMode,
      outputFormat,
      resultSchema,
      maxTurns,
      timeoutMs,
      publicChecks,
      resultSourcePolicy,
      serviceOwner,
      continueOnToolDenial,
      continueLast,
      sessionId,
      model,
      systemPromptAppend,
      systemPromptPrepend,
      allowedTools,
      disallowedTools,
      cwd,
      quiet,
      dangerouslyDisableOsSandbox,
      noDevtools,
    },
  }
}

/** Max bytes accepted from a piped stdin. ~16 MB is enormous for a prompt
 *  — larger inputs almost always indicate a script mistake (e.g. piping a
 *  binary or a runaway log tail). Beyond this we abort cleanly rather than
 *  buffer indefinitely. */
const STDIN_MAX_BYTES = 16 * 1024 * 1024
/** How long to wait for the first byte from a piped stdin before assuming
 *  the producer is hung. Once data starts flowing, no further timeout —
 *  reads continue until EOF or the size cap trips. */
const STDIN_FIRST_BYTE_TIMEOUT_MS = 5000

/** Read all of stdin synchronously-ish. Returns "" if stdin is a TTY.
 *  Guards: 16 MB hard cap, 5s first-byte timeout. Both surface as a thrown
 *  Error rather than silent truncation / hang so the caller can exit cleanly. */
export async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return ""
  const chunks: Buffer[] = []
  let total = 0
  let firstByteSeen = false
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!firstByteSeen) {
        process.stdin.removeListener("data", onData)
        process.stdin.removeListener("end", onEnd)
        process.stdin.removeListener("error", onErr)
        reject(new Error(`no input on stdin within ${STDIN_FIRST_BYTE_TIMEOUT_MS}ms`))
      }
    }, STDIN_FIRST_BYTE_TIMEOUT_MS)
    const onData = (chunk: string | Buffer) => {
      firstByteSeen = true
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      total += buf.length
      if (total > STDIN_MAX_BYTES) {
        clearTimeout(timer)
        process.stdin.removeListener("data", onData)
        process.stdin.removeListener("end", onEnd)
        process.stdin.removeListener("error", onErr)
        reject(new Error(`stdin exceeded ${STDIN_MAX_BYTES} bytes — refusing to buffer further`))
        return
      }
      chunks.push(buf)
    }
    const onEnd = () => {
      clearTimeout(timer)
      process.stdin.removeListener("data", onData)
      process.stdin.removeListener("error", onErr)
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const onErr = (err: Error) => {
      clearTimeout(timer)
      process.stdin.removeListener("data", onData)
      process.stdin.removeListener("end", onEnd)
      reject(err)
    }
    process.stdin.on("data", onData)
    process.stdin.once("end", onEnd)
    process.stdin.once("error", onErr)
  })
}

export const HEADLESS_HELP = `
zap non-interactive mode

Usage:
  zap -p <prompt> [options]
  zap "<prompt>" [options]
  echo "<prompt>" | zap [options]

Options:
  --watch                      Open the real-time local runtime viewer
  --watch-port <n>              Local port (0 selects an available port)
  --watch-no-open               Print viewer URL without opening a browser
  --watch-linger <s>            Retain the viewer after completion (0..300)
  -p, --print <text>            Prompt to send (alternative: positional / stdin pipe)
  --permission-mode <mode>      default | acceptEdits | bypassPermissions | plan
                                (default: 'default' — any non-allowed tool is denied)
  --result-schema <schema>      outcome-v1 (default) | legacy
  --output-format <fmt>         text (default) | json | stream-json
  --max-turns <n>               Max agent steps
  --timeout-ms <n>              Self-managed wall-clock run budget in milliseconds
  --public-checks <json>        Explicit public file checks and bounded repair budget
  --continue-on-tool-denial     Keep a completed run gradeable after a denied tool (evaluators)
  -c, --continue                Resume the last session
  --session-id <id>             Use a specific session id
  --model <id>                  Override active model
  --service-owner <path>        Connect to an independently started Host service owner
  --result-source-policy <p>   Host JSON policy for source-bearing tool results
  --system-prompt-append <s>    Append text to the default system prompt
  --allowed-tools <csv>         Comma-separated tool names to allow
  --disallowed-tools <csv>      Comma-separated tool names to block
  --cwd <dir>                   Run in a different working directory
  --dangerously-disable-os-sandbox
                                Disable Zap's OS sandbox (disposable outer sandboxes only)
  --quiet                       Suppress stderr progress (text mode)
  --no-devtools                 Force-skip ZAPCODE_DEVTOOLS_PORT (env var)

Exit codes:
  0   ok                        2  bad args
  1   error                     3  no provider configured (run 'zap' interactive once)
  4   permission denied         130  interrupted
`.trim()
