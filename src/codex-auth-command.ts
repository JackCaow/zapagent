import { join } from "node:path"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { loadAppConfig, saveAppConfig } from "./config.js"
import { connectCodexProvider } from "./codex-provider.js"
import { runCodexAuth } from "./codex-auth.js"

export async function runCodexAuthCommand(args: string[]): Promise<number> {
  const [action, provider, ...flags] = args
  if ((action !== "login" && action !== "logout" && action !== "status") || provider !== "codex" ||
    flags.some(flag => flag !== "--device-code" || action !== "login")) {
    console.error("Usage: zap auth login codex [--device-code] | zap auth logout codex | zap auth status codex")
    return 2
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    const status = await runCodexAuth(action, { device: flags.includes("--device-code"), signal: controller.signal,
      onOutput: text => process.stderr.write(text) })
    if (action === "login" && !status) {
      const path = join(getAppDataDir(), "config.json")
      saveAppConfig(path, connectCodexProvider(loadAppConfig(path)).config)
      console.log("Codex connected. Choose its model with /model in Zap.")
    }
    return status
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Codex authentication failed")
    return 1
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel) }
}
