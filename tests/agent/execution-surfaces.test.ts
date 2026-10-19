import { describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { z } from "zod"
import { AcpEventMapper } from "../../src/acp/events.js"
import { createRunHandlers } from "../../src/agent/wireRunHandlers.js"
import { createFormatter } from "../../src/headless/formatter.js"
import type { ToolCallInfo } from "../../src/ui/types.js"
import type { AgentEvent } from "../../zapsdk/agent/events.js"
import { DefaultExecutionBroker } from "../../zapsdk/execution/broker.js"
import { emptyToolEffects } from "../../zapsdk/tools/effects.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"

describe("shared TUI / headless / ACP execution contract", () => {
  for (const unavailable of [true, false]) {
    it(`preserves ${unavailable ? "backend unavailability" : "unknown legacy failure"} on every output surface`, async () => {
      const effects = emptyToolEffects()
      if (unavailable) effects.process.push({ kind: "process", operation: "spawn" })
      const registry = new ToolRegistry()
      registry.register({ definition: { name: "probe", description: "probe", parameters: z.object({}),
        sandboxAware: true, resolveEffects: () => effects },
        handler: async () => ({ success: false, output: "", error: "opaque sandbox denied" }) })
      const broker = new DefaultExecutionBroker({ sandboxMode: "required", sandbox: {
        status: () => ({ provider: "none", available: false }),
        createContext: () => { throw new Error("unreachable") },
      } })
      const result = await new ToolExecutor(registry, { cwd: tmpdir(), executionBroker: broker })
        .execute("probe", {}, undefined, { sessionId: "thread", toolCallId: "call", step: 1 })
      expect(result.failure?.code).toBe(unavailable ? "BACKEND_UNAVAILABLE" : "EXECUTION_FAILED")
      const event: AgentEvent = { type: "content_final", kind: "tool_result", id: "call",
        step: 1, toolName: "probe", result }

      let logged: ToolCallInfo | undefined
      const listeners = new Map<string, (event: AgentEvent) => void>()
      createRunHandlers({
        currentConfig: { providers: [], active: { providerId: "", model: "" }, serperKey: "",
          maxTokens: 100, maxSteps: 10, customSystemPrompt: "", compaction: { auto: true, prune: true, reserved: 0 },
          mcpServers: [], permissionMode: "default" },
        controller: new AbortController(), preview: { interruptPreviews: () => {} } as any,
        setStatus: () => {}, setStep: () => {}, setActiveTool: () => {}, setActiveToolBytes: () => {},
        setContextTokens: () => {}, setContextPending: () => {},
        addLog: (_type, _text, tool) => { logged = tool }, replaceLog: () => {},
        peekNextLogId: () => 1, compactLogs: () => {},
      }).wire({ on: (type: string, listener: (event: AgentEvent) => void) => { listeners.set(type, listener) } } as any)
      listeners.get("content_final")!(event)
      const meta = logged?.meta as { failure: unknown; runtime: { execution: unknown } }
      expect(logged?.success).toBe(false)
      expect(meta.failure).toEqual(result.failure!)
      expect(meta.runtime.execution).toEqual(result.runtime!.execution!)

      let output = ""
      const write = process.stdout.write
      try {
        process.stdout.write = ((chunk: string | Uint8Array) => {
          output += String(chunk)
          return true
        }) as typeof process.stdout.write
        createFormatter("stream-json", true).onEvent(event)
      } finally {
        process.stdout.write = write
      }
      const headless = JSON.parse(output)
      expect(headless.failure).toEqual(result.failure!)
      expect(headless.execution).toEqual(result.runtime!.execution!)
      expect(headless.error).toBe(result.error!)
      const [acp] = new AcpEventMapper("turn").map(event)
      expect(acp).toMatchObject({ status: "failed", rawOutput: {
        failure: result.failure, runtime: { execution: result.runtime?.execution },
      } })
    })
  }
})
