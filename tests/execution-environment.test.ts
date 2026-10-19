import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionEnvironment, resolveExecutionBackend } from "../src/execution-environment.js"
import { buildAgentObjects } from "../src/agent-factory.js"
import { buildSystemPrompt, getDefaultConfig } from "../src/config.js"
import type { ExecutionEnvironmentFacts } from "../zapsdk/execution/types.js"
import { createCapabilityGrant } from "../zapsdk/policy/engine.js"
import { emptyToolEffects } from "../zapsdk/tools/effects.js"
import { z } from "zod"
import { localExecutionShell } from "../zapsdk/execution/shell.js"

const keys = ["ZAPCODE_EXECUTION", "ZAPCODE_RESIDENT_AGENT", "ZAPCODE_DISABLE_ZAPVM", "ZAPCODE_ZAPVM_CLOUD_CONFIG", "ZAPVM_ARTIFACT_DIR", "ZAPCODE_DISABLE_BACKGROUND_TASKS", "SHELL", "PSModulePath"] as const
let saved: Array<string | undefined>
let root: string
beforeEach(() => {
  saved = keys.map(key => process.env[key])
  root = mkdtempSync(join(tmpdir(), "zap-environment-"))
})
afterEach(() => {
  keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  })
  rmSync(root, { recursive: true, force: true })
})

describe("Agent / execution environment boundary", () => {
  it("describes the execution shell in default/custom prompts and both registries", async () => {
    delete process.env.ZAPCODE_RESIDENT_AGENT
    process.env.SHELL = "/bin/zsh"
    process.env.PSModulePath = "parent-terminal-powershell"
    const config = getDefaultConfig()
    const environment = createExecutionEnvironment(root, "disabled", "local")
    const agent = buildAgentObjects(config, undefined, undefined, undefined, null, undefined,
      root, "disabled", environment)
    const shell = localExecutionShell().executable
    for (const registry of [agent.registry, agent.createRegistryForCwd!(root)]) {
      expect(registry.get("bash")!.definition.description).toContain(JSON.stringify(shell))
    }
    for (const customSystemPrompt of ["", "Follow the task instructions."]) {
      const prompt = buildSystemPrompt({ ...config, customSystemPrompt }, root, undefined,
        new Set(), undefined, agent.executionFacts)
      expect(prompt).toContain(`Shell: ${shell}`)
      expect(prompt).not.toContain("Shell: zsh")
      expect(prompt).not.toContain("Shell: PowerShell")
    }
    if (process.platform !== "win32") {
      const result = await agent.registry.get("bash")!.handler({ command: 'printf "%s" "$0"' })
      expect(result.success).toBe(true)
      expect(result.output).toBe(shell)
    }
  })

  it("honors the user's background-task setting through the local App registry", () => {
    delete process.env.ZAPCODE_RESIDENT_AGENT
    for (const setting of [undefined, "0", "1"]) {
      if (setting === undefined) delete process.env.ZAPCODE_DISABLE_BACKGROUND_TASKS
      else process.env.ZAPCODE_DISABLE_BACKGROUND_TASKS = setting
      const environment = createExecutionEnvironment(root, "required", "local")
      const agent = buildAgentObjects(getDefaultConfig(), undefined, undefined, undefined, null, undefined,
        root, "required", environment)
      const schema = z.toJSONSchema(agent.registry.get("bash")!.definition.parameters)
      expect(Boolean(schema.properties?.run_in_background)).toBe(setting !== "1")
      const childSchema = z.toJSONSchema(agent.createRegistryForCwd!(root).get("bash")!.definition.parameters)
      expect(childSchema.properties?.run_in_background).toBeUndefined()
    }
  })

  it("keeps resident background execution disabled even when the env switch permits it", () => {
    process.env.ZAPCODE_RESIDENT_AGENT = "1"
    process.env.ZAPCODE_DISABLE_BACKGROUND_TASKS = "0"
    const environment = createExecutionEnvironment(root, "required", "local")
    const agent = buildAgentObjects(getDefaultConfig(), undefined, undefined, undefined, null, undefined,
      root, "required", environment)
    const schema = z.toJSONSchema(agent.registry.get("bash")!.definition.parameters)
    expect(schema.properties?.run_in_background).toBeUndefined()
  })

  it("does not silently cap the declared delegation budget at 120 seconds", async () => {
    process.env.ZAPCODE_DISABLE_ZAPVM = "1"
    delete process.env.ZAPCODE_RESIDENT_AGENT
    const environment = createExecutionEnvironment(root, "required")
    const effects = emptyToolEffects()
    const budget = 1_230_000
    const result = await environment.broker.execute({
      executionId: "execution:declared-delegate", name: "delegate_agent", args: {}, effects,
      workspace: { root }, grant: createCapabilityGrant("call", effects, Date.now() + budget),
      limits: { timeoutMs: budget },
      tool: { definition: { name: "delegate_agent", description: "test", parameters: z.object({}),
        executionLocation: "host", timeoutMs: budget },
        handler: async (_args, _signal, context) => ({ success: true, output: String(context?.limits?.timeoutMs) }) },
    })
    expect(result).toMatchObject({ success: true, output: String(budget) })
  })

  it("does not discover a nested runtime inside a resident process", () => {
    process.env.ZAPCODE_RESIDENT_AGENT = "1"
    process.env.ZAPVM_ARTIFACT_DIR = "/workspace/artifacts/task-1"
    delete process.env.ZAPCODE_DISABLE_ZAPVM
    const invalid = join(root, "invalid-cloud.json")
    writeFileSync(invalid, "not JSON", { mode: 0o600 })
    process.env.ZAPCODE_ZAPVM_CLOUD_CONFIG = invalid
    const environment = createExecutionEnvironment(root, "required")
    expect(environment.commandOptions.disableBackgroundTasks).toBe(true)
    expect(environment.commandOptions.preserveEnvironment).toEqual(["ZAPVM_ARTIFACT_DIR"])
    expect(environment.facts?.workspace).toBe("native")
    expect(environment.facts?.outputDirectory).toBe("/workspace/artifacts/task-1")
    delete process.env.ZAPCODE_RESIDENT_AGENT
    expect(() => createExecutionEnvironment(root, "required", "vm")).toThrow("not valid JSON")
  })

  it("runs on the host sandbox by default and only consults a VM when selected", () => {
    delete process.env.ZAPCODE_RESIDENT_AGENT
    delete process.env.ZAPCODE_DISABLE_ZAPVM
    const invalid = join(root, "invalid-cloud.json")
    writeFileSync(invalid, "not JSON", { mode: 0o600 })
    process.env.ZAPCODE_ZAPVM_CLOUD_CONFIG = invalid
    const local = createExecutionEnvironment(root, "required")
    expect(local.facts).toBeUndefined()
    expect(local.capacity?.source).toBe("local-process")
    expect(local.commandOptions.restrictedNetwork).toBe(false)
    expect(() => createExecutionEnvironment(root, "required", "vm")).toThrow("not valid JSON")
  })

  it("offers the sandbox escape only on the host sandbox", () => {
    delete process.env.ZAPCODE_RESIDENT_AGENT
    delete process.env.ZAPCODE_ZAPVM_CLOUD_CONFIG
    const local = createExecutionEnvironment(root, "required", "local")
    expect(local.commandOptions).toMatchObject({ allowUnsandboxed: true, sandboxNetwork: true })
    const disabled = createExecutionEnvironment(root, "required", "local", false)
    expect(disabled.commandOptions.allowUnsandboxed).toBe(false)
    process.env.ZAPCODE_RESIDENT_AGENT = "1"
    const resident = createExecutionEnvironment(root, "required", "vm")
    expect(resident.commandOptions.allowUnsandboxed).toBe(false)
    expect(resident.commandOptions.sandboxNetwork).toBeUndefined()
  })

  it("lets ZAPCODE_EXECUTION override the configured backend", () => {
    expect(resolveExecutionBackend()).toBe("local")
    expect(resolveExecutionBackend("vm")).toBe("vm")
    process.env.ZAPCODE_EXECUTION = "local"
    expect(resolveExecutionBackend("vm")).toBe("local")
    process.env.ZAPCODE_EXECUTION = "VM"
    expect(resolveExecutionBackend("local")).toBe("vm")
    process.env.ZAPCODE_EXECUTION = "bogus"
    expect(resolveExecutionBackend("vm")).toBe("vm")
  })

  it("accepts another backend without consulting VM installation or altering model/tool policy", () => {
    process.env.ZAPCODE_ZAPVM_CLOUD_CONFIG = join(root, "missing.json")
    delete process.env.ZAPCODE_DISABLE_ZAPVM
    const config = getDefaultConfig()
    const broker = {
      sandboxStatus: () => ({ provider: "none" as const, available: false }),
      execute: async () => ({ success: false, output: "", error: "backend unavailable" }),
    }
    const facts: ExecutionEnvironmentFacts = {
      processPlatform: "linux", shell: "bash", workspace: "mapped",
      rootFilesystem: "read-only", temporaryStorage: "request", network: "off",
    }
    const agent = buildAgentObjects(config, undefined, undefined, undefined, null, undefined,
      root, "required", { broker, commandOptions: {}, facts })
    expect(agent.executor.executionBroker).toBe(broker)
    expect(agent.modelId).toBe(config.active.model)
    expect(agent.executionFacts).toEqual(facts)
    expect(agent.executionCapacity).toBeUndefined()
    expect(agent.registry.get("bash")!.definition.description).toContain('"bash"')
    expect(agent.createRegistryForCwd!(root).get("bash")!.definition.description).toContain('"bash"')
    expect(agent.registry.get("bash")?.definition.executionLocation).toBe("workspace")
    expect(agent.registry.get("bash")?.definition.prompt).not.toMatch(/zapvm|zap-pkg|immutable|terminal policy/i)
    expect(agent.createRegistryForCwd!(root).get("bash")?.definition.executionLocation).toBe("workspace")
    const prompt = buildSystemPrompt(config, root, undefined, new Set(), undefined, agent.executionFacts)
    expect(prompt).toContain('"shell":"bash"')
    expect(prompt).toContain("Shell: bash")
    expect(buildSystemPrompt({ ...config, customSystemPrompt: "Custom instructions" }, root,
      undefined, new Set(), undefined, agent.executionFacts)).toContain("Shell: bash")
    expect(prompt).not.toMatch(/VM transport|never fall back|do not retry|report it instead of bootstrapping/i)
    process.env.ZAPCODE_RESIDENT_AGENT = "1"
    expect(buildSystemPrompt(config, root, undefined, new Set(), undefined, agent.executionFacts)).toBe(prompt)
  })
})
