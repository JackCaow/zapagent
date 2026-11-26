import { z } from "zod";
import { relative } from "node:path";
import type { Tool, ToolResult } from "../tools/types.js";
import type { AgentEventHandler } from "../agent/events.js";
import type { ApprovalCallback } from "../tools/executor.js";
import { createLocalProcessBroker } from "../execution/process.js";
import { integrationGitWriteRoots } from "../execution/workspace-runtime.js";
import { currentRuntimeObservation, observeRuntime } from "../runtime/observation.js";
import { resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";
import { diffSnapshots, formatChangeSummary, gitStatusSnapshot } from "./delegate-changes.js";
import { stdioTransport, type AcpTransport } from "../acp-client/connection.js";
import { createAcpHostHandlers } from "../acp-client/host-handlers.js";
import { runAcpTask, type AcpTaskResult } from "../acp-client/run.js";
import { AcpClientError, type AcpAgentSpec } from "../acp-client/types.js";

export interface AcpAgentToolOptions {
  agents: AcpAgentSpec[];
  onEvent?: AgentEventHandler;
  defaultCwd?: string;
  /** Zap's approval gate for the agent's permission and fs requests. */
  approve?: ApprovalCallback;
  /** Checkpoint hook for writes the agent makes through fs/write_text_file. */
  trackEdit?: (paths: string[]) => Promise<unknown>;
  /** Default 1_200_000 (20 min). */
  timeoutMs?: number;
  clientVersion?: string;
  /** Tests inject an in-process agent instead of spawning. */
  transportFactory?: (spec: AcpAgentSpec, cwd: string) => AcpTransport;
}

const TASK_MAX_CHARS = 100_000;

export const ACP_AGENT_TOOL = "acp_agent";

export function acpAgentTool(opts: AcpAgentToolOptions): Tool | null {
  if (!opts.agents.length) return null;
  const ids = opts.agents.map(agent => agent.id) as [string, ...string[]];
  const byId = new Map(opts.agents.map(agent => [agent.id, agent]));
  const defaultTimeout = opts.timeoutMs ?? 1_200_000;
  const maxTimeout = Math.max(defaultTimeout, ...opts.agents.map(agent => agent.timeoutMs ?? 0));

  return {
    definition: {
      name: ACP_AGENT_TOOL,
      checkpointTracking: "unsupported",
      description: [
        "Hand a task to an external coding agent over the Agent Client Protocol and return its report.",
        `Available: ${opts.agents.map(agent => `\`${agent.id}\`${agent.description ? ` (${agent.description})` : ""}`).join(", ")}.`,
        "Use for self-contained work that benefits from a different agent; work directly for small edits.",
        "The agent's file reads, writes and permission requests go through zap's approvals.",
        "Returns the agent's final message, files changed, and a session id for follow-ups.",
      ].join(" "),
      parameters: z.object({
        agent: z.enum(ids),
        task: z.string().describe("Goal, relevant context, and expected deliverable. For a follow-up in an existing session, only the new instruction."),
        cwd: z.string().optional().describe("Working directory. Defaults to zap's cwd."),
        session_id: z.string().optional().describe("Session id from a prior acp_agent result with the same agent, to continue that conversation."),
        mode: z.string().optional().describe("Agent session mode id, when the agent offers modes."),
      }),
      permission: "confirm",
      timeoutMs: maxTimeout + 30_000,
      sandboxAware: true,
      executionLocation: "host",
      resolveEffects: (args, context) => {
        const base = opts.defaultCwd ?? context.cwd;
        const cwd = resolveToolPathCanonical((args.cwd as string | undefined) ?? base, base);
        return {
          filesystem: [
            { kind: "filesystem", operation: "read", paths: [cwd] },
            { kind: "filesystem", operation: "modify", paths: [cwd] },
            ...integrationGitWriteRoots(cwd).map(path => ({ kind: "filesystem" as const, operation: "modify" as const, paths: [path] })),
          ],
          network: [{ kind: "network", operation: "connect", destinations: ["*"], methods: [] }],
          // External agents keep their own state, credentials and endpoints;
          // they run on the host like an approved unsandboxed command. Their
          // fs and permission requests still pass through zap.
          process: [{ kind: "process", operation: "spawn", commandClass: "acp-agent", background: false, unsandboxed: true }],
          external: [],
          workspace: { mode: "root-integration" },
          confidence: "declared",
        };
      },
    },

    handler: async (args, signal, context): Promise<ToolResult> => {
      const spec = byId.get(String(args.agent));
      if (!spec) return { success: false, output: "", error: `ACP agent ${String(args.agent)} is not configured.` };
      const task = String(args.task ?? "");
      if (!task.trim()) return { success: false, output: "", error: "task is empty" };
      if (task.length > TASK_MAX_CHARS) {
        return { success: false, output: "", error: `Task is too long (${task.length} chars > ${TASK_MAX_CHARS}). Put details in files under cwd and reference them.` };
      }
      const base = opts.defaultCwd ?? process.cwd();
      const cwd = resolveToolPathCanonical(resolveToolPath((args.cwd as string | undefined) ?? base, base), base);
      const timeoutMs = spec.timeoutMs ?? defaultTimeout;

      const subagentId = `acp_${spec.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const observation = currentRuntimeObservation();
      const observe = (phase: "starting" | "running" | "failed" | "cancelled" | "exited") => {
        if (observation) observeRuntime({ kind: "external_run", scope: observation.scope, childRunId: subagentId,
          toolCallId: context?.toolCallId, step: context?.step, phase, at: Date.now() }, observation);
      };

      const processBroker = context?.process ?? createLocalProcessBroker(signal);
      const before = await gitStatusSnapshot(cwd, processBroker);
      if (signal?.aborted) return { success: false, output: "", error: "aborted" };

      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("timeout")); }, timeoutMs);
      timer.unref?.();

      const handlers = createAcpHostHandlers({ agentId: spec.id, cwd, approve: opts.approve,
        trackEdit: opts.trackEdit, signal: controller.signal });
      opts.onEvent?.({ type: "sub_agent_started", subagentId, agentType: spec.id, task, path: [] });
      observe("starting");

      let result: AcpTaskResult | undefined;
      let failure: unknown;
      const startedAt = Date.now();
      try {
        const transport = opts.transportFactory?.(spec, cwd) ?? stdioTransport(processBroker.spawnCommand(spec.command, spec.args ?? [], {
          cwd, hostHome: true, environment: spec.env, preserveEnvironment: spec.preserveEnvironment, stdin: "pipe",
        }));
        observe("running");
        result = await runAcpTask({
          spec, task, cwd, transport, handlers,
          sessionId: (args.session_id as string | undefined)?.trim() || undefined,
          mode: (args.mode as string | undefined)?.trim() || undefined,
          path: [subagentId],
          onEvent: opts.onEvent,
          signal: controller.signal,
          clientVersion: opts.clientVersion,
        });
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      const aborted = !!signal?.aborted;
      const after = await gitStatusSnapshot(cwd, processBroker);
      const changes = diffSnapshots(before, after);
      // A timeout or abort the agent honoured still returns a result with
      // stopReason "cancelled"; that is not a completed task.
      const success = !!result && !failure && !aborted && !timedOut
        && result.stopReason !== "refusal" && result.stopReason !== "cancelled";
      observe(aborted ? "cancelled" : success ? "exited" : "failed");
      opts.onEvent?.({ type: "sub_agent_finished", subagentId, agentType: spec.id, success,
        usage: result?.usage, steps: result?.toolCalls, path: [] });

      const changeText = changes ? formatChangeSummary(spec.id, cwd, changes) : "";
      const meta = { agent: spec.id, agentName: result?.agentName, durationMs: Date.now() - startedAt,
        sessionId: result?.sessionId, resumed: result?.resumed, stopReason: result?.stopReason, usage: result?.usage,
        changes, written: [...handlers.written], permissions: handlers.decisions, warnings: result?.warnings };

      if (!result) {
        const reason = aborted ? "aborted"
          : timedOut ? `${spec.id} timed out after ${Math.round(timeoutMs / 1000)}s`
          : `${spec.id} failed: ${failure instanceof Error ? failure.message : String(failure)}`
            + (failure instanceof AcpClientError && failure.code === "auth_required"
              ? `\nThe agent reported an authentication problem; sign in with its own CLI (\`${spec.command}\`) if needed.` : "");
        return { success: false, output: changeText, error: reason, meta };
      }

      const sections: string[] = [result.report || "_(The agent ended its turn without a message.)_"];
      if (result.stopReason !== "end_turn") sections.push(`_Stop reason: ${result.stopReason}_`);
      const notes: string[] = [];
      if (handlers.written.size) notes.push(`Written through zap: ${[...handlers.written].map(path => relative(cwd, path) || path).join(", ")}`);
      const denied = handlers.decisions.filter(decision => !decision.allowed);
      if (denied.length) notes.push(`Denied by zap: ${denied.map(decision => decision.title).join("; ")}`);
      if (result.warnings.length) notes.push(`Setup warnings: ${result.warnings.join("; ")}`);
      if (spec.selfGoverned && changeText) notes.push(`${spec.id} edits files directly; zap checkpoints do not cover those changes.`);
      if (changeText) sections.push(`---\n${changeText}`);
      if (notes.length) sections.push(notes.map(note => `_${note}_`).join("\n"));
      if (result.resumable) sections.push(`_Session: pass \`session_id="${result.sessionId}"\` with agent="${spec.id}" to continue._`);
      const error = success ? undefined
        : timedOut ? `${spec.id} timed out after ${Math.round(timeoutMs / 1000)}s; partial report above.`
        : aborted ? "aborted"
        : `stop reason: ${result.stopReason}`;
      return { success, output: sections.join("\n\n"), error, meta };
    },
  };
}
