import { describe, it, expect, beforeEach } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeCommandTool } from "../../builtin-tools/command.js"
import { TaskStore } from "../../tasks/store.js"
import type { TaskExitedEvent } from "../../tasks/types.js"

function awaitTaskExit(store: TaskStore, taskId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      store.off("exited", onExit as (...args: unknown[]) => void)
      resolve()
    }
    const onExit = (e: TaskExitedEvent) => {
      if (e.taskId === taskId) done()
    }
    store.on("exited", onExit)
    if (store.get(taskId)?.exitedAt !== undefined) done()
  })
}

describe("bash timeout_ms", () => {
  it("kills a command at the per-call timeout instead of the tool default", async () => {
    const tool = executeCommandTool({ timeoutMs: 30_000 })
    const started = Date.now()
    const result = await tool.handler({ command: "sleep 10", timeout_ms: 1000 })
    expect(result.success).toBe(false)
    expect(result.error).toContain("timed out after 1000ms")
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it("lets a call raise the timeout above the default, capped at 10 minutes, and moves the executor deadline with it", () => {
    const tool = executeCommandTool({ timeoutMs: 60_000 })
    const resolve = tool.definition.resolveTimeoutMs!
    expect(resolve({ command: "x" })).toBe(65_000)
    expect(resolve({ command: "x", timeout_ms: 300_000 })).toBe(305_000)
    expect(resolve({ command: "x", timeout_ms: 9_999_999 })).toBe(605_000)
    expect(resolve({ command: "x", timeout_ms: -5 })).toBe(65_000)
  })
})

describe("bash sandboxExcludedCommands", () => {
  const effects = (tool: ReturnType<typeof executeCommandTool>, command: string) =>
    tool.definition.resolveEffects!({ command } as never, { cwd: process.cwd() } as never).process[0]

  it("marks a matching command unsandboxed, and only that command", () => {
    const tool = executeCommandTool({ sandboxExcludedCommands: ["*Google Chrome.app*", "docker:*"] })
    expect(effects(tool, '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version').unsandboxed).toBe(true)
    expect(effects(tool, "docker ps").unsandboxed).toBe(true)
    expect(effects(tool, "python3 gen.py").unsandboxed).toBeUndefined()
  })

  it("is ignored when sandbox escapes are disabled by host policy", () => {
    const tool = executeCommandTool({ sandboxExcludedCommands: ["docker:*"], allowUnsandboxed: false })
    expect(effects(tool, "docker ps").unsandboxed).toBeUndefined()
  })
})

describe("bash leading cd", () => {
  const tool = executeCommandTool()

  it("runs a multi-line command that starts with cd <dir> &&", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "zap-cd-")))
    try {
      const result = await tool.handler({ command: `cd ${dir} && cat > out.txt <<'EOF'\nhello\nEOF\ncat out.txt` })
      expect(result.success).toBe(true)
      expect(result.output).toContain("hello")
      expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("hello\n")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("runs cd <dir> followed by more lines instead of dropping them", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "zap-cd-")))
    try {
      const result = await tool.handler({ command: `cd ${dir}\npwd` })
      expect(result.output).not.toContain("Use cwd parameter")
      expect(result.output).toContain(dir)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("bash exit-code handling", () => {
  const tool = executeCommandTool()

  it("preserves grep no-match exit status without inventing output", async () => {
    const result = await tool.handler({ command: "printf 'alpha\\nbeta\\n' | grep NOPE" })
    expect(result.success).toBe(false)
    expect(result.output).toBe("")
    expect(result.runtime?.command?.exitCode).toBe(1)
  })

  it("does not let a successful grep hide a later failed validation", async () => {
    for (const command of ["printf 'alpha\\n' | grep alpha && false", "printf 'alpha\\n' | grep alpha; false"]) {
      const result = await tool.handler({ command })
      expect(result.success).toBe(false)
      expect(result.output).toContain("alpha")
      expect(result.runtime?.command?.exitCode).toBe(1)
    }
  })

  it("preserves explicit handling of an expected no-match status", async () => {
    const result = await tool.handler({ command: "printf alpha | grep NEVER; code=$?; test \"$code\" -eq 1" })
    expect(result.success).toBe(true)
    expect(result.runtime?.command?.exitCode).toBe(0)
  })

  it("keeps final shell status authoritative for pipelines and diagnostic prose", async () => {
    const pipeline = await tool.handler({ command: "(printf 'synthetic error\\n' >&2; exit 7) | cat" })
    const diagnostic = await tool.handler({ command: "printf 'expected error fixture\\n' >&2; true" })
    for (const result of [pipeline, diagnostic]) {
      expect(result.success).toBe(true)
      expect(result.runtime?.command?.exitCode).toBe(0)
      expect(result.output).toContain("error")
    }
  })

  it("does not treat generic exit 1 with empty stderr as success", async () => {
    const result = await tool.handler({ command: "false" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Command failed: false")
  })

  it("does not treat test predicates returning false as success", async () => {
    const result = await tool.handler({ command: "test -f definitely-missing-zap-file" })
    expect(result.success).toBe(false)
  })

  it("does not treat git diff --quiet differences as success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-bash-diff-"))
    try {
      const init = await tool.handler({
        command: [
          "git init",
          "git config user.email test@example.com",
          "git config user.name Test",
          "printf 'a\\n' > f.txt",
          "git add f.txt",
          "git commit -m init >/dev/null",
        ].join(" && "),
        cwd: dir,
      })
      expect(init.success).toBe(true)

      const result = await tool.handler({ command: "printf 'b\\n' > f.txt && git diff --quiet", cwd: dir })
      expect(result.success).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports real errors (non-1 exit or stderr) as failure", async () => {
    // Bad grep regex → writes to stderr and exits non-zero. Should stay a failure.
    const result = await tool.handler({ command: "grep '[' /dev/null" })
    expect(result.success).toBe(false)
  })

  it("preserves structured immutable-rootfs errors and exit codes", async () => {
    const result = await tool.handler({
      command: "printf 'ZAPVM_ERROR[IMMUTABLE_ROOTFS]: signed image only\\n' >&2; exit 78",
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Code: IMMUTABLE_ROOTFS")
    expect(result.error).toContain("Exit code: 78")
    expect(result.error).not.toContain("Do not retry")
  })

  it("reports missing executable facts without selecting the Agent's recovery strategy", async () => {
    const result = await tool.handler({ command: "definitely-missing-zap-runtime" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("Code: COMMAND_NOT_FOUND")
    expect(result.error).toContain("Exit code: 127")
    expect(result.error).not.toContain("zap-pkg")
    expect(result.error).not.toContain("Hint:")
  })

  it("keeps grep with matches (exit 0) as success with output", async () => {
    const result = await tool.handler({ command: "printf 'alpha\\nbeta\\n' | grep alpha" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("alpha")
  })
})

describe("bash sandbox effects", () => {
  it("denies network by default and only declares egress when explicitly enabled", () => {
    const offline = executeCommandTool({ defaultCwd: process.cwd() })
    const online = executeCommandTool({ defaultCwd: process.cwd(), sandboxNetwork: true })
    const context = { cwd: process.cwd(), toolName: "bash" }

    expect(offline.definition.resolveEffects?.({ command: "true" }, context).network).toEqual([])
    expect(online.definition.resolveEffects?.({ command: "true" }, context).network[0]?.destinations).toEqual(["*"])
  })

  it("exposes and grants only declared restricted-network destinations", () => {
    const tool = executeCommandTool({ defaultCwd: process.cwd(), restrictedNetwork: true })
    const shape = (tool.definition.parameters as any).shape
    const context = { cwd: process.cwd(), toolName: "bash" }

    expect(shape.network_destinations).toBeDefined()
    expect(tool.definition.resolveEffects?.({
      command: "curl https://api.example.com",
      network_destinations: ["https://api.example.com/v1"],
    }, context).network[0]?.destinations).toEqual(["https://api.example.com/v1"])
    expect(tool.definition.resolveEffects?.({ command: "true" }, context).network).toEqual([])
    expect(tool.definition.prompt).not.toContain("root filesystem is immutable")
    const workTool = executeCommandTool({
      defaultCwd: process.cwd(),
      restrictedNetwork: true,
      persistentPackageManagement: true,
    })
    expect(workTool.definition.prompt).toBe(tool.definition.prompt)
    expect(workTool.definition.description).toBe(tool.definition.description)
    expect(workTool.definition.prompt).not.toMatch(/VM|zap-pkg|terminal policy|never/i)
  })
})

describe("bash run_in_background", () => {
  let store: TaskStore

  beforeEach(() => {
    const outputDir = mkdtempSync(join(tmpdir(), "zap-bash-bg-"))
    store = new TaskStore({ outputDir })
  })

  it("hides background fields from schema when no store is wired", () => {
    const tool = executeCommandTool({})
    const shape = (tool.definition.parameters as any).shape
    expect(shape.run_in_background).toBeUndefined()
    expect(shape.description).toBeUndefined()
  })

  it("exposes background fields when a store is wired", () => {
    const tool = executeCommandTool({ store })
    const shape = (tool.definition.parameters as any).shape
    expect(shape.run_in_background).toBeDefined()
    expect(shape.description).toBeDefined()
  })

  it("hides background fields when ZAPCODE_DISABLE_BACKGROUND_TASKS=1", () => {
    const tool = executeCommandTool({ store, disableBackgroundTasks: true })
    const shape = (tool.definition.parameters as any).shape
    expect(shape.run_in_background).toBeUndefined()
  })

  it("honors the env kill switch without mutating this test process", () => {
    const script = [
      'import { executeCommandTool } from "./zapsdk/builtin-tools/command.ts";',
      "const tool = executeCommandTool({ store: {} });",
      "const shape = tool.definition.parameters.shape;",
      "process.exit(shape.run_in_background === undefined ? 0 : 1);",
    ].join("\n")
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, ZAPCODE_DISABLE_BACKGROUND_TASKS: "1" },
      stdio: "pipe",
      encoding: "utf-8",
    })
    expect(result.status).toBe(0)
  })

  it("returns task handle immediately and writes output to outputFile", async () => {
    const tool = executeCommandTool({ store })
    const result = await tool.handler({
      command: "printf 'hello-bg\\n'",
      run_in_background: true,
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)
    expect(parsed.taskId).toMatch(/^[0-9a-f]{8}$/)
    expect(parsed.pid).toBeGreaterThan(0)
    expect(parsed.status).toBe("running")

    // Wait for the spawned task to actually exit, then assert output content.
    await awaitTaskExit(store, parsed.taskId)
    const contents = readFileSync(parsed.outputFile, "utf-8")
    expect(contents).toContain("hello-bg")
  })

  it("runs background commands in the requested cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zap-bash-bg-cwd-"))
    const runtime = process.execPath.replace(/"/g, '\\"')
    const tool = executeCommandTool({ store })
    const result = await tool.handler({
      command: `"${runtime}" -e "console.log(process.cwd())"`,
      cwd,
      run_in_background: true,
    })
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output as string)

    await awaitTaskExit(store, parsed.taskId)
    const contents = readFileSync(parsed.outputFile, "utf-8").trim()
    expect(contents).toBe(realpathSync(cwd))
  })

  it("stamps ownerAgentId on the spawned task when provided", async () => {
    const tool = executeCommandTool({ store, ownerAgentId: "subagent-7" })
    const result = await tool.handler({
      command: "true",
      run_in_background: true,
    })
    const parsed = JSON.parse(result.output as string)
    const snap = store.get(parsed.taskId)
    expect(snap?.ownerAgentId).toBe("subagent-7")
  })

  it("falls through to sync exec when run_in_background is false/absent", async () => {
    const tool = executeCommandTool({ store })
    const result = await tool.handler({ command: "printf 'sync\\n'" })
    expect(result.success).toBe(true)
    expect(result.output).toContain("sync")
  })
})

describe("bash defaultCwd", () => {
  it("resolves relative cwd against defaultCwd for foreground commands", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zap-bash-project-"))
    const otherDir = mkdtempSync(join(tmpdir(), "zap-bash-other-"))
    try {
      mkdirSync(join(projectDir, "packages", "app"), { recursive: true })
      mkdirSync(join(otherDir, "packages", "app"), { recursive: true })

      const runtime = process.execPath.replace(/"/g, '\\"')
      const tool = executeCommandTool({ defaultCwd: projectDir })
      const result = await tool.handler({
        command: `"${runtime}" -e "console.log(process.cwd())"`,
        cwd: "packages/app",
      })

      expect(result.success).toBe(true)
      expect(result.output.trim()).toBe(realpathSync(join(projectDir, "packages", "app")))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it("lets the shell resolve cd paths from defaultCwd", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zap-bash-cd-project-"))
    const otherDir = mkdtempSync(join(tmpdir(), "zap-bash-cd-other-"))
    try {
      mkdirSync(join(projectDir, "packages", "app"), { recursive: true })
      mkdirSync(join(otherDir, "packages", "app"), { recursive: true })

      const runtime = process.execPath.replace(/"/g, '\\"')
      const tool = executeCommandTool({ defaultCwd: projectDir })
      const result = await tool.handler({
        command: `cd packages/app && "${runtime}" -e "console.log(process.cwd())"`,
      })

      expect(result.success).toBe(true)
      expect(result.output.trim()).toBe(realpathSync(join(projectDir, "packages", "app")))
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

describe("foreground command receipts", () => {
  it("surfaces masked failures before stdout without fabricating an exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zap-stderr-"))
    try {
      const result = await executeCommandTool({ defaultCwd: dir }).handler({
        command: "cat missing-input | wc -l; printf done",
      })
      expect(result.success).toBe(true)
      expect(result.runtime?.command).toMatchObject({ exitCode: 0, stderrPresent: true })
      expect(result.output.startsWith("[Shell exited 0 with stderr;")).toBe(true)
      expect(result.output).toContain("missing-input")
      expect(result.output.indexOf("[stderr]")).toBeLessThan(result.output.indexOf("[stdout]"))
      expect(result.output).toContain("done")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("distinguishes benign stderr diagnostics from a failed exit", async () => {
    const tool = executeCommandTool()
    const warning = await tool.handler({ command: "printf warning >&2; printf done" })
    const failure = await tool.handler({ command: "printf broken >&2; exit 7" })
    const clean = await tool.handler({ command: "printf ok" })
    expect(warning.success).toBe(true)
    expect(warning.runtime?.command).toMatchObject({ exitCode: 0, stderrPresent: true })
    expect(failure.success).toBe(false)
    expect(failure.runtime?.command).toMatchObject({ exitCode: 7, stderrPresent: true })
    expect(failure.output).not.toContain("Shell exited 0")
    expect(clean.output).toBe("ok")
    expect(clean.runtime?.command?.stderrPresent).toBeUndefined()
  })

  it("retains diagnostics from earlier successful check steps", async () => {
    const result = await executeCommandTool().handler({ check_steps: ["printf warning >&2", "printf done"] })
    expect(result.success).toBe(true)
    expect(result.runtime?.command).toMatchObject({ exitCode: 0, stderrPresent: true })
    expect(result.runtime?.verification?.steps).toHaveLength(2)
    expect(result.output.startsWith("[Shell exited 0 with stderr;")).toBe(true)
  })

  it("records actual exit codes alongside tool success", async () => {
    const tool = executeCommandTool()
    const success = await tool.handler({ command: "printf ok" }, undefined, { executionId: "receipt-1" })
    const failure = await tool.handler({ command: "exit 7" }, undefined, { executionId: "receipt-2" })
    const noMatch = await tool.handler({ command: "printf alpha | grep NEVER" }, undefined, { executionId: "receipt-3" })
    expect(success.runtime?.command).toMatchObject({ commandRef: "receipt-1", exitCode: 0 })
    expect(failure.runtime?.command).toMatchObject({ commandRef: "receipt-2", exitCode: 7 })
    expect(noMatch.success).toBe(false)
    expect(noMatch.runtime?.command).toMatchObject({ commandRef: "receipt-3", exitCode: 1 })
  })
})

describe("bash structured checks", () => {
  const run = (steps: string[], cwd?: string) => executeCommandTool().handler({
    command: steps.map(step => `(${step})`).join(" && "), check_steps: steps, cwd,
  })

  it("stops after a failed build instead of invoking an existing stale executable", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "zap-check-")))
    try {
      writeFileSync(join(dir, "stale.sh"), "touch stale-used")
      const result = await run(["exit 7", "sh stale.sh"], dir)
      expect(result.success).toBe(false)
      expect(existsSync(join(dir, "stale-used"))).toBe(false)
      expect(result.runtime?.verification).toEqual({ passed: false, steps: [{ command: "exit 7", exitCode: 7 }] })
      expect(result.output).toContain("Check 1/2: exit 7")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it("records every successful step", async () => {
    const result = await run(["printf first", "printf second"])
    expect(result.success).toBe(true)
    expect(result.runtime?.verification?.steps.map(step => step.exitCode)).toEqual([0, 0])
    expect(result.runtime?.verification?.passed).toBe(true)
    expect(result.output).toContain("second")
  })

  it("preserves grep no-match status in explicit verification", async () => {
    const result = await run(["printf alpha | grep NOPE"])
    expect(result.success).toBe(false)
    expect(result.runtime?.verification?.passed).toBe(false)
  })

  it("retains ordinary shell semantics and does not claim verification", async () => {
    const result = await executeCommandTool().handler({ command: "false; printf done" })
    expect(result.success).toBe(true)
    expect(result.runtime?.command?.exitCode).toBe(0)
    expect(result.runtime?.verification).toBeUndefined()
  })

  it("rejects steps not present in the approved command", async () => {
    const result = await executeCommandTool().handler({ command: "printf approved", check_steps: ["printf unapproved"] })
    expect(result.success).toBe(false)
    expect(result.error).toContain("matching")
    expect(result.output).toBe("")
  })

  it("applies sandbox exclusions to the actual check steps", () => {
    const tool = executeCommandTool({ sandboxExcludedCommands: ["docker:*"] })
    const args = { command: "(docker ps) && (printf done)", check_steps: ["docker ps", "printf done"] }
    expect(tool.definition.resolveEffects!(args, { cwd: process.cwd() } as never).process[0].unsandboxed).toBe(true)
  })
})
