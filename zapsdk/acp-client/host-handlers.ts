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
  /** Cancels outstanding approval prompts when the call or turn ends. A
   * function is read per request (session mode: the current turn's signal). */
  signal?: AbortSignal | (() => AbortSignal | undefined);
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
  const signalFor = (request: AbortSignal) => {
    const outer = typeof policy.signal === "function" ? policy.signal() : policy.signal;
    return outer ? AbortSignal.any([request, outer]) : request;
  };

  const approve = async (name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ApprovalResponse> => {
    if (!policy.approve) return { approved: false, source: "policy", reason: "no approval handler" };
    const pre = policy.approve.precheck?.(name, args);
    if (pre !== undefined) return pre;
    return policy.approve(name, args, signal);
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
      // ACP: once the client cancels the turn, pending permission requests
      // must be answered "cancelled", not rejected.
      const live = signalFor(signal);
      if (live.aborted) return { outcome: { outcome: "cancelled" } };
      const response = await approve(name, args, live);
      if (live.aborted) return { outcome: { outcome: "cancelled" } };
      const allowed = response === true;
      decisions.push({ title, kind: tool.kind ?? undefined, allowed });
      const option = pickOption(request.options, allowed);
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    },

    async readTextFile(request, signal) {
      const path = resolvePath(request.path);
      const allowed = await approve("read_file", { path }, signalFor(signal));
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
      const allowed = await approve("write_file", { path, content: request.content }, signalFor(signal));
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

/** ACP permission requests carry a tool kind and free-form input. Where the
 * request names concrete effects, it maps onto zap's own tool so the same
 * policy applies: commands → `bash` (dangerous-command rules), a single-file
 * write with known content → `write_file` (edit preview, acceptEdits,
 * workspace scope), a single-file delete/read → `delete_file`/`read_file`.
 * Anything else is `acp_<agent>_<kind>`; only read/search/think kinds of
 * those count as read-only, so plan mode refuses the rest. */
export function permissionTarget(agentId: string, request: RequestPermissionRequest): { name: string; args: Record<string, unknown> } {
  const tool = request.toolCall;
  const input = tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput as Record<string, unknown> : {};
  // codex-acp: `command` (string or argv); agy: `CommandLine`.
  const raw = input.command ?? input.CommandLine;
  const command = typeof raw === "string" ? raw
    : Array.isArray(raw) && raw.every(part => typeof part === "string") ? (raw as string[]).join(" ")
    : undefined;
  if (tool.kind === "execute" && command) return { name: "bash", args: { command, description: tool.title ?? undefined } };

  const paths = [...new Set([
    ...(tool.locations ?? []).map(location => location.path),
    ...(tool.content ?? []).flatMap(item => item.type === "diff" ? [item.path] : []),
  ])].filter(path => isAbsolute(path));
  if (paths.length === 1) {
    const path = paths[0]!;
    if (tool.kind === "edit") {
      const diff = tool.content?.find(item => item.type === "diff" && item.path === path);
      // agy: { Content, Path }; others: content / new_content.
      const content = diff?.type === "diff" ? diff.newText : [input.Content, input.content, input.new_content].find(value => typeof value === "string");
      if (typeof content === "string") return { name: "write_file", args: { path, content } };
    }
    if (tool.kind === "delete") return { name: "delete_file", args: { path } };
    if (tool.kind === "read") return { name: "read_file", args: { path } };
  }
  return {
    name: `acp_${sanitize(agentId)}_${tool.kind ?? "other"}`,
    args: {
      title: tool.title ?? "tool call",
      ...(paths.length ? { paths } : {}),
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
