import { describe, expect, it } from "bun:test"
import { OpenAICompatibleProvider } from "../../core/providers/openai-compatible.js"
import { AnthropicProvider } from "../../core/providers/anthropic.js"

describe("provider stopSequences option", () => {
  it("passes stop sequences to OpenAI-compatible chat completions", async () => {
    let captured: any
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            captured = params
            return {
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
          },
        },
      },
    } as any
    const provider = new OpenAICompatibleProvider({ model: "gpt-test", client: fakeClient })

    await provider.call([{ role: "user", content: "hello" }], undefined, {
      stopSequences: ["</done>", "STOP"],
    })

    expect(captured.stop).toEqual(["</done>", "STOP"])
  })

  it("passes stop sequences to Anthropic messages", async () => {
    let captured: any
    const fakeClient = {
      messages: {
        create: async (params: any) => {
          captured = params
          return {
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        },
      },
    } as any
    const provider = new AnthropicProvider({
      model: "claude-test",
      client: fakeClient,
      promptCaching: false,
    })

    await provider.call([{ role: "user", content: "hello" }], undefined, {
      stopSequences: ["</done>", "STOP"],
    })

    expect(captured.stop_sequences).toEqual(["</done>", "STOP"])
  })
})
