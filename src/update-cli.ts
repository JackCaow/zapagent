import { createInterface } from "node:readline/promises"
import { fetchLatestRelease, isNewerRelease } from "./update-check.js"
import { installSelfUpdate, planSelfUpdate } from "./self-update.js"
import { VERSION } from "./version.js"

interface UpdateCommandDeps {
  latest: () => Promise<string>
  confirm: (question: string) => Promise<boolean>
  plan: typeof planSelfUpdate
  install: typeof installSelfUpdate
  write: (message: string) => void
}

export async function runUpdateCommand(args: string[], overrides: Partial<UpdateCommandDeps> = {}): Promise<number> {
  const deps: UpdateCommandDeps = {
    latest: () => fetchLatestRelease({ currentVersion: VERSION, cachePath: "" }),
    confirm: async question => {
      if (!process.stdin.isTTY) throw new Error("Confirmation requires a terminal. Use zap update --yes for unattended installation.")
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try { return /^(?:y|yes)$/i.test((await input.question(question)).trim()) }
      finally { input.close() }
    },
    plan: planSelfUpdate, install: installSelfUpdate,
    write: message => { process.stdout.write(`${message}\n`) },
    ...overrides,
  }
  if (args.some(arg => arg !== "--yes" && arg !== "-y")) {
    deps.write("Usage: zap update [--yes|-y]")
    return 2
  }
  try {
    deps.write("Checking for zapAgent updates…")
    const version = await deps.latest()
    if (!isNewerRelease(version, VERSION)) {
      deps.write(`zapAgent v${VERSION} is up to date.`)
      return 0
    }
    const plan = await deps.plan(version)
    deps.write(`Update available: v${VERSION} → v${version}`)
    if (!args.includes("--yes") && !args.includes("-y") && !await deps.confirm("Download and install? [y/N] ")) {
      deps.write("Update cancelled.")
      return 0
    }
    deps.write(`Downloading and installing v${version}…`)
    await deps.install(plan, "")
    // This short-lived command owns no TUI/session to restart. Future zap
    // invocations use the updated launcher/binary; an existing TUI is untouched.
    deps.write(`Installed zapAgent v${version}. Run zap to start.`)
    return 0
  } catch (error) {
    deps.write(`Update failed: ${error instanceof Error ? error.message : "unknown error"}`)
    return 1
  }
}
