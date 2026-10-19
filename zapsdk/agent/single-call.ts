import type { LLMProvider } from "../core/llm.js";
import type { Message, TokenUsage } from "../core/types.js";
import {
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "../core/types.js";
import type { ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutor } from "../tools/executor.js";
import { accumulateTokenUsage } from "./token-usage.js";
import { formatToolResultForModel, operationFailure } from "../execution/failure.js";

export interface SingleCallAgentOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  systemPrompt?: string;
  sessionId?: string;
}

export interface AgentResult {
  text: string;
  toolResults: ToolResult[];
  totalUsage: TokenUsage;
}

export class SingleCallAgent {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private systemPrompt?: string;
  private sessionId?: string;

  constructor(options: SingleCallAgentOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.executor = options.executor;
    this.systemPrompt = options.systemPrompt;
    this.sessionId = options.sessionId;
  }

  async run(input: string): Promise<AgentResult> {
    const messages: Message[] = [];
    const toolResults: ToolResult[] = [];
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    if (this.systemPrompt) {
      messages.push(createSystemMessage(this.systemPrompt));
    }
    messages.push(createUserMessage(input));

    // First LLM call
    const tools = this.registry.definitions();
    const response = await this.provider.call(messages, tools);
    accumulateTokenUsage(totalUsage, response.usage);

    // If no tool calls, return directly
    if (response.type === "text" || !response.toolCalls?.length) {
      return { text: response.text, toolResults, totalUsage };
    }

    // Execute tools — include toolCalls so the provider can reconstruct tool_use blocks
    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });

    for (const toolCall of response.toolCalls) {
      const result = toolCall.argumentParseError
        ? { success: false, output: "", error: toolCall.argumentParseError,
            failure: operationFailure("INVALID_ARGUMENTS", "executor") }
        : await this.executor.execute(toolCall.name, toolCall.arguments, undefined, {
            sessionId: this.sessionId,
            toolCallId: toolCall.id,
            step: 1,
          });
      toolResults.push(result);
      messages.push(
        createToolResultMessage(
          toolCall.id,
          formatToolResultForModel(result)
        )
      );
    }

    // Second LLM call with tool results
    const finalResponse = await this.provider.call(messages, tools);
    accumulateTokenUsage(totalUsage, finalResponse.usage);

    return { text: finalResponse.text, toolResults, totalUsage };
  }
}
