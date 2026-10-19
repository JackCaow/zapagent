import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHeadlessApproval } from "../../src/headless/approval.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { z } from "zod"
import { matchDangerousToolCall } from "../../zapsdk/utils/safety.js"

// These are approval decisions only. No destructive command is executed.
describe("destructive shell approval path semantics", () => {
  let root: string
  let workspace: string
  let oldData: string | undefined
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "zap-destructive-approval-")))
    workspace = join(root, "workspace")
    mkdirSync(join(workspace, "nested"), { recursive: true })
    mkdirSync(join(workspace, "nested", "deep"))
    mkdirSync(join(root, "outside"))
    symlinkSync(join(root, "outside"), join(workspace, "escape"), "dir")
    symlinkSync(join(workspace, "nested"), join(workspace, "alias"), "dir")
    symlinkSync(join(workspace, "nested", "deep"), join(workspace, "deep-alias"), "dir")
    oldData = process.env.ZAPCODE_DATA_DIR
    process.env.ZAPCODE_DATA_DIR = join(root, "data")
  })
  afterAll(() => {
    if (oldData === undefined) delete process.env.ZAPCODE_DATA_DIR
    else process.env.ZAPCODE_DATA_DIR = oldData
    rmSync(root, { recursive: true, force: true })
  })
  const decision = (command: string, cwd?: string) => buildHeadlessApproval({
    cwd: workspace, permissionMode: "bypassPermissions",
  }).onApproval("bash", { command, ...(cwd ? { cwd } : {}) })
  const expectNotDangerous = async (command: string) => {
    expect(matchDangerousToolCall({ command }, workspace)).toBeNull()
    expect(await decision(command)).toBe(true)
  }

  for (const command of [
    "rm -rf cache /etc", "rm -r -f /etc", "rm cache -rf /etc",
    "rm -rf ../outside", "cd / && rm -rf etc", "rm -rf escape/child",
    "rm -rf alias/../../outside", 'rm -rf "$DEST"', "rm -rf *",
    "chmod 777 cache /etc", "chmod 0777 /etc", "chmod a+w ../outside",
    "printf ok\nrm -rf /etc", "command rm -rf /etc",
    "sh -c 'rm -rf /etc'",
    "env rm -rf cache /etc", "timeout 5 rm -rf /etc", "xargs rm -rf /etc",
    'echo "$(rm -rf /etc)"', "cd \"$(rm -rf /etc)\"",
    "eval 'rm -rf /etc'", "alias cleanup='rm -rf /etc'",
    "cd -P / && rm -rf etc", "cd -- / && rm -rf etc",
    "sh <<'SCRIPT'\ncd / && rm -rf etc\nSCRIPT",
  ]) {
    it(`retains the guard for ${command}`, async () => {
      expect(await decision(command)).toMatchObject({ approved: false, source: "policy" })
    })
  }
  for (const command of ["rm -rf cache", "rm -rf 'cache name'", "rm -rf alias/cache",
    "echo 'rm -rf /'", "printf '%s' 'chmod 777 /'", "rm -rf -- '-cache'",
    "rm -rf cache > output.txt", "chmod 777 output.txt",
    "env rm -rf cache", "if true; then rm -rf cache; fi",
    "cat <<'DATA'\ncd /\n)\nDATA\nrm -rf cache"]) {
    it(`does not misclassify ${command}`, async () => {
      await expectNotDangerous(command)
    })
  }
  it("follows successful chained cd operations without inventing a failed branch", async () => {
    expect(await decision("cd nested && cd .. && rm -rf cache")).toBe(true)
    expect(await decision("cd / && cd '" + workspace + "' && rm -rf cache")).toBe(true)
    // With ';', failure of the first cd could leave the second at the root.
    expect(await decision("cd missing; cd ..; rm -rf cache")).toMatchObject({ approved: false })
  })
  it("distinguishes logical cd parents from physical symlink parents", async () => {
    expect(await decision("cd deep-alias && cd .. && rm -rf ../outside")).toMatchObject({ approved: false })
    expect(await decision("cd -P deep-alias && cd .. && rm -rf ../cache")).toBe(true)
    expect(await decision("cd deep-alias && cd .. && rm -rf cache")).toBe(true)
    for (const script of ["sh -c 'cd .. && rm -rf ../outside'", "sh <<'SCRIPT'\ncd .. && rm -rf ../outside\nSCRIPT"]) {
      expect(await decision(`cd deep-alias && ${script}`)).toMatchObject({ approved: false })
      await expectNotDangerous(`cd -P deep-alias && ${script}`)
    }
  })
  it("classifies the same workspace child identically with either path spelling", async () => {
    for (const prefix of ["rm -rf", "chmod 777"]) {
      expect(await decision(`${prefix} cache`)).toBe(true)
      expect(await decision(`${prefix} '${workspace}/cache'`)).toBe(true)
    }
    expect(await decision(`rm -rf '${workspace}'`)).toMatchObject({ approved: false })
  })
  it("uses the initial tool cwd and a fresh directory for each structured step", async () => {
    expect(await decision("rm -rf etc", "/")).toMatchObject({ approved: false })
    expect(await decision("rm -rf child", "nested")).toBe(true)
    const steps = ["cd /", "rm -rf cache /etc"]
    const result = await buildHeadlessApproval({ cwd: workspace, permissionMode: "bypassPermissions" })
      .onApproval("bash", { command: steps.map(step => `(${step})`).join(" && "), check_steps: steps })
    expect(result).toMatchObject({ approved: false })
  })
  it("binds approval to the executor workspace rather than its parent host", async () => {
    const child = join(root, "outside")
    const approval = buildHeadlessApproval({ cwd: workspace, permissionMode: "bypassPermissions" })
    const registry = new ToolRegistry()
    let handlers = 0
    registry.register({
      definition: {
        name: "bash", description: "decision-only fixture", permission: "confirm",
        parameters: z.object({ command: z.string(), cwd: z.string().optional() }),
      },
      handler: async () => { handlers++; return { success: true, output: "not executed" } },
    })
    const executor = new ToolExecutor(registry, {
      cwd: child, workspace: { root: child }, onApproval: approval.onApproval,
    })
    expect((await executor.execute("bash", { command: `rm -rf '${child}/cache'` })).success).toBe(true)
    expect((await executor.execute("bash", { command: `rm -rf '${workspace}/cache'` })).success).toBe(false)
    expect((await executor.execute("bash", { command: "rm -rf cache", cwd: workspace })).success).toBe(false)
    expect(handlers).toBe(1)
  })
  it("denies device removal before dispatch and returns the reason to the agent", async () => {
    for (const permissionMode of ["default", "bypassPermissions"] as const) {
      const approval = buildHeadlessApproval({ cwd: workspace, permissionMode })
      const registry = new ToolRegistry()
      let handlers = 0
      registry.register({
        definition: { name: "bash", description: "decision-only fixture", permission: "confirm",
          parameters: z.object({ command: z.string() }) },
        handler: async () => { handlers++; return { success: true, output: "stub only" } },
      })
      const executor = new ToolExecutor(registry, { cwd: workspace, onApproval: approval.onApproval })
      for (const command of ["rm -f /dev/null", "cd /dev && unlink zero"]) {
        const result = await executor.execute("bash", { command })
        expect(result.success).toBe(false)
        expect(result.failure?.code).toBe("POLICY_DENIED")
        expect(result.error).toContain("device_removal")
      }
      expect(handlers).toBe(0)
    }
  })
})
