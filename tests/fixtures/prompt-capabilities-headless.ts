import { runHeadless } from "../../src/headless/runHeadless.js"
import { createCustomProvider, getDefaultConfig } from "../../src/config.js"

const provider = createCustomProvider({ name: "Fixture", baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture", models: ["fixture"], contextWindow: 128000 })
let prompt = "", tools: string[] = []
const code = await runHeadless({ prompt: "Inspect the fixture.", outputFormat: "json", resultSchema: "outcome-v1",
  permissionMode: "default", continueLast: false, continueOnToolDenial: false, quiet: true, noDevtools: true, dangerouslyDisableOsSandbox: true }, {
  config: { ...getDefaultConfig(), executionBackend: "local", providers: [provider], active: { providerId: provider.id, model: "fixture" } },
  disableSubagent: true, disableRepoMap: true,
  prepareRegistry: async registry => { for (const definition of registry.definitions()) if (definition.name !== "read_file") registry.unregister(definition.name) },
  formatter: { init() {}, onEvent() {}, progress() {}, finalize() {}, failure() {} },
  providerAdapter: () => ({ async call() { throw new Error("stream expected") }, async *stream(messages, definitions) {
    prompt = messages.filter(message => message.role === "system").map(message => message.content).join("\n")
    tools = definitions?.map(definition => definition.name) ?? []
    yield { type: "text_delta", text: "Fixture checked." }
    yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } }
  } }),
})
console.log(JSON.stringify({ code, tools, agentGuidance: prompt.includes("## agent"), planTool: prompt.includes("todo_write"),
  searchTool: prompt.includes("search_files"), globTool: prompt.includes("glob_files"), skillLoading: prompt.includes("via the `skill` tool") }))
process.exit(code)
