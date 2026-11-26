import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { RequestError, type PermissionOption, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ApprovalCallback, ApprovalResponse } from "../tools/executor.js";
import { resolveToolPathCanonical } from "../builtin-tools/filesystem.js";
import type { AcpClientHandlers } from "./types.js";

export interface AcpHostPolicy {
  agentId: string;
  cwd: string;
  /** Zap's approval gate. Absent → only reads inside cwd are served and every
   * permission request is rejected. */
  approve?: ApprovalCallback;
  /** Checkpoint hook; called with the canonical path before every write. */
  trackEdit?: (paths: string[]) => Promise<unknown>;
  /** Cancels outstanding approval prompts when the tool call ends. */
  signal?: AbortSignal;
}

export interface AcpHostHandlers extends AcpClientHandlers {
  /** Canonical paths written through fs/write_text_file. */
  readonly written: Set<string>;
  /** Permission requests answered, for the tool report. */
  readonly decisions: Array<{ title: string; kind?: string; allowed: boolean }>;
}

const READ_MAX_BYTES = 10 * 1024 * 1024;

/** Requests from an external agent are untrusted. File access is mapped to
 * zap's own `read_file` / `write_file` approvals so mode, rules and edit
 * previews apply exactly as for zap's tools. */
export function createAcpHostHandlers(policy: AcpHostPolicy): AcpHostHandlers {
  const written = new Set<string>();
  const decisions: AcpHostHandlers["decisions"] = [];
  const signalFor = (request: AbortSignal) => policy.signal ? AbortSignal.any([request, policy.signal]) : request;

  const approve = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ApprovalResponse> => {
    if (!policy.approve) return { approved: false, source: "policy", reason: "no approval handler" };
    const pre = policy.approve.precheck?.(name, args);
    if (pre !== undefined) return pre;
    return policy.approve(name, args, signalFor(signal));
  };

  const resolvePath = (path: string): string => {
    if (!isAbsolute(path)) throw RequestError.invalidParams(undefined, "ACP file paths must be absolute");
    return resolveToolPathCanonical(path, policy.cwd);
  };

  return {
    written,
    decisions,

    async requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
      const tool = request.toolCall;
      const title = tool.title ?? "tool call";
      const { name, args } = permissionTarget(policy.agentId, request);
      const response = await approve(name, args, signal);
      const allowed = response === true;
      decisions.push({ title, kind: tool.kind ?? undefined, allowed });
      const option = pickOption(request.options, allowed);
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    },

    async readTextFile(request, signal) {
      const path = resolvePath(request.path);
      const allowed = await approve("read_file", { path }, signal);
      if (allowed !== true) throw RequestError.internalError(undefined, denialText(allowed));
      const buffer = await readFile(path);
      if (buffer.byteLength > READ_MAX_BYTES) throw RequestError.invalidParams(undefined, `file exceeds ${READ_MAX_BYTES} bytes`);
      let content = buffer.toString("utf8");
      if (request.line != null || request.limit != null) {
        const lines = content.split("\n");
        const start = Math.max(0, (request.line ?? 1) - 1);
        content = lines.slice(start, request.limit != null ? start + request.limit : undefined).join("\n");
      }
      return { content };
    },

    async writeTextFile(request, signal) {
      const path = resolvePath(request.path);
      const allowed = await approve("write_file", { path, content: request.content }, signal);
      if (allowed !== true) throw RequestError.internalError(undefined, denialText(allowed));
      if (policy.trackEdit) {
        try { await policy.trackEdit([path]); } catch { /* checkpoint coverage is best-effort, as for write_file */ }
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, request.content, "utf8");
      written.add(path);
    },
  };
}

/** ACP permission requests carry a tool kind and free-form input. Commands
 * map to zap's `bash` so dangerous-command rules apply; everything else is a
 * namespaced call the user approves on its title. */
function permissionTarget(agentId: string, request: RequestPermissionRequest): { name: string; args: Record<string, unknown> } {
  const tool = request.toolCall;
  const input = tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput as Record<string, unknown> : {};
  // codex-acp: `command` (string or argv); agy: `CommandLine`.
  const raw = input.command ?? input.CommandLine;
  const command = typeof raw === "string" ? raw
    : Array.isArray(raw) && raw.every(part => typeof part === "string") ? (raw as string[]).join(" ")
    : undefined;
  if (tool.kind === "execute" && command) return { name: "bash", args: { command, description: tool.title ?? undefined } };
  return {
    name: `acp_${sanitize(agentId)}_${tool.kind ?? "other"}`,
    args: {
      title: tool.title ?? "tool call",
      ...(tool.locations?.length ? { paths: tool.locations.map(location => location.path) } : {}),
      ...(tool.rawInput !== undefined ? { input: tool.rawInput } : {}),
    },
  };
}

function pickOption(options: PermissionOption[], allowed: boolean): PermissionOption | undefined {
  // Never persist a grant inside the external agent: zap owns "always".
  const order = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const match = options.find(option => option.kind === kind);
    if (match) return match;
  }
  return undefined;
}

function denialText(response: ApprovalResponse): string {
  return typeof response === "object" ? `denied by zap: ${response.reason}` : "denied by zap";
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
