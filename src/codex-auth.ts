import { nativeCommand } from "./agent/official-agents.js"
import { createLocalProcessBroker } from "../zapsdk/execution/process.js"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { getAppDataDir } from "../zapsdk/utils/platform.js"

/** Authentication stays in the official CLI's credential store. Only its login
 * instructions and exit status are exposed to the host. */
export async function runCodexAuth(action: "login" | "logout" | "status", options: {
  device?: boolean
  signal?: AbortSignal
  onOutput?: (text: string) => void
} = {}): Promise<number> {
  const args = action === "status" ? ["login", "status"] : [action]
  if (action === "login" && options.device) args.push("--device-auth")
  const cli = await nativeCommand("codex")
  const status = await new Promise<number>((resolve, reject) => {
    const child = createLocalProcessBroker(options.signal).spawnCommand(cli.command, [...cli.args, ...args], { cwd: process.cwd(), hostHome: true })
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding("utf8")
      stream.on("data", (text: string) => options.onOutput?.(text))
    }
    child.once("error", reject)
    child.once("close", code => resolve(code ?? 1))
  })
  options.signal?.throwIfAborted()
  if (action === "logout" && status === 0) {
    await rm(join(getAppDataDir(), "codex-oauth.json"), { force: true })
  }
  return status
}
