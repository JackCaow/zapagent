import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, parse, relative } from "node:path"
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
    const documents = readProjectGuidelines(ctx.cwd)
    if (!documents.length) return null
    const root = resolveProjectRoot(ctx.cwd)
    return [
      "# Project Guidelines (from AGENTS.md)",
      "These are user-owned project documents, not private runtime instructions. Apply each document only within its directory subtree; more specific guidelines take precedence there. Explicit user requests and runtime permissions still govern. Before changing files in deeper directories, check for additional AGENTS.md files in their ancestor directories.",
      ...documents.map(document => `## ${relative(root, document.path) || "AGENTS.md"} (scope: ${relative(root, dirname(document.path)) || "."})\n\n${document.content}`),
    ].join("\n\n")
  },
}

const rootCache = new Map<string, string>()

function readAgentsMd(cwd: string): string {
  return readProjectGuidelines(cwd).map(document => document.content).join("\n\n")
}

export function readProjectGuidelines(cwd: string): Array<{ path: string; content: string }> {
  const root = resolveProjectRoot(cwd)
  const directories: string[] = []
  for (let current = cwd; ; current = dirname(current)) {
    directories.push(current)
    if (current === root || dirname(current) === current) break
  }
  const documents: Array<{ path: string; content: string }> = []
  for (const directory of directories.reverse()) {
    const path = join(directory, "AGENTS.md")
    try {
      const content = readCachedTextFile(path).trim()
      if (content) documents.push({ path, content })
    } catch {}
  }
  return documents
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
