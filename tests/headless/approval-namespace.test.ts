import { describe, expect, it } from "bun:test"
import { z } from "zod"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchDangerousToolCall } from "../../zapsdk/utils/safety.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { DefaultExecutionBroker } from "../../zapsdk/execution/broker.js"
import { TransparentExecutionBroker } from "../../zapsdk/execution/zapvm.js"
import type { ApprovalContext } from "../../zapsdk/tools/executor.js"

describe("approval execution namespace", () => {
  it("uses guest lexical paths without claiming host symlinks describe the guest", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-guest-approval-")))
    try {
      mkdirSync(join(root, "nested"))
      symlinkSync("/", join(root, "escape"), "dir")
      const guest = { syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace" } as const
      const check = (command: string, cwd?: string) => matchDangerousToolCall({ command, cwd }, root, root, guest)
      expect(check("rm -rf /workspace/cache")).toBeNull()
      expect(check("rm -rf ../cache", "nested")).toBeNull()
      expect(check("rm -rf /workspace/escape/cache")).toBeNull()
      expect(check("rm -rf cache /etc")?.id).toBe("rm_recursive_system_path")
      expect(check("cd / && rm -rf etc")?.id).toBe("rm_recursive_system_path")
      expect(check("rm -rf child", "/outside-host-workspace")?.id).toBe("rm_recursive_system_path")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("does not interpret cmd or unknown backends as a POSIX filesystem", () => {
    for (const environment of [
      { syntax: "cmd", filesystem: "host" },
      { syntax: "unknown", filesystem: "unknown" },
    ] as const) {
      // These retain legacy signals, not a claim of complete native syntax support.
      expect(matchDangerousToolCall({ command: "echo 'rm -rf /'" }, "missing", "missing", environment)?.id)
        .toBe("rm_recursive_system_path")
      expect(matchDangerousToolCall({ command: "rm -rf cache" }, "missing", "missing", environment)).toBeNull()
      expect(matchDangerousToolCall({ command: "rm -rf cache; rm -rf /etc" }, "missing", "missing", environment)?.id)
        .toBe("rm_recursive_system_path")
    }
  })

  it("routes trusted facts with the actual backend and ignores forged tool arguments", async () => {
    const registry = new ToolRegistry()
    registry.register({ definition: { name: "bash", description: "probe", permission: "confirm",
      executionLocation: "workspace", parameters: z.object({ command: z.string() }).passthrough() },
      handler: async () => ({ success: true, output: "unused" }) })
    const broker = new TransparentExecutionBroker({
      local: new DefaultExecutionBroker({ shellEnvironment: { syntax: "cmd", filesystem: "host" } }),
      vm: new DefaultExecutionBroker({ shellEnvironment: { syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace" } }),
    })
    const seen: ApprovalContext[] = []
    const executor = new ToolExecutor(registry, { cwd: process.cwd(), executionBroker: broker,
      onApproval: async (_name, _args, _signal, context) => { seen.push(context!); return false } })
    await executor.execute("bash", { command: "echo ok", executionLocation: "host", shell: { filesystem: "host" } })
    expect(seen[0].shell).toEqual({ syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace" })
    expect(Object.isFrozen(seen[0].shell)).toBe(true)
    expect(broker.shellEnvironment({ name: "bash", executionLocation: "host" })).toEqual({ syntax: "cmd", filesystem: "host" })
    const custom = new ToolExecutor(registry, { executionBroker: { sandboxStatus: () => ({ provider: "none", available: false }),
      execute: async () => { throw new Error("must not execute") } },
      onApproval: async (_name, _args, _signal, context) => { seen.push(context!); return false } })
    await custom.execute("bash", { command: "echo ok" })
    expect(seen[1].shell).toEqual({ syntax: "unknown", filesystem: "unknown" })
  })
})
