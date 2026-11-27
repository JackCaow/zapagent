import type {
  ReadTextFileRequest, ReadTextFileResponse, RequestPermissionRequest,
  RequestPermissionResponse, WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

/** One external agent zap can drive over ACP. Mirrors `acpAgents[]` in the
 * app config; the SDK never reads config files itself. */
export interface AcpAgentSpec {
  id: string;
  /** Executable (absolute or resolved on PATH) that speaks ACP on stdio. */
  command: string;
  args?: string[];
  /** Extra environment values. The agent otherwise inherits zap's
   * environment, like any host process zap starts; zap's provider keys live
   * in its config file, not the environment, and are never passed. */
  env?: Record<string, string>;
  /** Human label for tool descriptions and UI. */
  name?: string;
  description?: string;
  /** The agent edits files or runs commands by itself instead of through ACP
   * fs/terminal requests, so zap permissions and checkpoints do not cover
   * those effects. Git change summaries remain the fallback evidence. */
  selfGoverned?: boolean;
  /** Model id; set through the agent's `model` config option, or the
   * unstable `session/set_model` when the agent has no such option. */
  model?: string;
  /** Session mode to select after session/new (`session/set_mode`). */
  mode?: string;
  /** Reject the session if a requested mode, model or config option is refused. */
  requireSettings?: boolean;
  /** Session config options to apply after session/new
   * (`session/set_config_option`), e.g. `{ thought_level: "high" }`. */
  config?: Record<string, string>;
  /** Per-call timeout override in ms. */
  timeoutMs?: number;
}

/** Host decisions for requests the agent sends back to zap. Every handler is
 * optional; a missing handler means the capability is not advertised (fs) or
 * the request is refused (permission). */
export interface AcpClientHandlers {
  requestPermission?(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  readTextFile?(request: ReadTextFileRequest, signal: AbortSignal): Promise<ReadTextFileResponse>;
  writeTextFile?(request: WriteTextFileRequest, signal: AbortSignal): Promise<void>;
}

export class AcpClientError extends Error {
  constructor(message: string, readonly code:
    | "spawn_failed" | "exited" | "initialize_failed" | "session_failed"
    | "prompt_failed" | "timeout" | "cancelled" | "auth_required", readonly detail?: string) {
    super(detail ? `${message}\n${detail}` : message);
    this.name = "AcpClientError";
  }
}
