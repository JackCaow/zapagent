import { readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
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
  // npm also puts .cmd and shell shims on Windows PATH. Invoke the package
  // entry directly so arguments and paths never pass through cmd.exe.
  const dir = dirname(found)
  const pkg = join(basename(dir) === ".bin" ? dirname(dir) : join(dir, "node_modules"), packages[name])
  const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"))
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name]
  if (typeof bin !== "string") throw new Error(`Missing ${name} executable in ${pkg}`)
  const executable = resolve(pkg, bin)
  if (/\.exe$/i.test(executable)) return { command: executable, args: [] }
  const node = await which("node.exe")
  if (!node) throw new Error(`Install Node.js to run the npm installation of ${name}.`)
  return { command: node, args: [executable] }
}
