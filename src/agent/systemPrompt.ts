import { DYNAMIC_BOUNDARY, escapeDynamicBoundaryText } from "../../zapsdk/core/prompt-boundary.js"
import { subagentToolPrompt } from "../../zapsdk/builtin-tools/subagent.js"

/** Insert a stable system section into the cacheable prefix. If the prompt
 *  has a static/dynamic boundary, the section must go before that marker;
 *  appending after the full prompt silently moves stable instructions into
 *  the dynamic suffix and lowers provider prompt-cache hit rate. */
export function appendCacheableSystemSection(prompt: string, section: string): string {
  const trimmed = escapeDynamicBoundaryText(section).trim()
  if (!trimmed) return prompt
  const idx = prompt.indexOf(DYNAMIC_BOUNDARY)
  if (idx < 0) return `${prompt.trimEnd()}\n\n${trimmed}`

  const before = prompt.slice(0, idx).trimEnd()
  const after = prompt.slice(idx + DYNAMIC_BOUNDARY.length).trimStart()
  return [
    before,
    trimmed,
    DYNAMIC_BOUNDARY,
    after,
  ].filter((part) => part.length > 0).join("\n\n")
}

export interface RuntimePromptToolInputs {
  enabledToolNames: Set<string>
  toolPrompts: string
}

/** Build the tool view used by system-prompt assembly.
 *
 * LoopAgent can auto-register tools on a per-run registry clone. The canonical
 * case is `agent`: callers build the prompt before constructing LoopAgent, but
 * the model still receives the tool schema at runtime. Reflect those auto tools
 * here so prompt guidance matches the effective runtime tool set without
 * mutating the shared registry or leaking per-turn budget counters into the
 * cacheable prompt prefix.
 */
export function buildRuntimePromptToolInputs(
  registryToolNames: Iterable<string>,
  registryToolPrompts: string,
  options: { subagentEnabled?: boolean } = {},
): RuntimePromptToolInputs {
  const enabledToolNames = new Set(registryToolNames)
  let toolPrompts = registryToolPrompts.trim()

  if (options.subagentEnabled !== false && !enabledToolNames.has("agent")) {
    enabledToolNames.add("agent")
    toolPrompts = insertToolPromptSorted(toolPrompts, "agent", subagentToolPrompt())
  }

  return { enabledToolNames, toolPrompts }
}

function renderToolPromptBlock(name: string, prompt: string): string {
  return `## ${name}\n${prompt.trim()}`
}

function insertToolPromptSorted(raw: string, name: string, prompt: string): string {
  const block = renderToolPromptBlock(name, prompt)
  if (!raw) return `# Tool usage guidance\n\n${block}`

  const parsed = parseGeneratedToolPrompts(raw)
  if (!parsed) return `${raw}\n\n${block}`

  const blocks = [
    ...parsed.blocks.filter((existing) => existing.name !== name),
    { name, text: block },
  ].sort((a, b) => a.name.localeCompare(b.name))

  return `${parsed.header}\n\n${blocks.map((entry) => entry.text).join("\n\n")}`
}

function parseGeneratedToolPrompts(raw: string): {
  header: string
  blocks: Array<{ name: string; text: string }>
} | null {
  const trimmed = raw.trim()
  const header = "# Tool usage guidance"
  if (!trimmed.startsWith(header)) return null

  const lines = trimmed.split(/\r?\n/)
  const starts: Array<{ index: number; name: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const match = /^## ([A-Za-z0-9_-]+)\s*$/.exec(lines[i] ?? "")
    if (match?.[1]) starts.push({ index: i, name: match[1] })
  }
  if (starts.length === 0) return null

  const blocks = starts.map((start, idx) => {
    const end = starts[idx + 1]?.index ?? lines.length
    return {
      name: start.name,
      text: lines.slice(start.index, end).join("\n").trim(),
    }
  })

  return { header, blocks }
}
