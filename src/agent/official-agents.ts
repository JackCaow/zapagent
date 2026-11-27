import { readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { AcpAgentSpec } from "../../zapsdk/acp-client/types.js"
import { getActiveProvider, getEffort, type AppConfig } from "../config.js"
import { which } from "../../zapsdk/builtin-tools/delegate-detect.js"

const packages = {
  codex: "@openai/codex",
  "codex-acp": "@agentclientprotocol/codex-acp",
  claude: "@anthropic-ai/claude-code",
}

export function agentInstallHint(id: string): string {
  if (id === "codex") return "Install @openai/codex and @agentclientprotocol/codex-acp, then run codex login."
  if (id === "claude-code") return "Install Claude Code, then run claude auth login."
  return "Check the configured ACP command and restart Zap."
}

export async function nativeCommand(name: keyof typeof packages): Promise<{ command: string; args: string[] }> {
  const found = await which(name)
  if (!found) throw new Error(agentInstallHint(name === "claude" ? "claude-code" : "codex"))
  if (process.platform !== "win32" || /\.exe$/i.test(found)) return { command: found, args: [] }
  return windowsNativeCommand(name, found)
}

/** Read the selected shim's package entry without executing its shell code. */
async function windowsNativeCommand(name: keyof typeof packages, found: string) {
  const dir = dirname(found)
  const adjacentExe = await which(join(dir, name + ".exe"))
  if (adjacentExe) return { command: adjacentExe, args: [] }
  const pkg = packages[name]
  const roots = new Set<string>()
  const packageRoot = (entry: string) => {
    const marker = "/node_modules/" + pkg + "/"
    const normalized = entry.replaceAll("\\", "/")
    const end = normalized.lastIndexOf(marker)
    if (end !== -1) roots.add(resolve(dir, normalized.slice(0, end + marker.length - 1)))
  }
  packageRoot(await realpath(found))
  // pnpm and Yarn may put the shim in a different tree from the package.
  // Only inspect literal paths. Never evaluate shell variables or commands.
  for (const shim of new Set([found, join(dir, name + ".cmd")])) {
    const script = await readFile(shim, "utf8").catch(() => "")
    for (const match of script.matchAll(/"([^"\r\n]+)"/g)) {
      const entry = match[1].replace(/^(?:%~dp0|%dp0%|\$basedir)[\\/]?/i, "./")
      if (!/[%$`]/.test(entry)) packageRoot(entry)
    }
  }
  roots.add(join(basename(dir) === ".bin" ? dirname(dir) : join(dir, "node_modules"), pkg))
  for (const root of roots) {
    const json = await readFile(join(root, "package.json"), "utf8").catch(() => undefined)
    if (!json) continue
    const manifest = JSON.parse(json)
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name]
    if (typeof bin !== "string") continue
    const entry = await which(resolve(root, bin))
    if (!entry) continue
    if (/\.exe$/i.test(entry)) return { command: entry, args: [] }
    const node = await which("node.exe")
    if (!node) throw new Error(`Install Node.js to run the npm installation of ${name}.`)
    return { command: node, args: [entry] }
  }
  throw new Error(`Cannot locate ${name} behind ${found}. Install ${pkg} with npm install -g or put its native executable on PATH.`)
}

export async function codexConversationSpec(config: AppConfig, detected?: AcpAgentSpec): Promise<AcpAgentSpec> {
  const provider = getActiveProvider(config)
  const subscription = provider?.authMode === "codex-oauth"
  // Explicit ACP overrides belong to /agent. Subscription connections always
  // use the installed Codex bridge and the selected account's preferences.
  const custom = subscription ? undefined : config.acpAgents?.find(agent => agent.id === "codex")
  const spec = custom ? detected : undefined
  const cli = spec && custom?.command !== "codex-acp" ? spec : await nativeCommand("codex-acp")
  const allowEdits = config.permissionMode === "acceptEdits" || config.permissionMode === "bypassPermissions"
  const effort = subscription ? getEffort(config, provider.id) : undefined
  return {
    ...spec, id: "codex", command: cli.command,
    args: cli === spec ? cli.args : [...(cli.args ?? []), ...(spec?.args ?? [])],
    requireSettings: true, mode: allowEdits && spec?.mode !== "read-only" ? "workspace-write" : "read-only",
    model: subscription ? config.active.model || undefined : spec?.model,
    config: effort ? { reasoning_effort: effort } : spec?.config,
  }
}
