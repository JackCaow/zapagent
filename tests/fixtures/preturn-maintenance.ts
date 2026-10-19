// Run in a subprocess: React/module mocks must not escape into the main suite.
import { mock } from "bun:test"
import { resolve } from "node:path"
const root = resolve(import.meta.dir, "../..")
const react = await import("react")
const warnings: unknown[] = [], journals: unknown[] = [], logs: unknown[] = [], stateUpdates: unknown[] = []
mock.module("react", () => ({ ...react,
  useState: (initial: any) => [typeof initial === "function" ? initial() : initial, (value: any) => stateUpdates.push(value)],
  useCallback: (fn: any) => fn, useRef: (value: any) => ({ current: value }), useEffect() {},
  useMemo: (fn: any) => fn(), useSyncExternalStore: (_subscribe: any, get: any) => get(),
}))
const { ConversationManager } = await import(root + "/zapsdk/memory/conversation.ts")
const conversation = new ConversationManager({ maxMessages: 1000, maxTokens: 1000000 })
const singleton = await import(root + "/src/singletons.ts")
mock.module(root + "/src/singletons.ts", () => ({ ...singleton, conversation,
  appLogger: { warn: (...args: unknown[]) => warnings.push(args), info() {} },
  delegateEventBridge: {}, tokenAccounting: { promptOverhead: 0 },
}))
const session = await import(root + "/src/session.ts")
mock.module(root + "/src/session.ts", () => ({ ...session,
  appendUsage: (...args: unknown[]) => {
    if (process.env.FAIL_USAGE_WRITE === "1") throw new Error("fixture journal unavailable")
    journals.push(args)
  }, saveLastOutput() {}, getCurrentSessionId: () => "fixture",
}))
const memory = await import(root + "/src/agent/memoryDiagnostics.ts")
mock.module(root + "/src/agent/memoryDiagnostics.ts", () => ({ ...memory, persistCompactSummaryBestEffort() {} }))
const { getDefaultConfig, createCustomProvider } = await import(root + "/src/config.ts")
const { REQUIRED_COMPACT_SUMMARY_HEADINGS } = await import(root + "/zapsdk/context/autocompact.ts")
const { useAgentRunner } = await import(root + "/src/hooks/useAgentRunner.ts")
const summary = REQUIRED_COMPACT_SUMMARY_HEADINGS.map((heading: string) => `# ${heading}\nSynthetic fixture facts.`).join("\n\n")
const config = getDefaultConfig()
const selected = createCustomProvider({ name: "fixture", baseURL: "https://fixture.invalid", apiKey: "", models: ["fixture"], contextWindow: 10000 })
config.providers = [selected]; config.active = { providerId: selected.id, model: "fixture" }
config.compaction.reserved = 1000; config.maxTokens = 1000
for (let i = 0; i < 30; i++) conversation.add({ role: i % 2 ? "assistant" : "user", content: "history ".repeat(1000) })
const before = conversation.estimatedTokens
let calls = 0, compactCompleted = false
const options = { currentSessionId: "fixture", config, conversation,
  agentRef: { current: {
    provider: { async call() { calls++; return { type: "text", text: summary, usage: { inputTokens: 100, outputTokens: 20 } } } },
    registry: { definitions() { throw new Error("END_AFTER_PRETURN") } }, executor: {},
  } },
  autoMemory: { buildInstructions: async () => "" }, agentLogger: {},
  addLog: (...args: unknown[]) => logs.push(args), replaceLog() {}, peekNextLogId: () => 0,
  compactLogs() { compactCompleted = true }, checkpoint: null, todoStore: {},
  turnStartLogIndexRef: { current: 0 }, turnStartUiLogIndexRef: { current: 0 },
}
if (process.env.COMPACT_MODE === "manual") {
  const { dispatchSlashCommand } = await import(root + "/src/commands/dispatcher.ts")
  await dispatchSlashCommand("/compact", { agentRef: options.agentRef, configRef: { current: config },
    setStatus() {}, addLog: options.addLog, addToast: (text: string) => logs.push(text), compactLogs: options.compactLogs,
    getContextTokens: () => before,
  })
} else {
  const hook = useAgentRunner(options)
  await hook.runAgent("fixture")
}
console.log(JSON.stringify({ calls, compactCompleted, before, after: conversation.estimatedTokens,
  journalRows: journals.length, warnings, logs, stateUpdates: stateUpdates.filter(value => typeof value !== "function") }))
process.exit(0)
