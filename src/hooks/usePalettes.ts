import { useEffect, useMemo, useState } from "react"
import type { SkillDefinition } from "../../zapsdk/skills/types.js"
import type { MCPPrompt, MCPResource, MCPResourceTemplate } from "../../zapsdk/index.js"
import { filterCommands, type SlashEntry } from "../ui/slash-palette.js"
import { extractAtQuery, completeFiles } from "../utils/file-completer.js"

const EMPTY_SLASH_ENTRIES: SlashEntry[] = []

export interface UsePalettesOptions {
  inputValue: string
  skillsRef: React.MutableRefObject<Map<string, SkillDefinition>>
  /** Bridged MCP prompts — surface in slash palette as /mcp.<server>.<name> */
  mcpPrompts?: MCPPrompt[]
  /** Bridged MCP resources — surface in @ palette when input matches `@<server>:` */
  mcpResources?: { resources: MCPResource[]; templates: MCPResourceTemplate[] }
}

export interface UsePalettesResult {
  slashEntries: SlashEntry[]
  slashOpen: boolean
  slashIdx: number
  setSlashIdx: (idx: number | ((prev: number) => number)) => void

  fileEntries: string[]
  fileOpen: boolean
  fileIdx: number
  setFileIdx: (idx: number | ((prev: number) => number)) => void
}

/**
 * Slash palette + @ file palette derived state.
 *
 * Skills appear alongside built-in commands. Two tiers:
 *   - PRIMARY: user-installed (anywhere under .agents/skills) —
 *     shown by default in the palette
 *   - SECONDARY: codex-aggregated (everything from .codex/) —
 *     only shown when the user starts typing a filter
 * This keeps the bare-`/` view focused (≤30 rows) without losing
 * discoverability of the broader ecosystem.
 *
 * slashOpen and fileOpen are mutually exclusive (extractAtQuery only fires
 * when !slashOpen), so the App's keyboard handler can check them independently
 * without worrying about overlap.
 */
export function usePalettes(opts: UsePalettesOptions): UsePalettesResult {
  const { inputValue, skillsRef, mcpPrompts, mcpResources } = opts

  const { primarySkillEntries, secondarySkillEntries } = useMemo(() => {
    const primary: SlashEntry[] = []
    const secondary: SlashEntry[] = []
    for (const s of skillsRef.current.values()) {
      const entry: SlashEntry = {
        name: `/${s.name}`,
        desc: (s.description ?? "").slice(0, 100),
      }
      const from = s.loadedFrom ?? ""
      // .agents/skills (user-level + project-level) → primary.
      // Everything else (codex sources) → secondary.
      if (from.includes("/.agents/skills") || from.includes("/.agents/skills/")) {
        primary.push(entry)
      } else {
        secondary.push(entry)
      }
    }
    return {
      primarySkillEntries: sortSlashEntries(primary),
      secondarySkillEntries: sortSlashEntries(secondary),
    }
  // skillsRef is stable — empty deps intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // MCP prompts feed in alongside skills as another "primary" tier — they
  // come from an explicitly configured server so the user opted into them.
  const mcpPromptEntries = useMemo<SlashEntry[]>(() => {
    const entries = (mcpPrompts ?? []).map((p) => ({
      name: `/mcp.${p.server}.${p.name}`,
      desc: ((p.title ?? p.description) ?? `MCP prompt from ${p.server}`).slice(0, 100),
    }))
    return sortSlashEntries(entries)
  }, [mcpPrompts])

  // Memoize so identity is stable across unrelated re-renders (e.g. log
  // streaming). Without this, downstream consumers that put `slashEntries`
  // in a useCallback dep (useTurnDispatcher.handleSubmit, useKeyboardShortcuts)
  // rebuild their callback every frame, which propagates further identity
  // churn through any effect/memo that takes those callbacks as deps.
  const slashEntries = useMemo<SlashEntry[]>(
    () =>
      inputValue.startsWith("/") && !inputValue.includes(" ")
        ? filterCommands(inputValue, [...primarySkillEntries, ...mcpPromptEntries], secondarySkillEntries)
        : EMPTY_SLASH_ENTRIES,
    [inputValue, primarySkillEntries, mcpPromptEntries, secondarySkillEntries],
  )
  const slashOpen = slashEntries.length > 0
  const [slashIdx, setSlashIdx] = useState(0)
  useEffect(() => {
    if (slashIdx >= slashEntries.length) setSlashIdx(0)
  }, [slashEntries.length, slashIdx])

  // @ file palette (mutually exclusive with slash palette). extractAtQuery
  // matches `@<word>` at end-of-input only. completeFiles is gitignore-
  // respecting + 30s-cached, so re-running on every render while the user
  // types is cheap. Memoize on (cwd, query) so unrelated re-renders don't
  // re-walk.
  //
  // MCP resources slot in as additional `@` completions:
  //   - `@<server>:<partial>` (colon present) → only MCP entries for that
  //     server, filtered by the URI prefix typed after the colon.
  //   - `@<partial>` (no colon) → file matches PLUS `<server>:` stubs that
  //     match the partial, so the user can discover both files and MCP
  //     resources from the same picker.
  const fileQuery = !slashOpen ? extractAtQuery(inputValue) : null
  const fileEntries = useMemo(() => {
    if (fileQuery === null) return []
    const baseFiles = completeFiles(process.cwd(), fileQuery)
    const all = mcpResources ?? { resources: [], templates: [] }
    if (all.resources.length === 0 && all.templates.length === 0) return baseFiles

    const colon = fileQuery.indexOf(":")
    if (colon >= 0) {
      const server = fileQuery.slice(0, colon)
      const uriPrefix = fileQuery.slice(colon + 1)
      const out: string[] = []
      for (const r of all.resources) {
        if (r.server === server && r.uri.startsWith(uriPrefix)) out.push(`${r.server}:${r.uri}`)
      }
      for (const t of all.templates) {
        if (t.server === server && t.uriTemplate.startsWith(uriPrefix)) out.push(`${t.server}:${t.uriTemplate}`)
      }
      return out.length > 0 ? out : baseFiles
    }
    // No colon yet — show files first, then MCP stubs that prefix-match.
    const stubs = new Set<string>()
    for (const r of all.resources) if (r.server.startsWith(fileQuery)) stubs.add(`${r.server}:`)
    for (const t of all.templates) if (t.server.startsWith(fileQuery)) stubs.add(`${t.server}:`)
    return [...baseFiles, ...stubs]
  }, [fileQuery, mcpResources])
  const fileOpen = fileEntries.length > 0
  const [fileIdx, setFileIdx] = useState(0)
  useEffect(() => {
    if (fileIdx >= fileEntries.length) setFileIdx(0)
  }, [fileEntries.length, fileIdx])

  return {
    slashEntries,
    slashOpen,
    slashIdx,
    setSlashIdx,
    fileEntries,
    fileOpen,
    fileIdx,
    setFileIdx,
  }
}

function sortSlashEntries(entries: SlashEntry[]): SlashEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name))
}
