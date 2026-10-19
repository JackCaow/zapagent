// Public entry-point for the MCP subsystem.

export { MCPManager } from "./manager.js";
export { MCPError, type MCPErrorKind } from "./errors.js";
export { namespaceToolName, denamespaceToolName } from "./bridge/tools.js";
export type { MCPResource, MCPResourceTemplate, MCPResourceContent } from "./bridge/resources.js";
export type { MCPPrompt, MCPPromptArg } from "./bridge/prompts.js";
export type { CompletionRef, CompletionResult } from "./bridge/completion.js";
export {
  DEFAULTS,
  type MCPEvent,
  type MCPEventHandler,
  type MCPServerCapabilities,
  type MCPServerConfig,
  type MCPServerSnapshot,
  type MCPStatus,
  type MCPTransportKind,
} from "./types.js";
export { MCPTokenStore, type MCPOAuthEntry } from "./oauth/index.js";
