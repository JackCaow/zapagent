/**
 * Slash commands for ZapCode TUI
 */

export interface CommandResult {
  type:
    | "output"
    | "clear"
    | "exit"
    | "new_session"
    | "copy"
    | "copy_input"
    | "compact_session"
    | "open_update"
    | "open_connect"
    | "open_model_picker"
    | "set_model"
    | "open_sessions"
    | "open_queue"
    | "open_serper"
    | "open_mcp"
    | "init_project"
    | "review"
    | "commit"
    | "supertask"
    | "supertask_resume"
    | "supertask_abort"
    | "supertask_status"
    | "supertask_watch"
    | "run_skill"
    | "show_permissions"
    | "open_mode_picker"
    | "set_permission_mode"
    | "clear_todos"
    | "open_rewind"
    | "open_recovery"
    | "set_effort"
    | "open_mem"
    | "show_status"
  text?: string
  value?: string
  skill?: string
  skillInput?: string
  skillParams?: Record<string, string>
  /** /supertask only: optional caps overriding the defaults baked into
   *  generateRalphArtifacts. Positive integers when set. */
  maxIter?: number
  maxTurns?: number
}

/** Parse `--key value` / `--key=value` numeric flags out of a /supertask
 *  argument string and return both the cleaned description and the captured
 *  values. Unknown flags are left in the description for the agent to see.
 *  Exported for unit tests. */
export function parseSupertaskFlags(input: string): {
  desc: string
  maxIter?: number
  maxTurns?: number
} {
  let desc = input
  let maxIter: number | undefined
  let maxTurns: number | undefined
  const flagRe = /(?:^|\s)--(max-iter|max-turns|iter|turns)(?:=|\s+)(\d+)(?=\s|$)/g
  desc = desc.replace(flagRe, (_match, key: string, val: string) => {
    const n = parseInt(val, 10)
    if (!Number.isFinite(n) || n <= 0) return _match // leave malformed alone
    if (key === "max-iter" || key === "iter") maxIter = n
    else if (key === "max-turns" || key === "turns") maxTurns = n
    return " " // collapse swallowed flag to a single space; trim later
  })
  desc = desc.replace(/\s+/g, " ").trim()
  return { desc, maxIter, maxTurns }
}

export function parseCommand(input: string): CommandResult | null {
  if (!input.startsWith("/")) return null

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.slice(1))
  if (!match?.[1]) return null
  const cmd = match[1].toLowerCase()
  const rest = match[2] ?? ""

  switch (cmd) {
    case "update": return { type: "open_update" }
    case "help":
      return {
        type: "output",
        text: [
          "⚡ zapAgent Commands:",
          "",
          "  Built-in:",
          "  /update          — Confirm download, installation and restart",
          "  /review [path]   — Review code for bugs & security",
          "  /commit          — Stage changes and create a commit",
          "  /init            — Analyze project and generate AGENTS.md",
          "  /supertask <desc> [--max-turns N] [--max-iter N]",
          "                          — Long-horizon orchestrated task (defaults: 80 turns, 30 iters)",
          "  /supertask resume       — Continue the most recent unfinished supertask",
          "  /supertask resume force — Kill the live runner and respawn fresh",
          "  /supertask abort        — Discard the current supertask state",
          "  /supertask status       — Show queue + iteration count without invoking the agent",
          "  /supertask watch        — Live progress TUI (auto-refreshes every 1.5s)",
          "",
          "  Skills (loaded from ~/.agents/skills/):",
          "  /<name> [args]   — Run any installed skill",
          "",
          "  Permissions:",
          "  /permissions     — Manage active permission rules (interactive)",
          "  /mode [name]     — Set permission mode (default | acceptEdits | plan | bypass)",
          "",
          "  Todos:",
          "  /todos [on|off]   — Show or hide the todo panel",
          "  /todos clear      — Clear the current todo list",
          "",
          "  Settings:",
          "  /mcp             — Manage MCP servers",
          "  /connect         — Set up provider & API key",
          "  /model [name]    — Show or switch model",
          "  /effort [value]  — Set reasoning_effort (off | cycle | <value>)",
          "  /mem             — Browse memory (list/show/forget)",
          "  /sessions        — Browse saved sessions",
          "  /queue           — Manage follow-up messages and Queue/Steer defaults",
          "  /rewind          — Revert files/conversation to a previous turn",
          "  /recovery        — Recover interrupted agents, artifacts, and workspaces",
          "  /serper          — Set Serper web search API key",
          "  /new             — Start a new session",
          "  /compact         — Compress conversation context",
          "  /status          — Show session snapshot (provider, ctx, MCP, ...)",
          "  /clear           — Clear the screen",
          "  /copy            — Copy last output to clipboard",
          "  /copy-input      — Copy last user input to clipboard",
          "  /help            — Show this help",
          "  /exit            — Quit zapAgent",
          "",
          "  Or just type any task in natural language.",
        ].join("\n"),
      }

    case "mcp":
      // `/mcp` (no args)               → show summary
      // `/mcp <subcommand> [args...]`  → dispatch (list/status/tools/...)
      return { type: "open_mcp", value: rest.trim() }

    case "connect":
      return { type: "open_connect" }

    case "model":
      if (!rest) return { type: "open_model_picker" }
      return { type: "set_model", value: rest }

    case "effort":
      // `/effort`         → show current + next value (preview)
      // `/effort <value>` → set explicitly (must be in provider's effortValues, or "off")
      // `/effort cycle`   → advance one step in the cycle
      return { type: "set_effort", value: rest.trim() }

    case "mem":
      return { type: "open_mem" }

    case "sessions":
      return { type: "open_sessions" }

    case "queue":
      return { type: "open_queue" }

    case "rewind":
      return { type: "open_rewind" }

    case "recovery":
      return { type: "open_recovery" }

    case "serper":
      return { type: "open_serper" }

    case "new":
      return { type: "new_session" }

    case "compact":
      return { type: "compact_session" }

    case "status":
      return { type: "show_status" }

    case "clear":
      return { type: "clear" }

    case "copy":
      return { type: "copy" }

    case "copy-input":
    case "copyinput":
      return { type: "copy_input" }

    case "exit":
    case "quit":
    case "q":
      return { type: "exit" }

    // ─── Permissions ───
    case "permissions":
      return { type: "show_permissions", value: rest.trim() }

    case "mode":
      if (!rest.trim()) return { type: "open_mode_picker" }
      return { type: "set_permission_mode", value: rest.trim() }

    // ─── Todos ───
    case "todos": {
      if (rest.trim().toLowerCase() === "clear") return { type: "clear_todos" }
      // bare `/todos` or `/todos <other>` — fall through to skill resolution
      return { type: "run_skill", skill: cmd, skillInput: rest || cmd }
    }

    // ─── Built-in ───
    case "review":
      return { type: "review", value: rest || "." }

    case "commit":
      return { type: "commit" }

    case "init":
      return { type: "init_project" }

    case "supertask": {
      const trimmed = rest.trim()
      if (trimmed === "resume") return { type: "supertask_resume" }
      if (trimmed === "resume force") return { type: "supertask_resume", value: "force" }
      if (trimmed === "abort") return { type: "supertask_abort" }
      if (trimmed === "abort confirm") return { type: "supertask_abort", value: "confirm" }
      if (trimmed === "status") return { type: "supertask_status" }
      if (trimmed === "watch") return { type: "supertask_watch" }
      if (!trimmed) {
        return {
          type: "output",
          text: [
            "Usage:",
            "  /supertask <desc> [--max-turns N] [--max-iter N]",
            "                          — start a new long-horizon supertask",
            "                            (defaults: --max-turns 80, --max-iter 30)",
            "  /supertask resume       — continue the most recent unfinished one",
            "                            (no-op if runner is still alive)",
            "  /supertask resume force — kill the live runner and respawn fresh",
            "  /supertask abort        — discard the current supertask state",
            "  /supertask status       — show queue without invoking the agent",
            "  /supertask watch        — live TUI of progress (auto-refreshes)",
          ].join("\n"),
        }
      }
      const { desc, maxIter, maxTurns } = parseSupertaskFlags(trimmed)
      if (!desc) {
        return {
          type: "output",
          text: "/supertask needs a description (flags don't count). Try `/supertask <desc> [--max-turns N] [--max-iter N]`.",
        }
      }
      return { type: "supertask", value: desc, maxIter, maxTurns }
    }

    default:
      // All other commands → dynamically matched against loaded skills
      return { type: "run_skill", skill: cmd, skillInput: rest || cmd }
  }
}
