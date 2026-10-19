// Prompts bridge.
//
// MCP "prompts" are server-side message templates exposed to the user (not
// the LLM). They're meant to be surfaced through the host's command UI so a
// user can pick "/git.commit_message" and have it expand into a prefilled
// turn. We expose:
//   - list of prompts per server (drives slash palette)
//   - render(server, name, args) → array of Messages ready to splice into
//     the conversation.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Message, ContentBlock } from "../../core/types.js";
import { MCPError, withTimeout } from "../errors.js";
import { DEFAULTS, type MCPServerConfig } from "../types.js";

export interface MCPPromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPrompt {
  server: string;
  name: string;
  title?: string;
  description?: string;
  arguments: MCPPromptArg[];
}

const MAX_PAGES = 32;

export async function fetchPrompts(
  client: Client,
  config: MCPServerConfig,
): Promise<MCPPrompt[]> {
  const out: MCPPrompt[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    let res: Awaited<ReturnType<Client["listPrompts"]>>;
    try {
      res = await client.listPrompts(cursor ? { cursor } : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("-32601") || msg.toLowerCase().includes("not found")) return out;
      throw err;
    }
    for (const p of res.prompts ?? []) {
      out.push({
        server: config.name,
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.arguments ?? [],
      });
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export async function renderPrompt(
  client: Client,
  config: MCPServerConfig,
  name: string,
  args?: Record<string, string>,
): Promise<Message[]> {
  const timeout = config.callTimeoutMs ?? DEFAULTS.callTimeoutMs;
  try {
    const res = await withTimeout(
      client.getPrompt({ name, arguments: args }),
      timeout,
      `mcp:${config.name}:getPrompt`,
    );
    return (res.messages ?? []).map((m) => promptMessageToMessage(m, config));
  } catch (err) {
    throw MCPError.wrap(err, config.name);
  }
}

type ServerMessage = Awaited<ReturnType<Client["getPrompt"]>>["messages"][number];

function promptMessageToMessage(m: ServerMessage, config: MCPServerConfig): Message {
  const role: Message["role"] = m.role === "assistant" ? "assistant" : "user";

  // MCP role-only knows user/assistant. The content union is identical to
  // tool result content (text/image/audio/resource/resource_link). We
  // flatten to plain text + ContentBlock[] using the same convention as
  // bridge/tools.ts.
  const parts: string[] = [];
  const contentBlocks: ContentBlock[] = [];

  const content = m.content as { type: string } & Record<string, unknown>;
  // Some SDK versions wrap content as a single object, some as an array;
  // normalise.
  const items = Array.isArray(content) ? content : [content];

  for (const c of items as Array<{ type: string } & Record<string, unknown>>) {
    switch (c.type) {
      case "text":
        if (typeof c.text === "string") parts.push(c.text);
        break;
      case "image":
        // Prompt-attached images: include a placeholder; full multimodal
        // injection lives in the user-input pipeline, not here.
        parts.push(`[image: ${(c.mimeType as string | undefined) ?? "unknown"}]`);
        break;
      case "audio":
        parts.push(`[audio: ${(c.mimeType as string | undefined) ?? "unknown"}]`);
        break;
      case "resource": {
        const r = c.resource as { uri: string; text?: string; mimeType?: string } | undefined;
        if (r?.text) parts.push(`[resource ${r.uri}]\n${r.text}`);
        else if (r) parts.push(`[resource ${r.uri}: binary]`);
        break;
      }
      case "resource_link":
        parts.push(`[resource_link ${c.uri as string}]`);
        break;
      default:
        parts.push(JSON.stringify(c));
    }
  }

  return {
    role,
    content: parts.join("\n"),
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
    // Tag the message so future audit / debugging can see which prompt
    // produced it.
    raw: { source: `mcp:${config.name}:prompt` },
  };
}
