import { join } from "node:path"
import { getAppDataDir } from "../zapsdk/utils/platform.js"
import { loadAppConfig, saveAppConfig } from "./config.js"
import { connectCodexProvider } from "./codex-provider.js"
import { deleteCodexCredentials, openAuthBrowser, readCodexCredentials, saveCodexCredentials,
  startCodexBrowserLogin, startCodexDeviceLogin } from "./codex-auth.js"

export async function runCodexAuthCommand(args: string[]): Promise<number> {
  const [action, provider, ...flags] = args
  if (!["login", "logout", "status"].includes(action) || provider !== "codex" ||
    flags.some(flag => flag !== "--device-code" || action !== "login")) {
    console.error("Usage: zap auth login codex [--device-code] | zap auth logout codex | zap auth status codex")
    return 2
  }
  try {
    if (action === "logout") { await deleteCodexCredentials(); console.log("Codex signed out from Zap."); return 0 }
    if (action === "status") {
      const credentials = readCodexCredentials()
      console.log(credentials ? `Codex signed in${credentials.expiresAt <= Date.now() ? " (token will refresh on next request)" : ""}.` : "Codex signed out.")
      return credentials ? 0 : 1
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once("SIGINT", cancel)
    process.once("SIGTERM", cancel)
    try {
      const login = flags.includes("--device-code") ? await startCodexDeviceLogin(controller.signal) : await startCodexBrowserLogin({ signal: controller.signal })
      console.log(`${login.instructions}\n${login.url}`)
      openAuthBrowser(login.url)
      const credentials = await login.complete
      controller.signal.throwIfAborted()
      await saveCodexCredentials(credentials, undefined, controller.signal)
      controller.signal.throwIfAborted()
      const path = join(getAppDataDir(), "config.json")
      // Read after login so an in-flight TUI edit is not overwritten by an old snapshot.
      saveAppConfig(path, connectCodexProvider(loadAppConfig(path)).config)
      console.log("Codex connected. Open Zap and choose a model with /model.")
      return 0
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel) }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Codex login failed.")
    return 1
  }
}
