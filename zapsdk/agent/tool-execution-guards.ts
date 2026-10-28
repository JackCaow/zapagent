import type { ToolResult } from "../tools/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolExecutionHooks } from "./streaming-tool-executor.js";
import { operationFailure } from "../execution/failure.js";
import { isEffectivelyReadOnly } from "../tools/effects.js";
import { canonicalizeJsonSchema } from "../tools/schema.js";
import { sliceHeadCodePoints } from "../utils/logical-lines.js";
import { createHash } from "node:crypto";

// Only results created before executor dispatch carry this in-process proof.
// Serialized metadata (including runtime.suppression) cannot establish that no
// process ran, and copied/replayed results deliberately lose this authority.
const hostDuplicateSuppressions = new WeakSet<ToolResult>();

export function isHostDuplicateSuppression(result: ToolResult): boolean {
  return hostDuplicateSuppressions.has(result);
}

function duplicateSuppression(output: string): ToolResult {
  const result: ToolResult = { success: true, runtime: { suppression: "duplicate" }, output };
  hostDuplicateSuppressions.add(result);
  return result;
}

/** Short target label for observations and duplicate-query explanations.
 *  This lossy display value must not be used as an execution identity. */
export function primaryArgSig(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (name === "agent" && typeof args.task === "string") return String(args.task).slice(0, 80);
  if ((name === "search_files" || name === "glob_files") && typeof args.pattern === "string") return String(args.pattern);
  if (typeof args.path === "string") return String(args.path);
  if (typeof args.command === "string") return String(args.command).slice(0, 120);
  if (typeof args.cmd === "string") return String(args.cmd).slice(0, 120);
  if (typeof args.pattern === "string") return String(args.pattern);
  if (typeof args.query === "string") return String(args.query);
  if (typeof args.url === "string") return String(args.url);
  if (typeof args.task_id === "string") return String(args.task_id);
  return "";
}

export function stepSignature(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): string {
  return toolCalls
    .map((tc) => createHash("sha256").update(JSON.stringify([tc.name, tc.arguments], (_key, value) => {
      // Tool arguments are JSON values. Sort object keys only; array order,
      // including keys named enum/required, can change an operation's meaning.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      }
      return value;
    })).digest("hex"))
    .sort()
    .join(",");
}

/**
 * Tools whose semantics make consecutive same-signature calls *expected
 * progress*, not "stuck": iterating edits on one file (`edit_file` /
 * `multi_edit`), or repeatedly syncing the todo list (`todo_write`). Steps
 * composed entirely of these
 * tools bypass the REPEAT_LIMIT tracker.
 *
 * Trade-off: a step containing only whitelisted tools also RESETS the
 * tracker to null, so a mixed pattern like
 *   [bash(broken), edit_file] → [edit_file] → [bash(broken), edit_file]
 * no longer catches the stuck-bash signature. The streak only builds
 * across consecutive non-friendly steps. We accept this because the
 * common false-positive (iterative editing of a long document)
 * is far more frequent than alternating-pattern stuck loops, and
 * `maxSteps` + `timeoutMs` still bound runaway runs.
 */
const REPEAT_FRIENDLY_TOOLS = new Set<string>([
  "edit_file",
  "multi_edit",
  "todo_write",
]);

const DUPLICATE_QUERY_TOOLS = new Set(["read_file", "search_files"]);

const READ_ONLY_BASH_PROGRAMS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "sed",
  "find",
  "which",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "ls-tree",
  "describe",
]);

/**
 * The shell tool declares a conservative read+write effect because arbitrary
 * shell is impossible to prove safe.  For duplicate suppression we can still
 * recognise a deliberately tiny subset of inspection commands.  This is not
 * a permission decision: it merely avoids replaying the exact same query in a
 * single run.  Anything involving shell composition or a potentially writing
 * flag remains non-memoizable and keeps the existing invalidation semantics.
 */
function isMemoizableBashQuery(args: Record<string, unknown>): boolean {
  if (args.run_in_background === true || typeof args.command !== "string") return false;

  let command = args.command.trim();
  const cdMatch = command.match(/^cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))\s*&&\s*(.+)$/);
  if (cdMatch) {
    // The shell still expands double-quoted paths. Reject every metacharacter
    // in the `cd` expression instead of trying to model shell quoting.
    if (/[\n\r;|&><`$()]/.test(cdMatch[1])) return false;
    command = cdMatch[2].trim();
  }

  // Do not make a claim about any command whose shell parsing could introduce
  // an additional process, write, redirect, expansion, or control flow.
  if (!command || /[\n\r;|&><`$()]/.test(command)) return false;

  const [program, subcommand, ...rest] = command.split(/\s+/);
  if (program === "git") return !!subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  if (!READ_ONLY_BASH_PROGRAMS.has(program)) return false;

  // Only accept the common line-range inspection form. sed's script language
  // can itself execute commands, so a bare `sed` is not sufficiently safe.
  if (program === "sed") {
    return subcommand === "-n" &&
      typeof rest[0] === "string" &&
      /^['"]?\d+(?:,\d+)?p['"]?$/.test(rest[0]);
  }

  // `find -delete/-exec/-fprint` and `rg --pre` are counterexamples where an
  // otherwise familiar inspection program can mutate state or spawn an
  // arbitrary helper.
  const allArgs = [subcommand, ...rest].filter((value): value is string => !!value);
  if (program === "find" && allArgs.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/i.test(arg))) return false;
  if (program === "rg" && allArgs.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return false;
  return true;
}

function isDuplicateQuery(name: string, args: Record<string, unknown>): boolean {
  return DUPLICATE_QUERY_TOOLS.has(name) || (name === "bash" && isMemoizableBashQuery(args));
}

/** Key for a repeatable remote read (http_fetch GET/HEAD); undefined for anything else. */
/** A page fetched this recently is reused; an older one may have changed, so it is fetched again. */
const FETCH_REUSE_WINDOW_MS = 10 * 60 * 1000;

function httpFetchKey(name: string, args: Record<string, unknown>): string | undefined {
  if (name !== "http_fetch" || typeof args.url !== "string") return undefined;
  const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
  return `${method} ${args.url}${args.raw === true ? " raw" : ""}`;
}

function duplicateQueryKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(canonicalizeJsonSchema(args))}`;
}

export type TaskDecompositionMode = "off" | "auto" | "required";

interface TaskPlanGateState {
  ready: boolean;
  baselineReads: number;
}

function initialPlanError(
  mode: TaskDecompositionMode,
  args: Record<string, unknown>,
): string | undefined {
  const todos = args.todos;
  if (!Array.isArray(todos)) return "todo_write requires a todos array.";
  const minItems = mode === "required" ? 3 : 2;
  if (todos.length < minItems || todos.length > 6) {
    return `Create an actionable ${minItems}-6 item plan before execution; received ${todos.length} item(s).`;
  }
  const items = todos.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (items.length !== todos.length) return "Each plan item must be a structured todo.";
  if (items.filter((item) => item.status === "in_progress").length !== 1) {
    return "Mark exactly one concrete plan item as in_progress before execution.";
  }
  if (mode === "required") {
    if (items.some((item) => typeof item.acceptanceCriteria !== "string" || !item.acceptanceCriteria.trim())) {
      return "Give every plan item an acceptanceCriteria with observable proof of completion.";
    }
    const planText = items.map((item) => `${item.content ?? ""} ${item.acceptanceCriteria ?? ""}`).join(" ");
    if (!/(?:probe|smoke|end[ -]?to[ -]?end|e2e|minimal.*(?:run|build|test)|最小.*(?:运行|构建|测试)|端到端|冒烟)/i.test(planText)) {
      return "Include an early minimal end-to-end probe so the plan proves the critical path before large implementation.";
    }
    if (!items.some((item) => typeof item.contingency === "string" && item.contingency.trim())) {
      return "Give at least one plan item a contingency for a blocked or slow dependency instead of waiting indefinitely.";
    }
    const finalItem = `${items[items.length - 1]?.content ?? ""} ${items[items.length - 1]?.acceptanceCriteria ?? ""}`;
    if (!/(?:verify|test|check|run|validate|验证|测试|检查|运行)/i.test(finalItem)) {
      return "Make the final plan item a concrete verification (test, run, check, or validate).";
    }
  }
  return undefined;
}

function taskPlanRequiredResult(mode: TaskDecompositionMode): ToolResult {
  const detail = mode === "required"
    ? "You may take one read-only baseline action, but must then call todo_write before any further tool execution."
    : "Call todo_write now before continuing tool execution.";
  return {
    success: false,
    output: "",
    failure: operationFailure("TASK_PLAN_REQUIRED", "harness"),
    error:
      `[Task decomposition required] ${detail} ` +
      "Create 3-5 small, ordered, observable tasks: establish the target, run a minimal end-to-end probe, implement the smallest change, and verify it. " +
      "Give each item acceptanceCriteria and give the slowest/riskest item a contingency. Keep exactly one item in_progress and make the final item a concrete verification.",
  };
}

/** Suppress exact repeated reads/searches (and a tiny read-only bash subset)
 * while the workspace is unchanged.
 * Any successful tool that is not explicitly read-only clears the memo. This
 * is deliberately conservative: an unknown shell/process call may mutate a
 * file, so the next read must execute for real. */
export function createRunToolExecutionHooks(
  executor: ToolExecutor,
  onSuppressed: (name: string, args: Record<string, unknown>) => void,
  taskDecomposition: TaskDecompositionMode,
  hasTodoTool: boolean,
): ToolExecutionHooks {
  const completedOrInFlight = new Set<string>();
  // Remote GETs do not depend on the workspace, so a mutation must not forget them.
  const fetchedUrls = new Map<string, number>();
  const planState: TaskPlanGateState = { ready: false, baselineReads: 0 };
  return {
    beforeExecute(name, args) {
      // Planning is not a permission boundary. Only an explicitly required
      // plan may block execution; auto must not turn a short task into retries.
      if (hasTodoTool && taskDecomposition === "required") {
        if (name === "todo_write" && !planState.ready) {
          const planError = initialPlanError(taskDecomposition, args);
          if (planError) {
            return { success: false, output: "", error: `[Task decomposition required] ${planError}`,
              failure: operationFailure("TASK_PLAN_REQUIRED", "harness") };
          }
        } else if (!planState.ready) {
          const readOnly = executor.workspaceGate ? executor.isStaticallyReadOnly(name) : executor.isReadOnly(name, args);
          const allowUnplanned = readOnly && planState.baselineReads++ < 1;
          if (!allowUnplanned) return taskPlanRequiredResult(taskDecomposition);
        }
      }
      // Process calls are never memoized by their output path. Compiler flags,
      // inputs and external state can change without an observed file edit.
      const fetchKey = httpFetchKey(name, args);
      if (fetchKey) {
        const fetchedAt = fetchedUrls.get(fetchKey);
        if (fetchedAt !== undefined && Date.now() - fetchedAt < FETCH_REUSE_WINDOW_MS) {
          onSuppressed(name, args);
          return duplicateSuppression(
            `[Duplicate http_fetch suppressed for ${String(args.url)}. It was already fetched in the last few minutes; ` +
            "reuse that result instead of fetching it again, or fetch a different page.]",
          );
        }
        fetchedUrls.set(fetchKey, Date.now());
        return undefined;
      }
      if (!isDuplicateQuery(name, args)) return undefined;
      const key = duplicateQueryKey(name, args);
      if (completedOrInFlight.has(key)) {
        onSuppressed(name, args);
        const target = primaryArgSig(name, args) || "the same arguments";
        return duplicateSuppression(
          `[Duplicate ${name} suppressed for ${target}. ` +
          "Reuse the previous result; the workspace has not changed since it was returned. " +
          "Choose the next concrete action instead of reading/searching it again.]",
        );
      }
      completedOrInFlight.add(key);
      return undefined;
    },
    afterExecute(name, args, result) {
      const fetchedKey = httpFetchKey(name, args);
      if (fetchedKey) {
        if (!result.success) fetchedUrls.delete(fetchedKey);
        return;
      }
      if (isDuplicateQuery(name, args)) {
        if (!result.success) completedOrInFlight.delete(duplicateQueryKey(name, args));
        return;
      }
      if (name === "todo_write" && result.success) {
        planState.ready = true;
      }
      const readOnly = executor.workspaceGate
        ? !!result.runtime?.effects && isEffectivelyReadOnly(result.runtime.effects)
        : executor.isReadOnly(name, args);
      if (result.success && !readOnly) {
        completedOrInFlight.clear();
      }
    },
  };
}

export function isRepeatFriendlyStep(
  toolCalls: Array<{ name: string }>,
): boolean {
  return toolCalls.length > 0 && toolCalls.every((tc) => REPEAT_FRIENDLY_TOOLS.has(tc.name));
}

/** An unchanged log does not make a freshly observed, owned task stop running.
 * Explicit run budgets still bound waiting; missing/exited tasks get no exemption. */
export function isLiveTaskWait(
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  results: ReadonlyMap<string, ToolResult>,
): boolean {
  return calls.length > 0 && calls.every(call => {
    const result = results.get(call.id);
    const tasks = result?.runtime?.taskObservation?.tasks;
    return call.name === "task_status" && typeof call.arguments.task_id === "string"
      && result?.success === true && tasks?.length === 1
      && tasks[0]!.taskId === call.arguments.task_id && tasks[0]!.status === "running";
  });
}

/** A bounded status poll is not the same thing as a blind retry. The
 * repetition guard may only reset for it when the observed output changed;
 * unchanged polling still reaches the normal repeat limit and asks the model
 * to use its contingency instead of waiting forever. */
export function progressPollSignature(
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  results: ReadonlyMap<string, ToolResult>,
): string | undefined {
  if (toolCalls.length !== 1) return undefined;
  const [call] = toolCalls;
  if (call.name !== "bash" || typeof call.arguments.command !== "string") return undefined;
  const command = call.arguments.command;
  // Intentionally narrow: status-only shell snippets like the Terminal-Bench
  // `sleep; tail log; pgrep` pattern. Redirects other than stderr suppression
  // would make it too easy to disguise a mutation as a poll.
  if (!/\b(?:tail|pgrep|ps)\b/.test(command) || !/\b(?:sleep|tail|pgrep|ps)\b/.test(command)) return undefined;
  if (/(?:^|[^2])>>?/.test(command)) return undefined;
  const result = results.get(call.id);
  if (!result?.success) return undefined;
  return `${command}\n${sliceHeadCodePoints(result.output ?? "", 2_048)}`;
}
