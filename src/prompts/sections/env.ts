import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import { release } from "node:os"
import { getOS } from "../../../zapsdk/utils/platform.js"
import { localExecutionShell } from "../../../zapsdk/execution/shell.js"
import type { PromptSection } from "../registry.js"

/**
 * Environment block — the one section guaranteed to vary per session
 * (cwd, date, git branch) so it's marked dynamic. Keep it cheap to recompute:
 * prompt construction happens before every model call.
 */
export const envSection: PromptSection = {
  name: "env",
  purpose: "environment",
  dynamic: true,
  compute: (ctx) => {
    const today = new Date().toISOString().split("T")[0]
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions()
    const git = detectGit(ctx.cwd)
    const projectTypes = detectProjectTypes(ctx.cwd)
    const execution = ctx.executionFacts

    const lines = [
      "# Environment",
      `- Today: ${today}`,
      `- Timezone: ${timeZone}`,
      `- Locale: ${locale}`,
      `- Platform: ${getOS()} (${release()})`,
      `- Working directory: ${ctx.cwd}`,
      `- Shell: ${execution?.shell ?? localExecutionShell().executable}`,
    ]

    if (execution) {
      // Runtime data informs the Agent without importing backend-specific
      // recovery rules, completion decisions or prompt fragments.
      lines.push(`- Process environment facts: ${JSON.stringify(execution)}`)
    }
    if (ctx.executionCapacity) {
      lines.push(`- Local execution capacity observations (visible limits only): ${JSON.stringify(ctx.executionCapacity)}`)
    }

    if (ctx.model) {
      lines.push(`- Model: ${ctx.model}`)
    }

    if (git) {
      lines.push(`- Git repo: yes — branch \`${git.branch}\``)
    } else {
      lines.push("- Git repo: no")
    }

    if (projectTypes.length > 0) {
      lines.push(`- Project type: ${projectTypes.join(", ")}`)
    }

    lines.push("- Output is rendered as Markdown in a terminal UI")
    return lines.join("\n")
  },
}

function detectGit(cwd: string): { root: string; branch: string } | null {
  const root = findGitRoot(cwd)
  if (!root) return null
  return { root, branch: readGitBranch(root) }
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

function readGitBranch(root: string): string {
  const gitDir = resolveGitDir(root)
  const head = readText(join(gitDir, "HEAD")).trim()
  const ref = head.match(/^ref:\s+refs\/heads\/(.+)$/)
  if (ref?.[1]) return ref[1]
  return head ? head.slice(0, 12) : "HEAD"
}

function resolveGitDir(root: string): string {
  const marker = join(root, ".git")
  try {
    if (statSync(marker).isDirectory()) return marker
    const raw = readText(marker).trim()
    const match = raw.match(/^gitdir:\s*(.+)$/i)
    if (match?.[1]) {
      return isAbsolute(match[1]) ? match[1] : resolve(root, match[1])
    }
  } catch {}
  return marker
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

function detectProjectTypes(cwd: string): string[] {
  const markers: Array<[string, string]> = [
    ["package.json",     "node"],
    ["bun.lock",         "bun"],
    ["bun.lockb",        "bun"],
    ["pyproject.toml",   "python"],
    ["requirements.txt", "python"],
    ["Cargo.toml",       "rust"],
    ["go.mod",           "go"],
    ["pom.xml",          "java-maven"],
    ["build.gradle",     "java-gradle"],
    ["build.gradle.kts", "java-gradle"],
    ["Gemfile",          "ruby"],
    ["composer.json",    "php"],
    ["Dockerfile",       "docker"],
    ["docker-compose.yml", "docker-compose"],
  ]
  const seen = new Set<string>()
  for (const [file, label] of markers) {
    if (existsSync(join(cwd, file))) seen.add(label)
  }
  return [...seen]
}
