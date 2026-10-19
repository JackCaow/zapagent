import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPlatformSandbox } from "../../execution/sandbox.js"

const macDescribe = process.platform === "darwin" ? describe : describe.skip

macDescribe("macOS Seatbelt refuses to launch GUI apps", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-gui-")))
  function run(command: string) {
    const context = createPlatformSandbox({ tempRoot: join(root, "tmp") }).createContext({
      executionId: "t", workspace: { root, mode: "root-integration" } as never,
      effects: { filesystem: [], network: [], process: [], external: [], workspace: { mode: "root-integration" }, confidence: "declared" } as never,
      grant: { filesystem: { read: [root], write: [root] }, network: { destinations: [], methods: [] } } as never,
    })
    const prepared = context.prepareShell(command, { cwd: root })
    try { return spawnSync(prepared.executable, prepared.args, { env: prepared.env, cwd: root, encoding: "utf8", timeout: 20000 }) }
    finally { prepared.release?.(); rmSync(root, { recursive: true, force: true }) }
  }

  it("fails the launch with 'Operation not permitted' instead of letting the app crash", () => {
    const app = ["/System/Applications/Calculator.app/Contents/MacOS/Calculator", "/Applications/Safari.app/Contents/MacOS/Safari"].find(existsSync)
    if (!app) return
    const r = run(`"${app}"; echo "exit=$?"`)
    expect(r.stdout + r.stderr).toContain("Operation not permitted")
    expect(r.stdout).toContain("exit=126")
  })

  it("still runs ordinary system binaries", () => {
    if (!existsSync("/usr/bin/uname")) return
    expect(run("/usr/bin/uname").stdout.trim()).toBe("Darwin")
  })
})
