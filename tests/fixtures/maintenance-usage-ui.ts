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
const singleton = await import(root + "/src/singletons.ts")
mock.module(root + "/src/singletons.ts", () => ({ ...singleton,
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
const { ConversationManager } = await import(root + "/zapsdk/memory/conversation.ts")
const { REQUIRED_COMPACT_SUMMARY_HEADINGS } = await import(root + "/zapsdk/context/autocompact.ts")
const attachments = await import(root + "/src/agent/contextAttachments.ts");
mock.module(root + "/src/agent/contextAttachments.ts", () => ({...attachments, buildPerTurnAttachments: async () => ({}) }));
const repoMap = await import(root + "/src/agent/repoMap.ts");
mock.module(root + "/src/agent/repoMap.ts", () => ({...repoMap, buildRepoMapAttachment: async () => ({text:"",selectedFiles:[],revision:"",tokenBudget:0,truncated:false})}));
const wire = await import(root + "/src/agent/wireRunHandlers.ts");
const originalCreateRunHandlers = wire.createRunHandlers;
let uiSnapshots: unknown[] = [];
mock.module(root + "/src/agent/wireRunHandlers.ts", () => ({...wire, createRunHandlers(deps: any) {
  const h=originalCreateRunHandlers(deps);const listeners = new Map<string, any[]>();
  h.wire({on(name: string, fn: any) {listeners.set(name,[...(listeners.get(name)??[]),fn]);}});
  for (const purpose of ["main","maintenance"]) {
    const before = stateUpdates.length;
    for(const fn of listeners.get("run_usage")??[]) fn({type:"run_usage",step:1,purpose,inputTokens:purpose==="main"?500:50,outputTokens:10});
    uiSnapshots.push({purpose, functionalUpdates: stateUpdates.slice(before).filter(v => typeof v === "function").length, updates:stateUpdates.slice(before).filter(v=>typeof v!=="function")});
  }
  throw new Error("END_AFTER_USAGE");
}}));
const { useAgentRunner } = await import(root + "/src/hooks/useAgentRunner.ts")
const summary = REQUIRED_COMPACT_SUMMARY_HEADINGS.map((heading: string) => `# ${heading}\nSynthetic fixture facts.`).join("\n\n")
const config = getDefaultConfig()
const selected = createCustomProvider({ name: "fixture", baseURL: "https://fixture.invalid", apiKey: "", models: ["fixture"], contextWindow: 10000 })
config.providers = [selected]; config.active = { providerId: selected.id, model: "fixture" }
config.compaction.auto = false; config.compaction.reserved = 1000; config.maxTokens = 1000
const conversation = new ConversationManager({ maxMessages: 1000, maxTokens: 1000000 })
for (let i = 0; i < 30; i++) conversation.add({ role: i % 2 ? "assistant" : "user", content: "history ".repeat(1000) })
const before = conversation.estimatedTokens
let calls = 0, compactCompleted = false
const hook = useAgentRunner({ currentSessionId: "fixture", config, conversation,
  agentRef: { current: {
    provider: { async call() { calls++; return { type: "text", text: summary, usage: { inputTokens: 100, outputTokens: 20 } } } },
    registry: { definitions() { return [] }, toolPrompts() {return ""} }, executor: {},
  } },
  autoMemory: { buildInstructions: async () => "" }, agentLogger: {},
  addLog: (...args: unknown[]) => logs.push(args), replaceLog() {}, peekNextLogId: () => 0,
  compactLogs() { compactCompleted = true }, checkpoint: null, todoStore: {},
  turnStartLogIndexRef: { current: 0 }, turnStartUiLogIndexRef: { current: 0 },
})
await hook.runAgent("fixture")
console.log(JSON.stringify({ calls, compactCompleted, before, after: conversation.estimatedTokens,
  journalRows: journals.length, warnings, logs, uiSnapshots, stateUpdates: stateUpdates.filter(value => typeof value !== "function") }))
process.exit(0)
