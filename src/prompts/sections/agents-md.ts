import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import type { PromptSection } from "../registry.js"

/**
 * AGENTS.md — project-level guidance written by maintainers for agents.
 * Cacheable because it is stable across most turns in a project. If the file
 * changes, provider prompt caches naturally miss on the changed bytes; keeping
 * it before the dynamic boundary avoids excluding project rules from explicit
 * cache breakpoints on providers such as Anthropic.
 */
export const agentsMdSection: PromptSection = {
  name: "agents-md",
  purpose: "project",
  compute: (ctx) => {
    const content = readAgentsMd(ctx.cwd).trim()
    if (!content) return null
    return `# Project Guidelines (from AGENTS.md)\n\n${content}`
  },
}

const rootCache = new Map<string, string>()

function readAgentsMd(cwd: string): string {
  const root = resolveProjectRoot(cwd)

  const candidates = [join(root, "AGENTS.md"), join(cwd, "AGENTS.md")]
  for (const p of candidates) {
    if (root !== cwd && p === join(cwd, "AGENTS.md")) continue
    try {
      const content = readCachedTextFile(p).trim()
      if (content) return content
    } catch {}
  }
  return ""
}

function resolveProjectRoot(cwd: string): string {
  const cached = rootCache.get(cwd)
  if (cached) return cached
  const root = findGitRoot(cwd) ?? cwd
  rootCache.set(cwd, root)
  return root
}

function findGitRoot(cwd: string): string | null {
  let current = cwd
  const { root } = parse(cwd)
  for (;;) {
    if (hasGitMarker(current)) return current
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function hasGitMarker(path: string): boolean {
  try {
    const stat = statSync(join(path, ".git"))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

function readCachedTextFile(path: string): string {
  if (!existsSync(path)) return ""
  const stat = statSync(path)
  if (!stat.isFile()) return ""
  return readFileSync(path, "utf-8")
}

function clearAgentsMdCache(): void {
  rootCache.clear()
}

export const __test = { readAgentsMd, clearAgentsMdCache }
