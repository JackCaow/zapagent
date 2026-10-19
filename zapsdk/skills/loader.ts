import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { SkillDefinition, SkillParameter } from "./types.js"

function chmodBestEffort(path: string, mode: number): void {
  if (process.platform === "win32") return
  try { chmodSync(path, mode) } catch {}
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const meta: Record<string, unknown> = {}
  for (const line of (match[1] ?? "").split("\n")) {
    const m = line.match(/^([\w_-]+):\s*(.+)$/)
    if (!m) continue
    const raw = (m[2] ?? "").trim().replace(/^["']|["']$/g, "")
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try { meta[m[1]!] = JSON.parse(raw) } catch { meta[m[1]!] = raw }
    } else {
      meta[m[1]!] = raw
    }
  }
  return { meta, body: (match[2] ?? "").trim() }
}

/** Load all skills from a single directory (each sub-folder with a SKILL.md). */
export function loadSkillsFromDir(dir: string): Map<string, SkillDefinition> {
  const skills = new Map<string, SkillDefinition>()
  if (!existsSync(dir)) return skills

  for (const entry of sortedDirEntries(dir)) {
    if (!entry.isDirectory()) continue
    const skillMd = join(dir, entry.name, "SKILL.md")
    if (!existsSync(skillMd)) continue

    try {
      const content = readFileSync(skillMd, "utf-8")
      const { meta, body } = parseFrontmatter(content)
      const name = typeof meta.name === "string" ? meta.name : entry.name
      const parameters = Array.isArray(meta.parameters)
        ? (meta.parameters as unknown[]).filter(
            (p): p is SkillParameter =>
              !!p && typeof p === "object" &&
              typeof (p as Record<string, unknown>).name === "string"
          )
        : undefined
      const maxSteps = nonNegativeIntegerOrDefault(meta.max_steps, 10)
      const reserveSteps = nonNegativeInteger(meta.reserve_steps)
      skills.set(name, {
        name,
        description: typeof meta.description === "string" ? meta.description : "",
        systemPrompt: body,
        tools: Array.isArray(meta.tools) ? meta.tools as string[] : [],
        parameters,
        maxSteps,
        reserveSteps,
        loadedFrom: dir,
        sourcePath: skillMd,
      })
    } catch {}
  }
  return skills
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : undefined
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number): number {
  return nonNegativeInteger(value) ?? fallback
}

/**
 * Walk up from cwd to git root collecting `.agents/skills` dirs.
 * Returns ordered repo-root → cwd so nearest directory wins.
 */
function collectProjectSkillDirs(cwd: string): string[] {
  const dirs: string[] = []
  let current = cwd
  while (true) {
    const candidate = join(current, ".agents", "skills")
    if (existsSync(candidate)) dirs.unshift(candidate)
    if (existsSync(join(current, ".git"))) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/**
 * Codex installs plugin-bundled skills under
 *   ~/.codex/plugins/cache/<owner>/<plugin>/<version>/skills/
 * Walk this three-level structure and return every `skills/` subtree so
 * zap picks up skills the user installed via Codex (superpowers,
 * imagegen, etc.) without any per-skill symlinking.
 */
function collectCodexPluginSkillDirs(): string[] {
  const dirs: string[] = []
  const root = join(homedir(), ".codex", "plugins", "cache")
  if (!existsSync(root)) return dirs
  try {
    for (const owner of sortedDirEntries(root)) {
      if (!owner.isDirectory()) continue
      const ownerDir = join(root, owner.name)
      for (const plugin of sortedDirEntries(ownerDir)) {
        if (!plugin.isDirectory()) continue
        const pluginDir = join(ownerDir, plugin.name)
        for (const version of sortedDirEntries(pluginDir)) {
          if (!version.isDirectory()) continue
          const skillsDir = join(pluginDir, version.name, "skills")
          if (existsSync(skillsDir)) dirs.push(skillsDir)
        }
      }
    }
  } catch {}
  return dirs
}

function sortedDirEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Skill discovery paths, in lowest-to-highest priority order. Same-named
 * skill from a later path overrides earlier ones.
 *
 *   system        /etc/codex/skills
 *   codex-user    ~/.codex/skills                             (direct user skills)
 *   codex-plugin  ~/.codex/plugins/cache/.../skills           (codex plugin install)
 *   zap-user      ~/.agents/skills                            (zap's own user dir, flat one level)
 *   project       .agents/skills                              (repo-root → cwd, nearest wins)
 *
 * Only flat `~/.agents/skills/<role>/SKILL.md` is recognized — nested
 * `<plugin>/skills/<role>/` is intentionally NOT scanned. Plugins that
 * want multiple sub-skills should expose them as siblings with a shared
 * name prefix (e.g. dev-team-pm, dev-team-ui-ux), uninstalled together
 * via `rm -rf ~/.agents/skills/dev-team*`.
 */
export function loadAllSkills(cwd: string): Map<string, SkillDefinition> {
  const sources = [
    "/etc/codex/skills",
    join(homedir(), ".codex", "skills"),
    ...collectCodexPluginSkillDirs(),
    join(homedir(), ".agents", "skills"),
    ...collectProjectSkillDirs(cwd),
  ]

  const merged = new Map<string, SkillDefinition>()
  for (const dir of sources) {
    for (const [name, skill] of loadSkillsFromDir(dir)) {
      merged.set(name, skill)
    }
  }
  return merged
}

/** Write a SKILL.md for the given skill if it does not already exist. */
export function installSkillIfMissing(skillsDir: string, skill: SkillDefinition): void {
  const dir = join(skillsDir, skill.name)
  const file = join(dir, "SKILL.md")
  if (existsSync(file)) {
    chmodBestEffort(skillsDir, 0o700)
    chmodBestEffort(dir, 0o700)
    chmodBestEffort(file, 0o600)
    return
  }
  try {
    mkdirSync(dir, { recursive: true })
    chmodBestEffort(skillsDir, 0o700)
    chmodBestEffort(dir, 0o700)
    const toolsLine = skill.tools.length > 0
      ? `tools: ${JSON.stringify(skill.tools)}\n`
      : ""
    const paramsLine = skill.parameters && skill.parameters.length > 0
      ? `parameters: ${JSON.stringify(skill.parameters)}\n`
      : ""
    const maxStepsLine = typeof skill.maxSteps === "number" ? `max_steps: ${skill.maxSteps}\n` : ""
    const reserveStepsLine = typeof skill.reserveSteps === "number" ? `reserve_steps: ${skill.reserveSteps}\n` : ""
    const content = `---\nname: "${skill.name}"\ndescription: "${skill.description.replace(/"/g, '\\"')}"\n${toolsLine}${paramsLine}${maxStepsLine}${reserveStepsLine}---\n\n${skill.systemPrompt}\n`
    writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 })
    chmodBestEffort(file, 0o600)
  } catch {}
}
