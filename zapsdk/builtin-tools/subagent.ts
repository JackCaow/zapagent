import { z } from "zod";
import { join } from "node:path";
import { currentRuntimeObservation, observeRuntime, withRuntimeObservation, withChildObservation } from "../runtime/observation.js";
import type { Tool, ToolExecutionContext, ToolResult } from "../tools/types.js";
import type { LLMProvider } from "../core/llm.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  ToolExecutor,
  type ApprovalCallback,
  type ToolExecutorOptions,
} from "../tools/executor.js";
import type { PromptProfile } from "../agent/prompt-profile.js";
import { LoopAgent } from "../agent/loop.js";
import { CheckpointManager } from "../checkpoint/index.js";
import type { AgentEvent, AgentEventHandler } from "../agent/events.js";
import type { AgentBudget } from "../agent/budget.js";
import { todoWriteTool, type TodoStore } from "./todo.js";
import { executeCommandTool } from "./command.js";
import { countCodePoints, sliceHeadCodePoints } from "../utils/logical-lines.js";
import type { AgentRunSnapshot, AgentRunStatus } from "../agent/run-state.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { WorkspaceLease, MergeResult } from "../workspace/types.js";
import type { MergeCoordinator } from "../merge/coordinator.js";
import { mergeAgentArtifactsTool } from "../merge/tool.js";
import type { AgentCoordinator } from "../coordinator/coordinator.js";
import type { DeferredAgentCoordinatorExecutor } from "../coordinator/executor-bridge.js";

// ─── Options ────────────────────────────────────────────────────────────────

export interface SubagentToolOptions {
  /** Host-owned constraints, preserved across custom roles and descendants. */
  inheritedInstructions?: string;
  /** Host-selected behavior profile, inherited by descendants. */
  promptProfile?: PromptProfile;
  getResultSchema?: () => "outcome-v1" | "legacy";
  provider: LLMProvider;
  registry: ToolRegistry;
  executorOptions?: Omit<ToolExecutorOptions, "onApproval">;
  onApproval?: ApprovalCallback;
  maxSteps?: number;
  timeoutMs?: number;
  maxDepth?: number;
  onEvent?: AgentEventHandler;
  /** Max chars to return when the subagent produced tool results but no summary text (default: 32_000). */
  maxSalvageChars?: number;
  /** Shared tree-wide budget. Passed through to nested subagents. */
  budget?: AgentBudget;
  /** Fallback provider (inherits from root when wired). */
  fallbackProvider?: LLMProvider;
  /** Ancestor subagent ids (path from root). Flattened events concat their own id. */
  eventPath?: string[];
  /** When set, general-type subagents get their own keyed todo list via
   *  this store (keyed by subagentId). Omit to keep subagents' inherited
   *  todo_write routed to "main" — which was the latent bug this fixes. */
  todoStore?: TodoStore;
  /** Model override for `explore`-type subagents (e.g. a cheaper Haiku).
   *  When undefined, explore uses the parent provider's bound model.
   *  `general` and `plan` always use the parent model regardless. */
  exploreModel?: string;
  /** Char threshold for auto-compaction inside the subagent run. Defaults
   *  to 200_000 chars (~50k tokens). Set to 0 to disable. */
  subagentAutoCompactThreshold?: number;
  /** Context window + ceiling inherited from parent LoopAgent for per-call
   *  budget planning. Subagents typically use a narrower slice of the full
   *  context but the absolute bounds are shared with the parent provider. */
  contextWindow?: number;
  inputTokenLimit?: number;
  outputTokenCeiling?: number;
  reservedOutputTokens?: number;
  /** Project cwd used by nested LoopAgents for oversized tool output storage
   *  and by explore-mode read-only bash as its default working directory. */
  storageProjectCwd?: string;
  /** Shared per-root-run workspace snapshot for writing Agents. */
  workspaceManager?: WorkspaceManager;
  mergeCoordinator?: MergeCoordinator;
  /** Rebuild cwd-sensitive builtin handlers for an isolated workspace. */
  createRegistryForCwd?: (cwd: string) => ToolRegistry;
  /** When true, a general Agent is blocked instead of sharing the root cwd. */
  requireWriteIsolation?: boolean;
  /** Runtime-owned scheduler. When present this Tool is only a submission
   * adapter; it never constructs an independently owned Agent lifecycle. */
  coordinator?: AgentCoordinator;
  coordinatorExecutorBridge?: DeferredAgentCoordinatorExecutor;
}

// ─── Read-only bash for `explore` subagents ────────────────────────────────
//
// Explore is read-only by design. To let it run things like `git log/diff`,
// `ls`, `find`, `wc` (which are invaluable for codebase investigation) we
// swap the regular `bash` tool for a validated variant: same executor, but
// the command has to pass a safety check first.
//
// The validator is deliberately conservative — defense in depth, not
// bulletproof. Model is also told in the system prompt to only run
// read-only commands. The validator catches cases where the model either
// misunderstands or deliberately tries to slip a write through.

const READONLY_BIN_ALLOWLIST = new Set([
  // Listing / reading
  "ls", "cat", "head", "tail", "wc",
  // Searching
  "find", "grep", "rg", "fgrep", "egrep",
  // Dir / file metadata
  "tree", "file", "stat", "pwd", "basename", "dirname", "readlink", "realpath",
  // Text inspection (read-only flags only; no `sed -i`, no awk `system`)
  "sort", "uniq", "cut", "tr", "comm", "diff", "cmp",
  "column", "paste", "fold", "rev", "od", "hexdump", "strings",
  // Hashing / checksums (read-only)
  "md5sum", "sha1sum", "sha256sum",
  // Misc safe utilities
  "echo", "which", "type", "date", "uname", "whoami", "hostname",
  "test", "[", "true", "false",
  // Git — subcommands further restricted below
  "git",
  // Structured data viewers (read-only)
  "jq", "yq",

  // --- Windows equivalents (cross-platform support) ---
  // 只允许真正只读、参数空间小到可控的工具。
  // 显式排除：
  //   - powershell / pwsh：完整可编程 shell，子命令空间无法白名单化
  //   - certutil：是 LOLBin，可下载/写文件 (`certutil -urlcache -split -f <url>`)
  "where",        // Windows's `which`
  "findstr",      // Windows's `grep`
  "fc",           // Windows's `diff`
  "comp",         // Windows's `diff` (binary)
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "log", "diff", "status", "blame", "show", "ls-files", "ls-tree",
  "rev-parse", "rev-list", "describe", "grep", "shortlog", "whatchanged",
  "cat-file", "for-each-ref", "name-rev",
]);

/** Returns null if safe, else a human-readable reject reason. */
export function validateReadOnlyBash(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed) return "empty command";

  // Reject shell control that could chain unsafe commands or redirect output.
  // Pipes (|) are allowed because they compose read-only filters.
  if (/;|&&|\|\||>|<|\$\(|`/.test(trimmed)) {
    return "shell control (;, &&, ||, >, <, $(), backticks) is not allowed in read-only mode. Plain pipes (|) are allowed.";
  }
  // Reject trailing `&` (background).
  if (/&\s*$/.test(trimmed)) return "background (&) is not allowed in read-only mode";

  // Validate each pipeline segment independently.
  const segments = trimmed.split(/\s*\|\s*/);
  for (const seg of segments) {
    const parts = seg.trim().split(/\s+/);
    const first = parts[0];
    if (!first) return "empty pipeline segment";

    if (!READONLY_BIN_ALLOWLIST.has(first)) {
      return `'${first}' is not in the read-only allowlist. Allowed: ${[...READONLY_BIN_ALLOWLIST].slice(0, 12).join(", ")}…`;
    }

    if (first === "git") {
      const sub = parts[1];
      if (!sub) return "git requires a subcommand";
      if (!READONLY_GIT_SUBCOMMANDS.has(sub)) {
        return `git ${sub} is not in the read-only allowlist (allowed: log, diff, status, blame, show, ls-files, …)`;
      }
      if (parts.some((part) => part === "--output" || part.startsWith("--output="))) {
        return "git --output is not allowed in read-only mode";
      }
    }

    if (first === "find") {
      // -exec / -delete / -ok all run or remove; block them.
      if (/\s-(exec|delete|ok|execdir|okdir)\b/.test(seg)) {
        return "find -exec / -delete / -ok / -execdir / -okdir are not allowed";
      }
    }

    if (first === "sort" && parts.some((part) => part === "-o" || part.startsWith("--output"))) {
      return "sort output-file options are not allowed in read-only mode";
    }

    if (first === "yq" && parts.some((part) => part === "-i" || part === "--inplace")) {
      return "yq in-place editing is not allowed in read-only mode";
    }

    if (first === "sed") {
      // sed has -i (in-place edit) and `e` command (exec). Block sed entirely
      // rather than try to parse flags — awk has similar risks.
      return "sed is not allowed (use grep/rg for read-only pattern extraction)";
    }
  }

  return null;
}

/** Build a read-only-validated bash tool. Wraps executeCommandTool: the
 *  actual subprocess execution is unchanged, we just gate the `command`
 *  argument. Registered under the same name ("bash") so the subagent's
 *  tool schema is indistinguishable from the main agent's — the model
 *  doesn't need to learn a new tool name. */
function readOnlyBashTool(defaultCwd?: string): Tool {
  const inner = executeCommandTool({ defaultCwd, allowUnsandboxed: false });
  return {
    ...inner,
    definition: {
      ...inner.definition,
      description:
        inner.definition.description +
        " (READ-ONLY MODE: only ls/cat/head/tail/find/grep/rg/git log|diff|status|blame/… accepted; writes and shell control blocked.)",
      resolveEffects: (_args, context) => ({
        filesystem: [{ kind: "filesystem", operation: "read", paths: [context.cwd] }],
        network: [],
        process: [{
          kind: "process",
          operation: "spawn",
          commandClass: "read-only-shell",
          background: false,
        }],
        external: [],
        workspace: { mode: "shared-readonly" },
        confidence: "declared",
      }),
    },
    handler: async (args, signal, context) => {
      const command = args.command as string;
      const reject = validateReadOnlyBash(command);
      if (reject) {
        return {
          success: false,
          output: "",
          error: `bash blocked in read-only mode: ${reject}`,
        };
      }
      return inner.handler(args, signal, context);
    },
  };
}

// ─── Agent types ────────────────────────────────────────────────────────────

const EXPLORE_TOOLS = new Set([
  "read_file", "glob_files", "search_files", "list_tree",
  "web_search", "http_fetch", "current_time", "bash",
]);

const PLAN_TOOLS = new Set([
  "read_file", "glob_files", "search_files", "list_tree",
  "web_search", "http_fetch", "current_time", "bash",
]);

type Thoroughness = "quick" | "medium" | "thorough";

const THOROUGHNESS_STEP_BUDGET: Record<Thoroughness, number> = {
  quick: 10,
  medium: 30,
  thorough: 60,
};

/** Static part of the explore system prompt — tuned for non-Claude models
 *  that need explicit guidance (Claude already has strong priors for this
 *  mode). Kept verbose on purpose: one extra K tokens here saves many
 *  more by preventing aimless exploration. */
const EXPLORE_PROMPT_BASE = `You are a read-only exploration subagent. The main agent delegated an investigation to you and will synthesize your output — do NOT try to produce a final deliverable for the user, just report what you found.

=== CRITICAL: READ-ONLY MODE ===
You CANNOT modify any files. You do NOT have write, edit, or delete tools. If the task asks you to change something, reply with "Cannot modify files — I can only report findings" and stop. Never attempt a modification through a loophole (e.g. bash redirects or sed — both are blocked).

=== How to explore ===
Prefer this order, shortest-path first:
1. list_tree on the project root to get the shape of the codebase.
2. glob_files with a narrow pattern (e.g. "src/**/auth*.ts") when you know the topic.
3. search_files (regex over file contents) when you need to find usages, definitions, or strings.
4. read_file on specific lines/ranges once you've narrowed to 1-3 candidates. Don't read an entire large file if a range suffices.
5. Use only the tools exposed to this subagent. If the investigation requires an unavailable capability, report that limitation and the observation still needed.

=== When to stop ===
Stop as soon as you have enough to answer the briefing. Over-exploration burns tokens and time. If you've read the same file twice or looked at 5+ candidates without narrowing, you probably have enough — summarize.

=== Output format ===
Report findings as a concise message (no file writes). Structure:
- Lead with the direct answer to the briefing in 1-3 sentences.
- List key evidence with precise file:line references. Example: "Relevant code: src/auth/login.ts:42-58".
- If relevant, note what you did NOT find or could not determine — the main agent needs to know.
- Do NOT repeat the briefing back. Do NOT narrate each tool call.

=== Web search ===
Use web_search / http_fetch only when the question is about external knowledge (library APIs, standards, error messages). Do not web-search for codebase-local information.`;

const THOROUGHNESS_HINT: Record<Thoroughness, string> = {
  quick:
    "=== Thoroughness: quick ===\nSpeed over depth. Return the first plausible answer with file:line. Budget: ~5-8 tool calls. If the answer isn't found fast, say so and let the main agent re-delegate with more context.",
  medium:
    "=== Thoroughness: medium ===\nBalanced. Verify your answer by cross-checking 1-2 related files before summarizing. Budget: ~15-25 tool calls.",
  thorough:
    "=== Thoroughness: thorough ===\nDig deep. Trace cross-file relationships, check tests and callers, note edge cases and inconsistencies. Budget: up to ~50 tool calls, but still stop when the picture is clear.",
};

function buildExplorePrompt(thoroughness: Thoroughness): string {
  return `${EXPLORE_PROMPT_BASE}\n\n${THOROUGHNESS_HINT[thoroughness]}`;
}

interface AgentTypeConfig {
  description: string;
  tools: Set<string> | null;
  /** Base prompt. For explore, the thoroughness hint is appended at runtime. */
  basePrompt: string;
}

const AGENT_TYPES: Record<string, AgentTypeConfig> = {
  general: {
    description: "File editing; see runtime shell capabilities below.",
    tools: null,
    basePrompt:
      "You are a writing subagent. Complete the given task using the tools available in your assigned workspace. Respect its execution and isolation boundaries. Output only your final result — the main agent will synthesize it.",
  },
  explore: {
    description: "Read-only inspection.",
    tools: EXPLORE_TOOLS,
    basePrompt: EXPLORE_PROMPT_BASE, // full prompt built in handler
  },
  plan: {
    description: "Read-only planning.",
    tools: PLAN_TOOLS,
    basePrompt:
      "You are an architecture subagent. Explore the codebase, then produce a clear step-by-step implementation plan. Do NOT write or modify code. Include: files to change, functions to add/modify, and potential risks.",
  },
};

type AgentType = keyof typeof AGENT_TYPES;

// ─── DESCRIPTION + PROMPT (CCB pattern) ─────────────────────────────────────

function buildDescription(options: SubagentToolOptions): string {
  const typeList = Object.entries(AGENT_TYPES)
    .map(([k, v]) => `${k}: ${v.description}`)
    .join("; ");
  const sandboxAvailable = options.executorOptions?.executionBroker?.sandboxStatus().available === true;
  const readOnlyShell = options.registry?.has("bash") && sandboxAvailable
    ? "allowlisted inspection commands only"
    : "unavailable";
  const generalShell = options.workspaceManager && options.createRegistryForCwd
    ? `Isolated shell access: ${sandboxAvailable
      ? "requires an OS sandbox and a workspace bash tool"
      : "unavailable (OS sandbox unavailable)"}.`
    : options.requireWriteIsolation
      ? "General agent unavailable: isolated workspace runtime is not configured."
      : `General shell access: ${options.registry?.has("bash") ? "inherited from parent execution policy" : "unavailable"}.`;
  const generalInputs = options.workspaceManager && options.createRegistryForCwd
    ? " General input access: private workspace snapshot. External paths are not shared; inspect them with your tools and pass relevant observations in the briefing. Later parent edits may be absent."
    : "";
  return `Delegate; return a report. ${typeList}\nRead-only shell access: ${readOnlyShell}. ${generalShell} For builds, tests or custom programs use general if supported, or your own tools.${generalInputs}`;
}

/** Threshold below which runtime results include visible budget feedback.
 *  The tool prompt itself stays static so provider-side tool-schema prompt
 *  caching can reuse it across turns. */
const LOW_BUDGET_THRESHOLD = 2;

function buildPrompt(): string {
  return `Delegate independent work or isolate context. Weigh capabilities, inputs, dependencies, cost and time, not call count. Honor explicit delegation requests.

Use \`explore\` for inspection, \`plan\` for design, \`general\` for changes, builds, tests or diagnostic scripts. Check shell limits; use your tools if unavailable. Brief goal, context and output.

Reviews: separate requirements, assumptions and verified observations; include available callers/tests. Agreement alone is not independent verification.

General changes stay isolated. After siblings finish, call \`merge_agent_artifacts\` once with all artifact ids; report conflicts.

One round is one parallel spawn wave; findings inform the next. Do not combine rounds. Do NOT fabricate later rounds when resources prevent them.

Never delegate the final answer; synthesize reports yourself.`;
}

export function subagentToolPrompt(): string {
  return buildPrompt();
}

export function truncateSubagentToolOutputs(toolOutputs: string, maxChars: number): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  const totalChars = countCodePoints(toolOutputs);
  if (totalChars <= limit) return toolOutputs;
  return `${sliceHeadCodePoints(toolOutputs, limit)}\n…[truncated — ${totalChars} total chars]`;
}

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function subagentTool(options: SubagentToolOptions): Tool {
  const direct = createDirectSubagentTool(options);
  if (!options.coordinator) return direct;
  if (!options.coordinatorExecutorBridge) {
    throw new Error("AgentCoordinator requires a coordinatorExecutorBridge");
  }
  const coordinator = options.coordinator;
  const executorBindingId = `subagent:${options.maxDepth ?? 2}:${(options.eventPath ?? []).join("/")}`;
  options.coordinatorExecutorBridge.bind({
    execute: async (execution) => {
      const meta = execution.metadata;
      const result = await withRuntimeObservation(execution.runtimeObservation, () => direct.handler({
        task: execution.run.task,
        agent_type: execution.run.agentType,
        thoroughness: typeof meta.thoroughness === "string" ? meta.thoroughness : "medium",
        ...(typeof meta.systemPrompt === "string" ? { system_prompt: meta.systemPrompt } : {}),
      }, execution.signal, {
        observations: execution.observations,
        deadlineAtMs: execution.deadlineAtMs,
        toolCallId: execution.run.toolCallId,
        agentRun: {
          runId: execution.run.runId,
          parentRunId: execution.run.parentRunId,
          reportStatus: execution.reportStatus,
        },
      }));
      const resultMeta = (result.meta ?? {}) as {
        steps?: number;
        usage?: import("../core/types.js").TokenUsage;
        workspaceId?: string;
        artifactId?: string;
        changedPaths?: string[];
      };
      return {
        success: result.success,
        text: result.output,
        error: result.error,
        steps: resultMeta.steps,
        usage: resultMeta.usage,
        workspaceId: resultMeta.workspaceId,
        artifactId: resultMeta.artifactId,
        changedPaths: resultMeta.changedPaths,
      };
    },
  }, executorBindingId);
  return {
    ...direct,
    handler: async (args, _signal, context) => {
      const task = String(args.task ?? "").trim();
      const agentType = String(args.agent_type ?? "general");
      const run = await coordinator.spawn({
        task,
        agentType,
        toolCallId: context?.toolCallId,
        parentRunId: context?.agentRun?.runId,
        metadata: {
          executorBindingId,
          thoroughness: String(args.thoroughness ?? "medium"),
          ...(typeof args.system_prompt === "string" ? { systemPrompt: args.system_prompt } : {}),
        },
      }, { observations: context?.observations, deadlineAtMs: context?.deadlineAtMs,
        runtimeObservation: currentRuntimeObservation() });
      const observation = currentRuntimeObservation();
      if (observation) observeRuntime({ kind: "run_binding", scope: observation.scope,
        childRunId: run.runId, toolCallId: context?.toolCallId, step: context?.step });
      const abort = () => { void coordinator.cancel(run.runId, "parent Agent Tool was cancelled"); };
      if (_signal?.aborted) abort();
      else _signal?.addEventListener("abort", abort, { once: true });
      const result = await coordinator.wait(run.runId).finally(() => {
        _signal?.removeEventListener("abort", abort);
      });
      return {
        success: result.success,
        output: result.text,
        error: result.error,
        meta: {
          subagentId: result.runId,
          agentType,
          steps: result.steps,
          usage: result.usage,
          workspaceId: result.workspaceId,
          artifactId: result.artifactId,
          changedPaths: result.changedPaths,
        },
      };
    },
  };
}

function createDirectSubagentTool(options: SubagentToolOptions): Tool {
  const artifactRunCallbacks = new Map<string, (result: MergeResult) => void>();
  const artifactMergeStarters = new Map<string, () => void>();
  if (options.mergeCoordinator && !options.registry.has("merge_agent_artifacts")) {
    options.registry.register(mergeAgentArtifactsTool({
      coordinator: options.mergeCoordinator,
      onStart: (artifactIds) => {
        for (const artifactId of artifactIds) artifactMergeStarters.get(artifactId)?.();
      },
      onResult: (result) => {
        for (const artifactId of result.artifactIds) {
          artifactRunCallbacks.get(artifactId)?.(result);
          if (result.success) artifactRunCallbacks.delete(artifactId);
          if (result.success) artifactMergeStarters.delete(artifactId);
        }
      },
    }));
  }
  return {
    definition: {
      name: "agent",
      get description() { return buildDescription(options); },
      prompt: buildPrompt(),
      parameters: z.object({
        task: z.string().describe("Briefing: goal, known context, expected output format"),
        agent_type: z.enum(["general", "explore", "plan"])
          .optional()
          .default("general")
          .describe("Agent type (default: general)"),
        thoroughness: z.enum(["quick", "medium", "thorough"])
          .optional()
          .default("medium")
          .describe("Explore depth: quick (~5-8 calls), medium (~15-25), thorough (~up to 50). Only affects agent_type=explore."),
        system_prompt: z.string().optional()
          .describe("Override the default system prompt for this agent type"),
      }),
      permission: "auto",
      timeoutMs: options.timeoutMs ?? 600_000,
      // Explore and plan registries expose only read-only tools, so sibling
      // calls can safely run in parallel. General agents retain the full tool
      // registry and must stay on the serialized write chain.
      isReadOnlyCall: (args) => (
        args.agent_type === "explore" || args.agent_type === "plan"
      ),
      resolveEffects: (args) => {
        if (args.agent_type === "explore" || args.agent_type === "plan") {
          return {
            filesystem: [], network: [], process: [], external: [],
            workspace: { mode: "shared-readonly" as const },
            confidence: "declared" as const,
          };
        }
        if (options.workspaceManager && options.createRegistryForCwd) {
          return {
            filesystem: [], network: [], process: [], external: [],
            workspace: { mode: "isolated-write" as const },
            confidence: "declared" as const,
          };
        }
        return {
          filesystem: [], network: [], process: [], external: [],
          workspace: { mode: "root-integration" as const },
          confidence: "unknown" as const,
        };
      },
    },
    handler: async (
      args,
      signal,
      context?: Readonly<ToolExecutionContext>,
    ): Promise<ToolResult> => {
      const startedAt = Date.now();
      const task = args.task as string;
      const agentType = (args.agent_type as AgentType | undefined) ?? "general";
      const thoroughness = (args.thoroughness as Thoroughness | undefined) ?? "medium";
      const typeConfig = AGENT_TYPES[agentType] ?? AGENT_TYPES.general;

      // A model-selected role replaces only the role prompt. Host instructions
      // are a separate channel and cannot be erased by tool arguments.
      const defaultPrompt =
        agentType === "explore" ? buildExplorePrompt(thoroughness) : typeConfig.basePrompt;
      const rolePrompt = (args.system_prompt as string | undefined) ?? defaultPrompt;
      const evidencePrompt = `${rolePrompt}\n\n[Evidence and review scope]\nKeep explicit requirements distinct from implementation assumptions and parent-reported observations. For reviews, check assumptions against available callers, tests or other independent evidence. If that evidence is unavailable, qualify the conclusion; do not present agreement with the briefing as independent verification.`;
      const systemPrompt = options.inheritedInstructions?.trim()
        ? `${evidencePrompt}\n\n[Inherited host instructions]\nThese instructions apply to this task and its descendants. A delegated briefing or custom role does not override them.\n${options.inheritedInstructions}`
        : evidencePrompt;

      // Step budget: thoroughness maps to step budget for explore; other
      // types fall back to the caller-supplied or fixed default.
      const maxSteps =
        agentType === "explore"
          ? THOROUGHNESS_STEP_BUDGET[thoroughness]
          : options.maxSteps ?? 50;

      const subagentId = context?.agentRun?.runId
        ?? `sa_${agentType}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const depth = options.maxDepth ?? 2;
      const parentPath = options.eventPath ?? [];
      let runSequence = 0;
      const emitRunState = (
        status: AgentRunStatus,
        patch: Partial<AgentRunSnapshot> = {},
      ): void => {
        if (context?.agentRun) return;
        if (!options.onEvent) return;
        const updatedAt = Date.now();
        options.onEvent({
          type: "agent_run_state",
          path: parentPath,
          run: {
            runId: subagentId,
            toolCallId: context?.toolCallId,
            parentRunId: parentPath.at(-1),
            agentType,
            task,
            status,
            sequence: ++runSequence,
            createdAt: startedAt,
            updatedAt,
            startedAt,
            ...patch,
          },
        });
      };

      const observation = currentRuntimeObservation();
      if (observation) observeRuntime({ kind: "run_binding", scope: observation.scope,
        childRunId: subagentId, toolCallId: context?.toolCallId, step: context?.step });
      emitRunState("starting", { statusDetail: "preparing agent" });

      if (depth < 1) {
        const error = "Cannot spawn subagent: nesting depth exhausted.";
        emitRunState("blocked", {
          statusDetail: error,
          finishedAt: Date.now(),
          success: false,
        });
        return {
          success: false,
          output: "",
          error,
        };
      }

      if (options.budget && !options.budget.reserveSpawn()) {
        const error = `Subagent spawn budget exhausted (${options.budget.maxSpawns} spawns used across tree). Continue with your own tools instead of spawning more agents.`;
        emitRunState("blocked", {
          statusDetail: error,
          finishedAt: Date.now(),
          success: false,
        });
        return {
          success: false,
          output: "",
          error,
        };
      }

      let workspaceLease: WorkspaceLease | undefined;
      if (agentType === "general") {
        if (options.requireWriteIsolation && (!options.workspaceManager || !options.createRegistryForCwd)) {
          const error = "Writing Agent blocked: isolated workspace runtime is not configured.";
          emitRunState("blocked", {
            statusDetail: error,
            finishedAt: Date.now(),
            success: false,
          });
          return { success: false, output: "", error };
        }
        if (options.workspaceManager && options.createRegistryForCwd) {
          try {
            workspaceLease = await options.workspaceManager.acquire(subagentId, true);
          } catch (err) {
            const error = `Writing Agent workspace setup failed: ${err instanceof Error ? err.message : String(err)}`;
            emitRunState("blocked", {
              statusDetail: error,
              finishedAt: Date.now(),
              success: false,
            });
            return { success: false, output: "", error };
          }
        }
      }

      // ── Registry: type controls tool subset, capabilities stay equal ──
      const workspaceRegistry = workspaceLease && options.createRegistryForCwd
        ? options.createRegistryForCwd(workspaceLease.path)
        : options.registry;
      const baseRegistry = typeConfig.tools
        ? workspaceRegistry.subset([...typeConfig.tools])
        : workspaceRegistry.clone();
      const sandboxAvailable = options.executorOptions?.executionBroker
        ?.sandboxStatus().available === true;

      // The isolation policy denies every process launch without an OS sandbox.
      // Do not advertise bash to a child that cannot use it, even for inspection.
      if ((agentType === "explore" || agentType === "plan" || workspaceLease) && !sandboxAvailable) {
        baseRegistry.unregister("bash");
      }

      // ── Explore-only: swap the regular bash for a read-only-validated variant ──
      // Preserve the project cwd so bash/git observations line up with
      // read_file/search_files in embedded runs whose process cwd differs.
      if ((agentType === "explore" || agentType === "plan")
        && sandboxAvailable
        && baseRegistry.has("bash")) {
        baseRegistry.unregister("bash");
        baseRegistry.register(readOnlyBashTool(options.storageProjectCwd));
      }

      // ── Depth control ──
      const nestedEventPath = [...(options.eventPath ?? []), subagentId];
      if (workspaceLease) {
        // A nested Agent would otherwise be based on the root batch snapshot,
        // not its parent's unmerged workspace. Disable nesting until
        // WorkspaceManager supports parent-child snapshot lineage.
        baseRegistry.unregister("agent");
      } else if (depth > 1 && baseRegistry.has("agent")) {
        baseRegistry.unregister("agent");
        baseRegistry.register(subagentTool({
          ...options,
          maxDepth: depth - 1,
          eventPath: nestedEventPath,
        }));
      } else {
        baseRegistry.unregister("agent");
      }

      // ── Strip session-scoped scheduling / background tools ──
      // Cron jobs created inside a subagent would outlive the subagent and
      // fire in the main agent's context — a lifetime-escape + deferred
      // privilege escalation (cron_create is "auto", fired prompt runs with
      // main-agent tool permissions). Monitor has the same escape shape:
      // long-running children outlive the subagent. Mirrors Claude Code's
      // "teammates don't get durable cron" rule. Explore/plan subagents
      // already lack these via the tool allowlist; this gate covers general.
      baseRegistry.unregister("cron_create");
      baseRegistry.unregister("cron_delete");
      baseRegistry.unregister("cron_list");
      baseRegistry.unregister("monitor");
      // Session-level background task controls belong to the root agent. A
      // child observing or stopping its sibling's task would bypass owner
      // boundaries and make coordinator recovery non-deterministic.
      baseRegistry.unregister("task_status");
      baseRegistry.unregister("task_stop");
      // delegate_agent: external-CLI yolo mode is main-agent-only. A subagent
      // delegating outwards would let `explore` (read-only by design) trigger
      // unbounded writes through the external CLI — escapes the explore
      // contract and the user's confirm gate at the parent layer.
      baseRegistry.unregister("delegate_agent");
      // Inventory-wide review and destructive cross-record maintenance stay
      // main-agent-only. Subagents may save ordinary durable findings through
      // memory_save, but cannot inspect all scopes or consolidate records.
      baseRegistry.unregister("memory_review");
      baseRegistry.unregister("memory_merge");
      // Only the root coordinator integrates artifacts. A child Agent may
      // create nested artifacts but cannot apply them directly to the root.
      baseRegistry.unregister("merge_agent_artifacts");

      // ── Per-subagent todo key (else todo_write would clobber main's list) ──
      if (options.todoStore && baseRegistry.has("todo_write")) {
        const parentStore = options.todoStore;
        baseRegistry.unregister("todo_write");
        baseRegistry.register(todoWriteTool({
          store: {
            getKey: () => subagentId,
            get: (key) => parentStore.get(key),
            set: (key, oldTodos, newTodos) => parentStore.set(key, oldTodos, newTodos),
          },
        }));
      }

      const registry = baseRegistry;
      const autoCompactThreshold = options.subagentAutoCompactThreshold ?? 200_000;
      const workspacePrompt = workspaceLease && options.workspaceManager
        ? [
          "[Isolated workspace paths]",
          `Parent workspace root: ${JSON.stringify(options.workspaceManager.root)}`,
          `Your working directory and workspace root: ${JSON.stringify(workspaceLease.path)}`,
          "This is a private snapshot. When the briefing names a file under the parent root, use its path relative to that root. Use the same relative path inside your private workspace, or resolve it against your working directory above. Do not access the original parent path directly.",
          "Parent changes made after the snapshot may be absent, and some files may be excluded. Report missing required inputs to the parent; do not work around the workspace boundary.",
          "External paths are not included in this snapshot. Ask the parent for relevant observations; distinguish those observations from files you inspected yourself.",
        ].join("\n")
        : "";

      try {
        const subagentApproval: ApprovalCallback | undefined = options.onApproval
          ? async (toolName, toolArgs, approvalSignal, approvalContext) => {
              if (context?.agentRun) {
                await context.agentRun.reportStatus("waiting_approval", `approval required for ${toolName}`);
              } else emitRunState("waiting_approval", {
                statusDetail: `approval required for ${toolName}`,
                workspaceId: workspaceLease?.workspaceId,
                workspaceMode: workspaceLease?.mode ?? "shared-readonly",
              });
              try {
                return await options.onApproval!(toolName, toolArgs, approvalSignal, approvalContext);
              } finally {
                if (context?.agentRun) {
                  await context.agentRun.reportStatus("running", `resumed after ${toolName} approval`);
                } else emitRunState("running", {
                  statusDetail: `resumed after ${toolName} approval`,
                  workspaceId: workspaceLease?.workspaceId,
                  workspaceMode: workspaceLease?.mode ?? "shared-readonly",
                });
              }
            }
          : undefined;
        const isolatedCheckpoint = workspaceLease ? new CheckpointManager({
          sessionId: subagentId,
          cwd: workspaceLease.path,
          onError: (error) => { throw new Error(`Isolated checkpoint failed: ${error.reason}`); },
        }) : undefined;
        const executor = new ToolExecutor(registry, {
          ...options.executorOptions,
          cwd: workspaceLease?.path ?? options.storageProjectCwd,
          workspace: workspaceLease
            ? { id: workspaceLease.workspaceId, root: workspaceLease.path, mode: "isolated-write",
              ...(workspaceLease.mode === "isolated-git" && workspaceLease.repoPath
                ? { privateGitDirectory: join(workspaceLease.repoPath, ".git") } : {}) }
            : undefined,
          // Child writes need their own coverage. Never reuse root-path
          // checkpoints or bypass the destructive-write gate in a worktree.
          onTrackEdit: isolatedCheckpoint
            ? isolatedCheckpoint.createEditTracker()
            : options.executorOptions?.onTrackEdit,
          onApproval: subagentApproval,
        });

        const subagent = new LoopAgent({
          provider: options.provider,
          registry,
          executor,
          // Capability facts come from the filtered registry, including when a
          // caller replaces the role prompt. They never grant extra tools.
          systemPrompt: agentType === "explore" || agentType === "plan"
            ? `${systemPrompt}\n\n[Read-only execution capabilities]\n${registry.has("bash")
              ? "Shell access: bash is limited to allowlisted inspection commands."
              : "Shell access: bash is unavailable in this subagent."}\nCompilation, tests, interpreters and custom executables are unavailable in this read-only role. Report any missing capability and the observation still needed to the parent.`
            : workspaceLease
              ? `${systemPrompt}\n\n${workspacePrompt}\n\n[Isolated execution capabilities]\n${registry.has("bash")
                ? "Shell access: bash requires the OS sandbox and remains subject to execution policy."
                : "Shell access: bash is unavailable in this isolated subagent. Report required builds, tests or diagnostics to the parent so it can run them with its own tools after artifact integration; do not claim they were executed."}\n${workspaceLease.mode === "isolated-copy"
                  ? "Python virtual environments (directories with a regular pyvenv.cfg) are excluded from snapshots and merged artifacts. Recreate dependencies here as needed and deliver dependency manifests or source files; the private environment stays in this workspace."
                  : "Git commands may write this private clone's metadata; the parent repository and sibling workspaces remain outside the write boundary."}\nFile changes remain private until the parent merges the artifact. Do not work around the workspace boundary.`
              : systemPrompt,
          promptProfile: options.promptProfile,
          maxSteps,
          reserveSteps: 1,
          maxToolRetries: 2,
          budget: options.budget,
          fallbackProvider: options.fallbackProvider,
          // Inherit parent's budget planning so subagents don't overshoot.
          contextWindow: options.contextWindow,
          inputTokenLimit: options.inputTokenLimit,
          outputTokenCeiling: options.outputTokenCeiling,
          reservedOutputTokens: options.reservedOutputTokens,
          storageSessionId: subagentId,
          storageProjectCwd: workspaceLease?.path ?? options.storageProjectCwd,
          // Keep VM/runtime process state isolated per child Agent instead of
          // collapsing every subagent into LoopAgent's legacy "default"
          // session. The ID is host-authored and never model-controlled.
          sessionId: subagentId,
          // Explore-only: apply the cheaper model override if configured.
          modelOverride:
            agentType === "explore" && options.exploreModel ? options.exploreModel : undefined,
          // Char-based autocompact inside the subagent so long explorations
          // with big file reads don't blow past the context window. 0 disables.
          autoCompactThreshold: autoCompactThreshold > 0 ? autoCompactThreshold : undefined,
        });

        if (options.onEvent) {
          const onEvent = options.onEvent;
          emitRunState("running", {
            statusDetail: workspaceLease ? `isolated workspace ${workspaceLease.workspaceId}` : "shared read-only workspace",
            workspaceId: workspaceLease?.workspaceId,
            workspaceMode: workspaceLease?.mode ?? "shared-readonly",
          });
          onEvent({ type: "sub_agent_started", subagentId, agentType, task, path: parentPath });
          subagent.on("*", (event: AgentEvent) => {
            onEvent({ ...event, path: event.path ?? nestedEventPath });
          });
        }

        subagent.on("content_final", (event) => {
          if (event.type === "content_final" && event.kind === "tool_result" && !event.path?.length) {
            context?.observations?.record({ toolName: event.toolName, ...event.result });
          }
        });
        const result = await withChildObservation(subagentId, () => subagent.run(task, {
          signal, resultSchema: options.getResultSchema?.(), deadlineAtMs: context?.deadlineAtMs,
        }));
        const durationMs = Date.now() - startedAt;

        const hadOutput = options.getResultSchema?.() === "outcome-v1" || !!result.text || result.toolResults.some((r) => r.success);
        let artifact: import("../workspace/types.js").AgentArtifact | null = null;
        if (workspaceLease && hadOutput && !signal?.aborted && options.workspaceManager) {
          emitRunState("validating", {
            statusDetail: "freezing workspace artifact",
            workspaceId: workspaceLease.workspaceId,
            workspaceMode: workspaceLease.mode,
          });
          artifact = await options.workspaceManager.finalize(workspaceLease);
        }

        if (options.onEvent) {
          const readyToMerge = Boolean(artifact && artifact.changedPaths.length > 0);
          emitRunState(
            signal?.aborted ? "cancelled" : !hadOutput ? "failed" : readyToMerge ? "ready_to_merge" : "completed",
            {
              statusDetail: readyToMerge ? `${artifact!.changedPaths.length} file(s) ready to merge` : result.stopped,
              finishedAt: readyToMerge ? undefined : Date.now(),
              success: hadOutput && !signal?.aborted,
              steps: result.steps,
              usage: result.totalUsage,
              workspaceId: workspaceLease?.workspaceId,
              workspaceMode: workspaceLease?.mode ?? "shared-readonly",
              artifactId: artifact?.artifactId,
            },
          );
          options.onEvent({
            type: "sub_agent_finished",
            subagentId,
            agentType,
            success: hadOutput,
            steps: result.steps,
            usage: result.totalUsage,
            path: parentPath,
          });
          if (artifact && readyToMerge) {
            artifactMergeStarters.set(artifact.artifactId, () => {
              if (context?.agentRun && options.coordinator) {
                void options.coordinator.markMerging(subagentId);
                return;
              }
              emitRunState("merging", {
                statusDetail: "preflighting artifact batch",
                workspaceId: workspaceLease?.workspaceId,
                workspaceMode: workspaceLease?.mode,
                artifactId: artifact?.artifactId,
                steps: result.steps,
                usage: result.totalUsage,
              });
            });
            artifactRunCallbacks.set(artifact.artifactId, (mergeResult) => {
              if (context?.agentRun && options.coordinator) {
                void options.coordinator.completeMerge(
                  subagentId,
                  mergeResult.success,
                  mergeResult.error,
                );
                return;
              }
              emitRunState(mergeResult.success ? "completed" : "blocked", {
                statusDetail: mergeResult.success
                  ? "artifact merged into root workspace"
                  : mergeResult.error ?? "artifact merge blocked",
                finishedAt: Date.now(),
                success: mergeResult.success,
                steps: result.steps,
                usage: result.totalUsage,
                workspaceId: workspaceLease?.workspaceId,
                workspaceMode: workspaceLease?.mode,
                artifactId: artifact?.artifactId,
              });
            });
          }
        }

        const commonMeta = {
          subagentId,
          agentType,
          thoroughness: agentType === "explore" ? thoroughness : undefined,
          durationMs,
          steps: result.steps,
          toolCallCount: result.toolResults.length,
          usage: result.totalUsage,
          stopped: result.stopped,
          modelOverrideApplied:
            agentType === "explore" && !!options.exploreModel ? options.exploreModel : undefined,
          workspaceId: workspaceLease?.workspaceId,
          workspaceMode: workspaceLease?.mode,
          artifactId: artifact?.artifactId,
          changedPaths: artifact?.changedPaths,
        };

        const artifactSuffix = artifact && artifact.changedPaths.length > 0
          ? `\n\n---\n_Isolated changes are frozen as ${artifact.artifactId}. Call merge_agent_artifacts with artifact_ids=["${artifact.artifactId}"] (combine sibling artifact ids in one call) before reporting completion._`
          : "";

        // Progressive budget visibility, gated on low-budget only. Above the
        // threshold we hide the tally entirely so the model doesn't pace
        // itself against a visible cap — it should default to using subagents
        // when they fit, not hoard remaining spawns. Once the budget is low,
        // we surface the count so the remaining spawns become intentional.
        const budgetSuffix =
          options.budget && options.budget.spawnsRemaining <= LOW_BUDGET_THRESHOLD
            ? `\n\n---\n_Subagent budget: ${options.budget.spawnsUsed}/${options.budget.maxSpawns} used, ${options.budget.spawnsRemaining} left — wrap up cleanly._`
            : "";

        if (result.text) {
          return { success: true, output: result.text + artifactSuffix + budgetSuffix, meta: commonMeta };
        }

        // The child owns its final summary and metered lifecycle. Once it has
        // finished, salvage is deterministic: never start an untracked request.
        const toolOutputs = result.toolResults
          .filter((r) => r.success && r.output)
          .map((r) => r.output)
          .join("\n---\n");

        if (toolOutputs) {
          const cap = options.maxSalvageChars ?? 32_000;
          const body = truncateSubagentToolOutputs(toolOutputs, cap);
          return {
            success: true,
            output: `[Agent gathered data but did not produce a summary. Raw findings:]\n${body}${artifactSuffix}${budgetSuffix}`,
            meta: { ...commonMeta, salvage: "raw" },
          };
        }

        return {
          success: false,
          output: "",
          error: `Agent (${agentType}) completed ${result.steps} steps but produced no output. ${result.stopped ? `Stopped: ${result.stopped}. ` : ""}Tokens: ${result.totalUsage.inputTokens}in/${result.totalUsage.outputTokens}out.`,
          meta: commonMeta,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitRunState(signal?.aborted ? "cancelled" : "failed", {
          statusDetail: message,
          finishedAt: Date.now(),
          success: false,
        });
        return {
          success: false,
          output: "",
          error: `Agent (${agentType}) failed: ${message}`,
          meta: { subagentId, agentType, durationMs: Date.now() - startedAt },
        };
      }
    },
  };
}
