import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { RequestError, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ApprovalCallback, ApprovalContext, ApprovalResponse } from "../tools/executor.js";
import { resolveToolPathCanonical } from "../builtin-tools/filesystem.js";
import { shellExecutionCommands } from "../utils/shell.js";
import type { AcpClientHandlers } from "./types.js";

export interface AcpHostPolicy {
  agentId: string;
  cwd: string;
  /** Zap's approval gate. Absent → every request is refused. */
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

/** The workspace an agent's requests are judged against: inside the cwd,
 * minus zap's protected control directories (as for zap's own file tools). */
export class AcpWorkspace {
  readonly root: string;
  private readonly protectedRoots: string[];

  constructor(cwd: string) {
    this.root = resolveToolPathCanonical(cwd, cwd);
    this.protectedRoots = [join(this.root, ".git"), join(this.root, ".zapcode")];
  }

  /** Canonical absolute path; ACP requires absolute paths. */
  resolve(path: string): string {
    if (!isAbsolute(path)) throw RequestError.invalidParams(undefined, "ACP file paths must be absolute");
    return resolveToolPathCanonical(path, this.root);
  }

  contains(path: string): boolean { return within(path, this.root); }
  isProtected(path: string): boolean {
    // Reserve control-directory spellings even when a new path has no
    // on-disk casing for realpath to recover on macOS or Windows.
    const fold = process.platform === "win32" || process.platform === "darwin";
    return this.protectedRoots.some(root => fold ? within(path.toLowerCase(), root.toLowerCase()) : within(path, root));
  }

  protectsWrite(path: string): boolean {
    const absolute = resolve(this.root, path);
    return this.isProtected(absolute) || this.isProtected(this.resolve(absolute));
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Requests from an external agent are untrusted. In-workspace file access
 * is approved as zap's own `read_file` / `write_file`, so mode, rules and edit
 * previews apply as for zap's tools. Zap's executor normally confines those
 * tools to the workspace; these handlers bypass the executor, so they
 * enforce that boundary themselves: outside the workspace every access is a
 * one-time prompt, and `.git` / `.zapcode` are never written. */
export function createAcpHostHandlers(policy: AcpHostPolicy): AcpHostHandlers {
  const written = new Set<string>();
  const decisions: AcpHostHandlers["decisions"] = [];
  const workspace = new AcpWorkspace(policy.cwd);
  const agent = sanitize(policy.agentId);
  const signalFor = (request: AbortSignal) => {
    const outer = typeof policy.signal === "function" ? policy.signal() : policy.signal;
    return outer ? AbortSignal.any([request, outer]) : request;
  };

  const approve = async (target: ApprovalTarget, signal: AbortSignal): Promise<ApprovalResponse> => {
    if (signal.aborted) return false;
    if (!policy.approve) return { approved: false, source: "policy", reason: "no approval handler" };
    const pre = policy.approve.precheck?.(target.name, target.args, target.context);
    if (pre !== undefined) return pre;
    return policy.approve(target.name, target.args, signal, target.context);
  };

  return {
    written,
    decisions,

    async requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
      const tool = request.toolCall;
      const title = tool.title ?? "tool call";
      // ACP: once the client cancels the turn, pending permission requests
      // must be answered "cancelled", not rejected.
      const live = signalFor(signal);
      if (live.aborted) return { outcome: { outcome: "cancelled" } };
      const diffs = tool.content?.flatMap(item => item.type === "diff" ? [item.path] : []) ?? [];
      const mutation = tool.kind === "edit" || tool.kind === "delete" || tool.kind === "move";
      const paths = mutation ? [...diffs, ...(tool.locations ?? []).map(location => location.path)] : diffs;
      const allowOnce = request.options.find(option => option.kind === "allow_once");
      const response = allowOnce && !paths.some(path => workspace.protectsWrite(path))
        ? await approve(permissionTarget(policy.agentId, request, workspace), live) : false;
      if (live.aborted) return { outcome: { outcome: "cancelled" } };
      // Native agents must never save an approval or refusal on Zap's behalf.
      const option = response === true ? allowOnce : request.options.find(option => option.kind === "reject_once");
      decisions.push({ title, kind: tool.kind ?? undefined, allowed: option?.kind === "allow_once" });
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    },

    async readTextFile(request, signal) {
      const path = workspace.resolve(request.path);
      const target: ApprovalTarget = workspace.contains(path)
        ? { name: "read_file", args: { path } }
        : { name: `acp_${agent}_read`, args: { title: "Read a file outside the workspace", paths: [path] } };
      const live = signalFor(signal);
      const allowed = await approve(target, live);
      live.throwIfAborted();
      if (allowed !== true) throw RequestError.internalError(undefined, denialText(allowed));
      const info = await stat(path);
      if (!info.isFile()) throw RequestError.invalidParams(undefined, "not a regular file");
      if (info.size > READ_MAX_BYTES) throw RequestError.invalidParams(undefined, `file exceeds ${READ_MAX_BYTES} bytes`);
      let content = (await readFile(path)).toString("utf8");
      live.throwIfAborted();
      if (request.line != null || request.limit != null) {
        const lines = content.split("\n");
        const start = Math.max(0, Math.floor(request.line ?? 1) - 1);
        const limit = request.limit != null ? Math.max(0, Math.floor(request.limit)) : undefined;
        content = lines.slice(start, limit !== undefined ? start + limit : undefined).join("\n");
      }
      return { content };
    },

    async writeTextFile(request, signal) {
      const path = workspace.resolve(request.path);
      if (workspace.isProtected(request.path) || workspace.isProtected(path)) {
        throw RequestError.internalError(undefined, "denied by zap: .git and .zapcode are protected and cannot be written");
      }
      const target: ApprovalTarget = workspace.contains(path)
        ? { name: "write_file", args: { path, content: request.content } }
        : { name: `acp_${agent}_edit`, args: { title: "Write a file outside the workspace", paths: [path] } };
      const live = signalFor(signal);
      const allowed = await approve(target, live);
      live.throwIfAborted();
      if (allowed !== true) throw RequestError.internalError(undefined, denialText(allowed));
      if (policy.trackEdit) {
        try { await policy.trackEdit([path]); } catch { /* checkpoint coverage is best-effort, as for write_file */ }
      }
      live.throwIfAborted();
      await mkdir(dirname(path), { recursive: true });
      live.throwIfAborted();
      await writeFile(path, request.content, "utf8");
      written.add(path);
    },
  };
}

export interface ApprovalTarget {
  name: string;
  args: Record<string, unknown>;
  context?: ApprovalContext;
}

/** ACP permission requests carry a tool kind and free-form input. Where the
 * request names concrete in-workspace effects, it maps onto zap's own tool so
 * the same policy applies:
 * - commands → `bash` with facts that mark them as running outside zap's
 *   sandbox (the agent executes them), so dangerous-command and command rules
 *   apply but the sandboxed-command auto-allow does not;
 * - a single in-workspace, unprotected file write with known content →
 *   `write_file` (edit preview, acceptEdits, workspace scope);
 * - a single in-workspace delete/read → `delete_file` / `read_file`.
 * Anything else is `acp_<agent>_<kind>`: approved once at a time, read-only
 * only for read/search/think, so plan mode refuses the rest. */
export function permissionTarget(agentId: string, request: RequestPermissionRequest, workspace: AcpWorkspace): ApprovalTarget {
  const tool = request.toolCall;
  const input = tool.rawInput && typeof tool.rawInput === "object" ? tool.rawInput as Record<string, unknown> : {};
  // codex-acp: `command` (string or argv); agy: `CommandLine`.
  const raw = input.command ?? input.CommandLine;
  const command = typeof raw === "string" ? raw
    : Array.isArray(raw) && raw.length && raw.every(part => typeof part === "string") ? (raw as string[]).map(quoteArg).join(" ")
    : undefined;
  if (tool.kind === "execute" && command) {
    const args = { command, description: tool.title ?? undefined };
    return { name: "bash", args, context: {
      cwd: workspace.root, workspaceRoot: workspace.root,
      shell: { syntax: process.platform === "win32" ? "unknown" : "posix", filesystem: "host" },
      authorization: {
        readOnly: false, editOnly: false,
        // Not zap's sandbox and not zap's sandbox-escape grant: the agent
        // runs it. workspaceShell=false keeps command rules from treating it
        // as a sandboxed workspace command.
        sandboxEscape: false, workspaceShell: false,
        shellCommands: shellExecutionCommands(args),
      },
    } };
  }

  const paths = [...new Set([
    ...(tool.locations ?? []).map(location => location.path),
    ...(tool.content ?? []).flatMap(item => item.type === "diff" ? [item.path] : []),
  ])].filter(path => isAbsolute(path)).map(path => workspace.resolve(path));
  const only = paths.length === 1 ? paths[0]! : undefined;
  if (only && workspace.contains(only)) {
    const writable = !workspace.isProtected(only);
    if (tool.kind === "edit" && writable) {
      const diff = tool.content?.find(item => item.type === "diff" && workspace.resolve(item.path) === only);
      // agy: { Content, Path }; others: content / new_content.
      const content = diff?.type === "diff" ? diff.newText : [input.Content, input.content, input.new_content].find(value => typeof value === "string");
      if (typeof content === "string") return { name: "write_file", args: { path: only, content } };
    }
    if (tool.kind === "delete" && writable) return { name: "delete_file", args: { path: only } };
    if (tool.kind === "read") return { name: "read_file", args: { path: only } };
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

/** POSIX-quote one argv element unless it is plainly safe. */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function denialText(response: ApprovalResponse): string {
  return typeof response === "object" ? `denied by zap: ${response.reason}` : "denied by zap";
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
