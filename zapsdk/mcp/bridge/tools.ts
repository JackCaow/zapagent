// Bridges MCP tools into the framework's Tool/ToolRegistry model.
//
// Naming: every MCP tool is exposed as `mcp__<server>__<original>` so that
//   1. tools from different servers can't collide,
//   2. the user can write permission rules with a stable prefix
//      (`/permissions allow mcp__github__*` style),
//   3. it matches Claude Code's convention so users moving over keep their
//      muscle memory.

import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import type { ImageContent } from "../../core/types.js";
import { MCPError, withTimeout } from "../errors.js";
import { normalizeInputSchema, passthroughObjectSchema } from "../schema.js";
import type { MCPServerConfig } from "../types.js";
import { DEFAULTS } from "../types.js";
import { getAppDataDir } from "../../utils/platform.js";
import { writeFileAtomic } from "../../utils/atomic-write.js";
import { resolveProjectDataSegment } from "../../utils/project-paths.js";

export const MCP_TOOL_NAME_MAX_LENGTH = 64;
export const MCP_SERVER_NAME_MAX_LENGTH = MCP_TOOL_NAME_MAX_LENGTH - "mcp__".length - "__".length - 1;
const NAMESPACE_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

/** MCP tool name → framework tool name. Pure; exported for the /mcp UI. */
export function namespaceToolName(serverName: string, toolName: string): string {
  validateNamespacePart("server", serverName);
  validateNamespacePart("tool", toolName);
  const namespaced = `mcp__${serverName}__${toolName}`;
  if (namespaced.length > MCP_TOOL_NAME_MAX_LENGTH) {
    throw new Error(
      `Invalid MCP tool namespace "${namespaced}": namespaced tool names must be ${MCP_TOOL_NAME_MAX_LENGTH} characters or fewer`,
    );
  }
  return namespaced;
}

/** Inverse of namespaceToolName — used by autoApproveTools lookup. */
export function denamespaceToolName(framework: string): { server: string; tool: string } | null {
  if (framework.length > MCP_TOOL_NAME_MAX_LENGTH) return null;
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(framework);
  if (!m) return null;
  const server = m[1]!;
  const tool = m[2]!;
  if (!isValidMCPNamespacePart(server) || !isValidMCPNamespacePart(tool)) return null;
  return { server, tool };
}

function validateNamespacePart(kind: "server" | "tool", value: string): void {
  if (isValidMCPNamespacePart(value)) return;
  throw new Error(
    `Invalid MCP ${kind} name "${value}": names must be non-empty and can only contain letters, numbers, underscores, or hyphens; "__" is reserved`,
  );
}

export function isValidMCPNamespacePart(value: string): boolean {
  return value.length > 0 && !value.includes("__") && NAMESPACE_PART_PATTERN.test(value);
}

export interface MCPListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

export interface BridgeMCPToolOptions {
  /** Project cwd used when persisting inline MCP images. Defaults to
   *  `process.cwd()` for backwards compatibility. */
  projectCwd?: string;
}

export function bridgeMCPTool(
  client: Client,
  config: MCPServerConfig,
  mcpTool: MCPListedTool,
  options: BridgeMCPToolOptions = {},
): Tool {
  const name = namespaceToolName(config.name, mcpTool.name);
  const rawSchema = normalizeInputSchema(mcpTool.inputSchema);
  const callTimeoutMs = config.callTimeoutMs ?? DEFAULTS.callTimeoutMs;
  const autoApprove = config.autoApproveTools?.includes(mcpTool.name) ?? false;
  const readOnly = mcpTool.annotations?.readOnlyHint === true &&
    mcpTool.annotations?.destructiveHint !== true;

  return {
    definition: {
      name,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      parameters: passthroughObjectSchema(),
      rawSchema,
      // MCP tools come from third-party servers — default to confirm. The
      // user can either flip the per-server `autoApproveTools` whitelist
      // here, or use `/permissions allow <fully_qualified_name>` (handled
      // by the existing permissions subsystem).
      permission: autoApprove ? "auto" : "confirm",
      // Honour the MCP `readOnlyHint` annotation so the executor parallels
      // safe ops (Grep-like MCP tools) instead of serialising them.
      readOnly,
      resolveEffects: () => {
        if (mcpTool.annotations?.destructiveHint === true) {
          return {
            filesystem: [],
            network: [],
            process: [],
            external: [{
              kind: "external" as const,
              system: `mcp:${config.name}`,
              operation: "destructive" as const,
              resource: mcpTool.name,
            }],
            workspace: { mode: "none" as const },
            confidence: "inferred" as const,
          };
        }
        if (readOnly) {
          return {
            filesystem: [],
            network: mcpTool.annotations?.openWorldHint === true
              ? [{
                  kind: "network" as const,
                  operation: "connect" as const,
                  destinations: ["*"],
                }]
              : [],
            process: [],
            external: [{
              kind: "external" as const,
              system: `mcp:${config.name}`,
              operation: "read" as const,
              resource: mcpTool.name,
            }],
            workspace: { mode: "none" as const },
            confidence: "inferred" as const,
          };
        }
        return {
          filesystem: [],
          network: [],
          process: [],
          external: [],
          workspace: { mode: "root-integration" as const },
          confidence: "unknown" as const,
        };
      },
      timeoutMs: callTimeoutMs,
    },
    handler: async (args, signal): Promise<ToolResult> => {
      if (signal?.aborted) {
        return { success: false, output: "", error: "aborted" };
      }
      try {
        // Wire AbortSignal into the SDK's request options so user cancel
        // (Esc) propagates as JSON-RPC notifications/cancelled.
        const result = await withTimeout(
          client.callTool(
            { name: mcpTool.name, arguments: args },
            undefined,
            { signal },
          ),
          callTimeoutMs,
          `mcp:${config.name}:${mcpTool.name}`,
        );
        return await shapeToolResult(result, { projectCwd: options.projectCwd });
      } catch (err) {
        const wrapped = MCPError.wrap(err, config.name);
        return { success: false, output: "", error: wrapped.message };
      }
    },
  };
}

// ── result → ToolResult ──────────────────────────────────────────────────

interface MCPCallResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; text?: string; blob?: string; mimeType?: string };
  uri?: string;
  name?: string;
  description?: string;
}

interface MCPCallResult {
  content?: MCPCallResultContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  toolResult?: unknown;
}

async function shapeToolResult(
  raw: unknown,
  options: BridgeMCPToolOptions = {},
): Promise<ToolResult> {
  const result = raw as MCPCallResult;

  // Old "compatibility" envelope: { toolResult: ... }
  if (result.toolResult !== undefined && !Array.isArray(result.content)) {
    return {
      success: true,
      output: typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult),
    };
  }

  const content = Array.isArray(result.content) ? result.content : [];
  const textParts: string[] = [];
  const contentBlocks: ImageContent[] = [];

  for (const c of content) {
    switch (c.type) {
      case "text":
        if (typeof c.text === "string") textParts.push(c.text);
        break;
      case "image":
        if (c.data && c.mimeType) {
          const filePath = await persistInlineImage(c.data, c.mimeType, options.projectCwd);
          if (filePath) {
            contentBlocks.push({
              type: "image",
              filePath,
              mediaType: c.mimeType,
              base64: c.data,
              source: "mcp",
            });
            textParts.push(`[image: ${c.mimeType}]`);
          } else {
            textParts.push(`[image: ${c.mimeType} — failed to persist]`);
          }
        }
        break;
      case "audio":
        textParts.push(`[audio: ${c.mimeType ?? "unknown"}]`);
        break;
      case "resource":
        if (c.resource?.text) {
          textParts.push(`[resource ${c.resource.uri}]\n${c.resource.text}`);
        } else if (c.resource?.blob) {
          textParts.push(`[resource ${c.resource.uri}: binary ${c.resource.mimeType ?? ""}]`);
        }
        break;
      case "resource_link":
        textParts.push(`[resource_link ${c.uri}${c.name ? ` "${c.name}"` : ""}${c.description ? `: ${c.description}` : ""}]`);
        break;
      default:
        textParts.push(JSON.stringify(c));
    }
  }

  // Surface structured content if present — many newer MCP servers return
  // JSON via `structuredContent` and leave `content` empty.
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0 && textParts.length === 0) {
    textParts.push(JSON.stringify(result.structuredContent));
  }

  const output = textParts.join("\n");
  return {
    success: !result.isError,
    output,
    error: result.isError ? (output || "tool reported error") : undefined,
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
  };
}

// ── inline image persistence ─────────────────────────────────────────────
//
// The framework's ImageContent block requires `filePath`; the rest of the
// pipeline (Anthropic provider, OpenAI vision serializer, transcript image
// preview) reads from disk. MCP servers, however, return inline base64.
// Persist to ~/.zapcode/projects/<project-id>/mcp-images/ (best-effort tmpdir
// fallback) and hand the path back. We keep `base64` populated too so
// providers that already have the bytes don't re-read.

async function persistInlineImage(
  base64: string,
  mimeType: string,
  projectCwd = process.cwd(),
): Promise<string | null> {
  const ext = extFromMime(mimeType);
  const projectId = resolveProjectDataSegment(projectCwd);
  const dir = join(getAppDataDir(), "projects", projectId, "mcp-images");
  const fallbackDir = join(tmpdir(), "zapcode-mcp-images");
  const filename = `${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  const targets = [join(dir, filename), join(fallbackDir, filename)];

  for (const target of targets) {
    try {
      await mkdir(dirname(target), { recursive: true });
      await chmodBestEffort(dirname(target), 0o700);
      const buf = Buffer.from(base64, "base64");
      await writeFileAtomic(target, buf, { mode: 0o600 });
      return target;
    } catch {
      // try next target
    }
  }
  return null;
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try { await chmod(path, mode); } catch {}
}

function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("svg")) return "svg";
  return "bin";
}
