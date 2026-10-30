/** @jsxImportSource react */
// Slash command palette — popup shown beneath the prompt when the user
// types "/...". Filters the curated command list by prefix, supports
// arrow-key navigation + Enter to autocomplete the input.
//
// Why a flat array of {name, desc} instead of generating from commands.ts:
//   commands.ts dispatches keywords (one slash → one CommandResult), but
//   `/<skill>` is a wildcard that matches any installed skill name. We
//   want the palette to show curated built-ins prominently and skills
//   below — that's a UI concern, kept here.
import { Box, Text } from "ink"
import { c } from "./theme.js"

export interface SlashEntry {
  name: string   // includes leading "/"
  desc: string
}

export const BUILTIN_COMMANDS: SlashEntry[] = [
  { name: "/update",      desc: "Download, install and restart after confirmation" },
  { name: "/help",        desc: "Show command reference" },
  { name: "/connect",     desc: "Set up provider & API key" },
  { name: "/model",       desc: "Show or switch model" },
  { name: "/effort",      desc: "Set reasoning effort (off | cycle | <value>)" },
  { name: "/mode",        desc: "Permission mode (default | acceptEdits | plan | bypass)" },
  { name: "/permissions", desc: "Manage active permission rules" },
  { name: "/sessions",    desc: "Browse saved sessions" },
  { name: "/queue",       desc: "Manage follow-up messages · Queue / Steer" },
  { name: "/rewind",      desc: "Revert files / conversation to a previous turn" },
  { name: "/mem",         desc: "Browse memory (list / show / forget)" },
  { name: "/mcp",         desc: "Manage MCP servers" },
  { name: "/serper",      desc: "Set Serper web search API key" },
  { name: "/todos",       desc: "Show/hide todo panel · /todos clear" },
  { name: "/compact",     desc: "Summarize and compact conversation" },
  { name: "/status",      desc: "Session snapshot — provider, context, MCP" },
  { name: "/new",         desc: "Start a new session" },
  { name: "/clear",       desc: "Clear the screen" },
  { name: "/copy",        desc: "Copy last output to clipboard" },
  { name: "/copy-input",  desc: "Copy last user input to clipboard" },
  { name: "/review",      desc: "Review code for bugs & security" },
  { name: "/commit",      desc: "Stage changes and create a commit" },
  { name: "/init",        desc: "Generate AGENTS.md for this project" },
  { name: "/goal",        desc: "Goal in this session · --background | status | pause | resume | cancel" },
  { name: "/supertask",   desc: "Long-horizon orchestrated task · resume | abort | status | watch" },
  { name: "/exit",        desc: "Quit zapAgent" },
]

const VISIBLE_ROWS = 12

// Layout — fixed columns so long skill names (e.g.
// "/finishing-a-development") don't push descriptions off the row, and so
// names shorter than the column don't lose their separator space.
const NAME_COL_CHARS = 22
const DESC_COL_CHARS = 78

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + "…"
}

function padOrClip(s: string, width: number): string {
  if (s.length >= width) return clip(s, width)
  return s + " ".repeat(width - s.length)
}

/**
 * Filter the palette. Two-tier strategy to keep the default view focused
 * while still letting the user reach any aggregated skill via prefix
 * search:
 *
 *   - **Bare `/`** (no query yet): show BUILTIN + primary only. Secondary
 *     skills (codex-cache aggregated) are hidden — they'd otherwise add
 *     30+ rows to the palette every time the user opens it.
 *   - **`/<q>`** (has filter chars): both primary AND secondary
 *     participate. User typed something, so we know they're looking for
 *     a specific match — full surface area is the right move.
 */
export function filterCommands(
  input: string,
  primary: SlashEntry[] = [],
  secondary: SlashEntry[] = [],
): SlashEntry[] {
  if (!input.startsWith("/")) return []
  const q = input.slice(1).toLowerCase()
  if (!q) return [...BUILTIN_COMMANDS, ...primary]
  const all = [...BUILTIN_COMMANDS, ...primary, ...secondary]
  // Prefix match first, then substring — keeps `/co` from showing `/connect`
  // below `/copy` etc.
  const prefix: SlashEntry[] = []
  const sub: SlashEntry[] = []
  for (const e of all) {
    const name = e.name.slice(1).toLowerCase()
    if (name.startsWith(q)) prefix.push(e)
    else if (name.includes(q)) sub.push(e)
  }
  return [...prefix, ...sub]
}

interface Props {
  entries: SlashEntry[]
  selected: number
}

export function SlashPalette({ entries, selected }: Props) {
  if (entries.length === 0) return null
  // Window the list around the selection so the palette stays at most
  // VISIBLE_ROWS tall. Bumped from 4 → 12 (2026-05-21) so the common
  // builtin commands are all visible without scrolling. No N/M footer
  // anymore — the windowed scroll happens silently when overflowing.
  let start = 0
  if (entries.length > VISIBLE_ROWS) {
    start = Math.max(0, Math.min(selected - Math.floor(VISIBLE_ROWS / 2), entries.length - VISIBLE_ROWS))
  }
  const window = entries.slice(start, start + VISIBLE_ROWS)
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {window.map((e, i) => {
        const idx = start + i
        const active = idx === selected
        // Active row paints both name and desc in accent green so the
        // selection reads as a single highlighted band, not "left half
        // green / right half white". Inactive rows keep the two-tier
        // muted/faint hierarchy so the name column still dominates.
        const fg = active ? c.accent : c.text.muted
        const descFg = active ? c.accent : c.text.faint
        // Single-line layout, no wrapping. wrap="truncate" prevents Ink from
        // pushing oversized desc onto a second visual row (which would
        // squeeze the palette and overflow VISIBLE_ROWS).
        return (
          <Box key={e.name}>
            <Text color={fg} bold={active} wrap="truncate">
              {padOrClip(e.name, NAME_COL_CHARS)}
            </Text>
            <Text> </Text>
            <Text color={descFg} wrap="truncate">
              {clip(e.desc, DESC_COL_CHARS)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
