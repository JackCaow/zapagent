import { describe, expect, it } from "bun:test"
import { buildAgentObjects } from "../src/agent-factory.js"
import { getDefaultConfig, type Provider } from "../src/config.js"
import type { ImageContent, Message } from "../zapsdk/core/types.js"
import { LoopAgent } from "../zapsdk/agent/loop.js"
import { ConversationManager } from "../zapsdk/memory/conversation.js"
import { ToolRegistry } from "../zapsdk/tools/registry.js"
import { ToolExecutor } from "../zapsdk/tools/executor.js"

type WireRequest = { messages: { role: string; tool_call_id?: string;
  content: string | { type: string; image_url?: { url: string } }[] }[] }
const imageCount = (request: WireRequest) => request.messages
  .flatMap(m => Array.isArray(m.content) ? m.content : [])
  .filter(b => b.type === "image_url").length

const image: ImageContent = {
  type: "image", filePath: "/tmp/fixture.png", mediaType: "image/png",
  base64: "AAAA", source: "tool",
}

function factory(port: number, capabilities: Partial<Provider> = {}) {
  const provider: Provider = {
    id: "vision-fixture", name: "fixture", baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "", authMode: "none", protocol: "openai", contextWindow: 128000,
    models: ["custom-model-alias"], ...capabilities,
  }
  return buildAgentObjects({ ...getDefaultConfig(), maxTokens: 512, providers: [provider],
    active: { providerId: provider.id, model: provider.models[0]! } })
}

describe("App factory vision transport", () => {
  for (const [label, capabilities, expectedImages] of [
    ["unknown capability", {}, 2],
    ["explicitly disabled", { visionByModel: { "custom-model-alias": false } }, 0],
    ["catalog disabled", { modelMetadata: { "custom-model-alias": { supportsVision: false, source: "models.dev" } } }, 0],
    ["explicit override of catalog", { visionByModel: { "custom-model-alias": true },
      modelMetadata: { "custom-model-alias": { supportsVision: false, source: "models.dev" } } }, 2],
  ] as const) {
    it(`preserves user and tool evidence according to ${label}`, async () => {
      const requests: WireRequest[] = []
      const server = Bun.serve({ port: 0, async fetch(request) {
        requests.push(await request.json())
        return Response.json({ id: "chat", choices: [{ index: 0,
          message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
      } })
      try {
        const messages: Message[] = [
          { role: "user", content: "inspect", contentBlocks: [{ ...image, source: "clipboard" }] },
          { role: "assistant", content: "", toolCalls: [{ id: "read", name: "read_file", arguments: {} }] },
          { role: "tool_result", toolCallId: "read", content: "image read", contentBlocks: [image] },
        ]
        const before = JSON.stringify(messages)
        await factory(server.port!, capabilities).provider.call(messages)
        expect(requests).toHaveLength(1)
        const wire = requests[0].messages
        expect(imageCount(requests[0]!)).toBe(expectedImages)
        expect(wire.find(m => m.role === "tool")?.tool_call_id).toBe("read")
        expect(JSON.stringify(messages)).toBe(before)
      } finally { server.stop() }
    })
  }

  for (const outcome of ["supported", "schema rejection", "repeated rejection", "policy refusal"] as const) {
    it(`handles ${outcome} without losing canonical images or unbounded recovery`, async () => {
      const requests: WireRequest[] = []
      let heals = 0
      const server = Bun.serve({ port: 0, async fetch(request) {
        requests.push(await request.json())
        if (outcome === "policy refusal") return Response.json({ error: {
          message: "Request refused by safety policy", type: "policy_refusal" } }, { status: 400 })
        if (outcome === "repeated rejection" || (outcome === "schema rejection" && requests.length === 1)) {
          return Response.json({ error: { message: "unknown variant image_url, expected `text`",
            type: "invalid_request_error" } }, { status: 400 })
        }
        return new Response(`data: ${JSON.stringify({ id: "chat", choices: [{ index: 0,
          delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } })
      } })
      try {
        const conversation = new ConversationManager({ maxMessages: 200 })
        const registry = new ToolRegistry()
        const agent = new LoopAgent({ provider: factory(server.port!).provider, registry,
          executor: new ToolExecutor(registry), conversation, maxSteps: 4,
          onImageStripSelfHeal: () => { heals++ } })
        const run = agent.run("Inspect this image.", { images: [image] })
        if (outcome === "policy refusal") await expect(run).rejects.toThrow("safety policy")
        else if (outcome === "repeated rejection") await expect(run).rejects.toThrow("even after stripping")
        else expect((await run).text).toBe("ok")
        const recovers = outcome === "schema rejection" || outcome === "repeated rejection"
        expect(requests.map(imageCount)).toEqual(recovers ? [1, 0] : [1])
        expect(heals).toBe(recovers ? 1 : 0)
        expect(conversation.getMessages().flatMap(m => m.contentBlocks ?? [])
          .filter(b => b.type === "image")).toEqual([image])
      } finally { server.stop() }
    })
  }
})
