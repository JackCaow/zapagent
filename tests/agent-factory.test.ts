import { afterEach, describe, it, expect } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointManager } from "../zapsdk/checkpoint/index.js"
import { buildAgentObjects } from "../src/agent-factory.js"
import { getDefaultConfig, type AppConfig, type Provider } from "../src/config.js"
import { DefaultExecutionProcessBroker } from "../zapsdk/execution/process.js"
import type { SandboxExecutionContext } from "../zapsdk/execution/types.js"
import { TransparentExecutionBroker } from "../zapsdk/execution/zapvm.js"

// Regression: prior to v1.6.2 this path threw inside the OpenAI/Anthropic SDK
// constructors when apiKey was empty, which crashed App render before the
// user could ever reach /connect. The fix passes a placeholder key so the
// constructors succeed and the welcome banner can prompt the user to connect.
describe("buildAgentObjects — first-run safety", () => {
  const cleanup: string[] = []
  const originalResidentAgent = process.env.ZAPCODE_RESIDENT_AGENT
  afterEach(() => {
    if (originalResidentAgent === undefined) delete process.env.ZAPCODE_RESIDENT_AGENT
    else process.env.ZAPCODE_RESIDENT_AGENT = originalResidentAgent
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it("sends no authentication headers for explicit keyless connections on either protocol", async () => {
    const requests: { auth: string | null; key: string | null }[] = []
    const server = Bun.serve({ port: 0, fetch: request => {
      requests.push({ auth: request.headers.get("authorization"), key: request.headers.get("x-api-key") })
      return Response.json(new URL(request.url).pathname.endsWith("/responses")
        ? { id: "resp", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } }
        : new URL(request.url).pathname.endsWith("/messages")
        ? { id: "msg", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: "chat", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    } })
    try {
      for (const protocol of ["openai", "anthropic", "openai-responses"] as const) {
        const p: Provider = { id: "local", name: "test", baseURL: `http://127.0.0.1:${server.port}`, apiKey: "",
          authMode: "none", protocol, contextWindow: 128000, models: ["test"] }
        const config = { ...getDefaultConfig(), maxTokens: 512, providers: [p], active: { providerId: p.id, model: "test" } }
        await buildAgentObjects(config).provider.call([{ role: "user", content: "hello" }])
      }
      expect(requests).toEqual(Array(3).fill({ auth: null, key: null }))
    } finally { server.stop() }
  })

  it("enforces a configured request byte limit before either protocol starts transport", async () => {
    for (const protocol of ["openai", "anthropic", "openai-responses"] as const) {
      const provider: Provider = { id: "bounded", name: "bounded", baseURL: "http://127.0.0.1:1",
        apiKey: "", authMode: "none", protocol, contextWindow: 1000000, models: ["test"], maxRequestBytes: 100 }
      const config = { ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "test" } }
      await expect(buildAgentObjects(config).provider.call([{ role: "user", content: "字".repeat(100) }]))
        .rejects.toMatchObject({ name: "RequestBodyLimitError", status: 413 })
    }
  })

  it("does not throw when providers[] is empty (fresh install)", () => {
    const config: AppConfig = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    expect(() => buildAgentObjects(config)).not.toThrow()
  })

  it("does not throw when active provider has empty apiKey (keyless / mid-config)", () => {
    const provider: Provider = {
      id: "p1",
      name: "test",
      baseURL: "https://api.example.com/v1",
      apiKey: "",
      contextWindow: 128000,
      models: ["gpt-4"],
    }
    const config: AppConfig = { ...getDefaultConfig(), providers: [provider], active: { providerId: "p1", model: "gpt-4" } }
    expect(() => buildAgentObjects(config)).not.toThrow()
  })

  it("does not throw for an Anthropic-protocol provider with empty apiKey", () => {
    const provider: Provider = {
      id: "p2",
      name: "anthropic-test",
      baseURL: "https://api.anthropic.com",
      apiKey: "",
      contextWindow: 200000,
      models: ["claude-opus-4-7"],
      protocol: "anthropic",
    }
    const config: AppConfig = { ...getDefaultConfig(), providers: [provider], active: { providerId: "p2", model: "claude-opus-4-7" } }
    expect(() => buildAgentObjects(config)).not.toThrow()
  })

  it("requires App-layer approval for path read tools", () => {
    const config: AppConfig = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const { registry } = buildAgentObjects(config)

    expect(registry.get("read_file")?.definition.permission).toBe("confirm")
    expect(registry.get("list_tree")?.definition.permission).toBe("confirm")
    expect(registry.get("search_files")?.definition.permission).toBe("confirm")
    expect(registry.get("memory_save")?.definition.permission).toBe("confirm")
    expect(registry.get("memory_review")).toBeUndefined()
    expect(registry.get("memory_merge")).toBeUndefined()
  })

  it("keeps shell outside file undo and treats ordinary native backups as optional", async () => {
    const root = mkdtempSync(join(tmpdir(), "zap-factory-coverage-"))
    cleanup.push(root)
    const checkpoint = new CheckpointManager({ sessionId: "factory-coverage", cwd: root, config: { blobDir: join(root, "blobs") } })
    const config: AppConfig = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const { executor } = buildAgentObjects(config, async () => true, undefined, undefined, checkpoint, undefined, root, "disabled")
    const shell = await executor.execute("bash", { command: "printf probe > shell.txt" })
    expect(shell.success).toBe(true)
    expect(readFileSync(join(root, "shell.txt"), "utf8")).toBe("probe")
    expect(shell.runtime?.checkpoint).toBeUndefined()
    const file = await executor.execute("write_file", { path: join(root, "file.txt"), content: "backed up" })
    expect(file.success).toBe(true)
    expect(file.runtime?.checkpoint).toEqual({ attempted: true, covered: true })
    checkpoint.updateConfig({ enabled: false })
    const allowed = await executor.execute("write_file", { path: join(root, "file.txt"), content: "replacement" })
    expect(allowed.success).toBe(true)
    expect(allowed.runtime?.checkpoint).toBeUndefined()
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("replacement")
  })

  it("always installs the transparent runtime router", () => {
    const config: AppConfig = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const { executor } = buildAgentObjects(config)

    expect(executor.executionBroker).toBeInstanceOf(TransparentExecutionBroker)
  })

  it("keeps Resident Agent commands foreground-only and preserves its artifact directory", async () => {
    process.env.ZAPCODE_RESIDENT_AGENT = "1"
    const config: AppConfig = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const { registry } = buildAgentObjects(config)
    const bash = registry.get("bash")!
    const shape = (bash.definition.parameters as any).shape

    expect(shape.command).toBeDefined()
    expect(shape.run_in_background).toBeUndefined()
    expect(shape.network_destinations).toBeDefined()
    expect(bash.definition.description).toContain("execution backend")
    expect(bash.definition.prompt).not.toContain("zap-pkg")

    let preservedEnvironment: string[] | undefined
    const sandbox = {
      provider: "zapvm",
      enforced: true,
      readablePaths: [process.cwd()],
      writablePaths: [process.cwd()],
      protectedPaths: [],
      networkAllowed: false,
      prepareCommand: () => ({ executable: "/usr/bin/true", args: [], env: {}, release: () => {} }),
      prepareShell: (_command, options) => {
        preservedEnvironment = options.preserveEnvironment
        return { executable: "/usr/bin/true", args: [], env: {}, release: () => {} }
      },
    } satisfies SandboxExecutionContext
    const result = await bash.handler(
      { command: "true" },
      undefined,
      { process: new DefaultExecutionProcessBroker(sandbox) },
    )

    expect(result.success).toBe(true)
    expect(preservedEnvironment).toEqual(["ZAPVM_ARTIFACT_DIR"])
  })

  it("bounds isolated writing registries to their workspace and exposes brokered bash", async () => {
    const parent = mkdtempSync(join(tmpdir(), "zap-agent-registry-"))
    cleanup.push(parent)
    const workspace = join(parent, "workspace")
    const outside = join(parent, "outside.txt")
    const config: AppConfig = { ...getDefaultConfig(), providers: [], active: { providerId: "", model: "" } }
    const { createRegistryForCwd } = buildAgentObjects(config)
    const registry = createRegistryForCwd!(workspace)

    expect(registry.has("bash")).toBe(true)
    expect(registry.get("bash")?.definition.sandboxAware).toBe(true)
    const result = await registry.get("write_file")!.handler({
      path: outside,
      content: "escaped\n",
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("not allowed")
    expect(existsSync(outside)).toBe(false)
  })
})
