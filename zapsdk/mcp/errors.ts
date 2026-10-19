// Classified MCP errors. Lets callers (UI / status reducer / reconnect loop)
// distinguish "server is down" from "this one call failed" without parsing
// strings.

export type MCPErrorKind =
  | "transport"        // socket / pipe / process died, host unreachable
  | "timeout"          // we gave up waiting
  | "protocol"         // JSON-RPC error (server returned error envelope)
  | "auth"             // 401 / token rejected
  | "cancelled"        // user / signal aborted
  | "config"           // bad MCPServerConfig (missing fields, bad URL, …)
  | "unknown";

export class MCPError extends Error {
  readonly kind: MCPErrorKind;
  readonly server?: string;
  readonly cause?: unknown;

  constructor(kind: MCPErrorKind, message: string, opts?: { server?: string; cause?: unknown }) {
    super(message);
    this.name = "MCPError";
    this.kind = kind;
    this.server = opts?.server;
    this.cause = opts?.cause;
  }

  static wrap(err: unknown, server?: string): MCPError {
    if (err instanceof MCPError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = classify(message);
    return new MCPError(kind, message, { server, cause: err });
  }
}

function classify(message: string): MCPErrorKind {
  const m = message.toLowerCase();
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (m.includes("401") || m.includes("unauthor")) return "auth";
  if (m.includes("aborted") || m.includes("cancelled")) return "cancelled";
  if (m.includes("econnref") || m.includes("epipe") || m.includes("enotfound") || m.includes("transport"))
    return "transport";
  return "unknown";
}

/** Race a promise against a timeout; throws MCPError("timeout") on expiry. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new MCPError("timeout", `${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}
