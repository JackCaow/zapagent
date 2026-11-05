import { afterAll, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeCommandTool } from "../../builtin-tools/command.js"
import { DefaultExecutionBroker } from "../../execution/broker.js"
import { NetworkProxy, destinationHostPattern } from "../../execution/network-proxy.js"
import { createPlatformSandbox } from "../../execution/sandbox.js"
import { ToolExecutor } from "../../tools/executor.js"
import { ToolRegistry } from "../../tools/registry.js"

describe("declared shell network destinations", () => {
  it("reduces declarations to host patterns", () => {
    expect(destinationHostPattern("https://API.Example.com:8443/v1?q=1")).toBe("api.example.com")
    expect(destinationHostPattern("*.example.com")).toBe("*.example.com")
    expect(destinationHostPattern("example.com.")).toBe("example.com")
    for (const value of ["*", "localhost", "", "exa mple.com", "*.*.com", "file:///etc/hosts", "-x.com"]) {
      expect(destinationHostPattern(value)).toBeNull()
    }
  })

  it("offers network_destinations only where the host sandbox filters egress", () => {
    const declared = executeCommandTool({ disableBackgroundTasks: true, sandboxNetwork: true, declaredNetwork: true }).definition
    const plain = executeCommandTool({ disableBackgroundTasks: true, sandboxNetwork: true }).definition
    expect(JSON.stringify(declared.rawSchema)).toContain("network_destinations")
    expect(JSON.stringify(plain.rawSchema)).not.toContain("network_destinations")
    expect(declared.prompt).toContain("Do not use dangerouslyDisableSandbox for network access")
    const effects = declared.resolveEffects!({ command: "curl https://api.example.com", network_destinations: ["api.example.com"] }, { cwd: process.cwd(), toolName: "bash" })
    expect(effects.network).toEqual([{ kind: "network", operation: "connect", destinations: ["*", "api.example.com"], methods: [] }])
  })

  it("hands approved shell declarations to the sandbox context, and nothing else", async () => {
    const seen: Array<string[] | undefined> = []
    const registry = new ToolRegistry()
    registry.register(executeCommandTool({ defaultCwd: process.cwd(), disableBackgroundTasks: true, sandboxNetwork: true, declaredNetwork: true }))
    const executor = new ToolExecutor(registry, {
      cwd: process.cwd(),
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({
        sandboxMode: "required",
        sandbox: {
          status: () => ({ provider: "macos-seatbelt", available: true }),
          createContext: (input) => { seen.push(input.declaredNetworkDomains); throw new Error("fixture: no process runs") },
        },
      }),
    })
    await executor.execute("bash", { command: "true", network_destinations: ["https://api.example.com/x", "*.cdn.example.com", "*", "not a host"] })
    await executor.execute("bash", { command: "true" })
    expect(seen).toEqual([["api.example.com", "*.cdn.example.com"], []])
  })
})

const macDescribe = process.platform === "darwin" && createPlatformSandbox().status().available ? describe : describe.skip
macDescribe("macOS Seatbelt admits a declared host for one command", () => {
  const proxy = new NetworkProxy(() => ({ allowedDomains: [] }))
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-declared-net-")))
  afterAll(() => { proxy.close(); rmSync(root, { recursive: true, force: true }) })

  async function status(declared?: string[]): Promise<string> {
    const sandbox = createPlatformSandbox({ networkProxy: proxy, tempRoot: join(root, "tmp") })
    const context = sandbox.createContext({
      executionId: "t", workspace: { root, mode: "root-integration" } as never,
      effects: { filesystem: [], network: [], process: [], external: [], workspace: { mode: "root-integration" }, confidence: "declared" } as never,
      grant: { filesystem: { read: [root], write: [root] }, network: { destinations: ["*"], methods: [] } } as never,
      declaredNetworkDomains: declared,
    })
    // `.example` never resolves: an admitted host fails DNS (502), a refused one gets 403.
    const prepared = context.prepareShell("/usr/bin/curl -s --max-time 8 -o /dev/null -w '%{http_code}' http://declared.example/", { cwd: root })
    try {
      return await new Promise((resolve) => {
        const child = spawn(prepared.executable, prepared.args, { env: prepared.env, cwd: root })
        let stdout = ""
        child.stdout.on("data", (d) => { stdout += d.toString() })
        child.on("close", () => resolve(stdout))
      })
    } finally { prepared.release?.() }
  }

  it("refuses the host without a declaration and admits it with one", async () => {
    expect(await status()).toBe("403")
    // Admitted means the proxy tried the host: any answer but its own 403.
    expect(await status(["declared.example"])).not.toBe("403")
    // The declaration did not leak into the shared proxy.
    expect(await status()).toBe("403")
  }, 60_000)
})
