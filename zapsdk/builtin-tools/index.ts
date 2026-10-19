import { ToolRegistry } from "../tools/registry.js";
import {
  readFileTool,
  writeFileTool,
  deleteFileTool,
  moveFileTool,
  type ReadFileOptions,
  type WriteFileOptions,
  type DeleteFileOptions,
  type MoveFileOptions,
} from "./filesystem.js";
import { editFileTool, type EditFileOptions } from "./edit.js";
import { multiEditTool, type MultiEditOptions } from "./multi-edit.js";
import { listTreeTool, type ListTreeOptions } from "./list-tree.js";
import { executeCommandTool, type ExecuteCommandOptions } from "./command.js";
import { httpFetchTool, httpRequestTool, type HttpFetchOptions } from "./http.js";
import { searchFilesTool, type SearchFilesOptions } from "./search.js";
import { globFilesTool, type GlobFilesOptions } from "./glob.js";
import { webSearchTool, type WebSearchOptions } from "./web-search.js";
import { currentTimeTool } from "./time.js";
import { readDocumentTool, readPdfTool, readDocxTool, type DocumentReadOptions } from "./document.js";
import { todoWriteTool, type TodoWriteToolOptions, type TodoStore, type Todo, type TodoStatus } from "./todo.js";
import { askUserQuestionTool, type AskUserToolOptions } from "./ask-user.js";
import { browserScreenshotTool, type BrowserScreenshotOptions } from "./browser.js";
import { enterPlanModeTool, exitPlanModeTool, type PlanModeToolsOptions, type PlanModeCallbacks } from "./plan-mode.js";
import { skillTool, type SkillToolOptions } from "./skill.js";
import type { CronToolsHandle } from "./cron.js";
import type { MonitorToolHandle } from "./monitor.js";
import { taskStatusTool, taskStopTool, type TaskToolsOptions } from "./task.js";
import { delegateAgentTool } from "./delegate.js";
import type { DetectedProvider } from "./delegate-detect.js";
import type { AgentEventHandler } from "../agent/events.js";

export { readFileTool, writeFileTool, deleteFileTool, moveFileTool } from "./filesystem.js";
export { editFileTool } from "./edit.js";
export { multiEditTool, type MultiEditOptions } from "./multi-edit.js";
export { listTreeTool, type ListTreeOptions } from "./list-tree.js";
export { buildDiffMeta, buildUnifiedDiff, filetypeFromPath, isProbablyText, type DiffMeta } from "./diff-meta.js";
export { executeCommandTool } from "./command.js";
export { httpFetchTool, httpRequestTool, assertSafePublicHttpUrl } from "./http.js";
export { searchFilesTool } from "./search.js";
export { globFilesTool } from "./glob.js";
export { matchGlob } from "./glob-util.js";
export {
  webSearchTool,
  createKeylessWebSearch,
  createSerpApiSearch,
  createSerperSearch,
  createBraveSearch,
  WebSearchBlockedError,
  type CurlRunner,
  type KeylessSearchOptions,
  type SearchResult,
  type SearchFunction,
  type WebSearchOptions,
} from "./web-search.js";
export { currentTimeTool } from "./time.js";
export { readDocumentTool, readPdfTool, readDocxTool, type DocumentReadOptions } from "./document.js";
export { todoWriteTool, renderTodoList, type TodoWriteToolOptions, type TodoStore, type Todo, type TodoStatus } from "./todo.js";
export { enterPlanModeTool, exitPlanModeTool, type PlanModeToolsOptions, type PlanModeCallbacks } from "./plan-mode.js";
export { askUserQuestionTool, type AskUserToolOptions, type AskUserCallbacks, type AskUserQuestion, type AskUserAnswer } from "./ask-user.js";
export { browserScreenshotTool, findBrowser, type BrowserScreenshotOptions } from "./browser.js";
export { skillTool, type SkillToolOptions } from "./skill.js";
export {
  cronTools,
  type CronToolsOptions,
  type CronToolsHandle,
  type CronJob,
  type CronFireEvent,
} from "./cron.js";
export {
  monitorTool,
  type MonitorToolOptions,
  type MonitorToolHandle,
  type MonitorTask,
} from "./monitor.js";
export { taskStatusTool, taskStopTool, type TaskToolsOptions } from "./task.js";

export { subagentTool, type SubagentToolOptions } from "./subagent.js";

export { delegateAgentTool, type DelegateAgentOptions } from "./delegate.js";
export { detectProviders, type DetectedProvider } from "./delegate-detect.js";
export { memoryMergeTool, memoryReviewTool, memorySaveTool, type MemoryMergeToolOptions, type MemoryReviewToolOptions, type MemorySaveToolOptions } from "./memory.js";

export interface BuiltinToolsOptions {
  readFile?: ReadFileOptions;
  writeFile?: WriteFileOptions;
  editFile?: EditFileOptions;
  multiEdit?: MultiEditOptions;
  deleteFile?: DeleteFileOptions;
  moveFile?: MoveFileOptions;
  executeCommand?: ExecuteCommandOptions;
  httpFetch?: HttpFetchOptions;
  httpRequest?: HttpFetchOptions;
  searchFiles?: SearchFilesOptions;
  globFiles?: GlobFilesOptions;
  listTree?: ListTreeOptions;
  documentRead?: DocumentReadOptions;
  browserScreenshot?: BrowserScreenshotOptions;
  webSearch?: WebSearchOptions;
  /** Required for the main agent to get `todo_write`. When omitted (e.g.
   *  subagent registries), `todo_write` is not registered — mirrors CCB's
   *  "todos are main-agent-only" choice. */
  todoWrite?: TodoWriteToolOptions;
  /** Required for the main agent to get `enter_plan_mode` / `exit_plan_mode`.
   *  Omit to skip registration (subagent registries don't manage plan mode). */
  planMode?: PlanModeToolsOptions;
  /** Main agent in an interactive UI only. Omit (headless, subagents) to leave
   *  `ask_user_question` unregistered: nobody is there to answer. */
  askUser?: AskUserToolOptions;
  /** Required for the main agent to get the `skill` tool for loading
   *  named skills at runtime. Subagent registries typically don't get it —
   *  skill invocation is a main-agent concern. */
  skill?: SkillToolOptions;
  /** Caller-owned cron handle. When absent, `cron_create` / `cron_delete` /
   *  `cron_list` are NOT registered — mirrors how `todo_write` requires a
   *  store. Create with `cronTools({ onFire, agentId })` in the app layer
   *  so the app owns the job map, the scheduler, and the shutdown path. */
  cronHandle?: CronToolsHandle;
  /** Caller-owned monitor handle. When absent, `monitor` is NOT registered.
   *  Create with `monitorTool()` in the app layer so the app owns the
   *  process registry and can call `stopAll()` on shutdown. */
  monitorHandle?: MonitorToolHandle;
  /** Shared background-task registry. Registers controlled status/stop tools
   * alongside bash's `run_in_background` support. */
  taskTools?: TaskToolsOptions;
  /** Caller-owned external-CLI delegate handle. Pass detected providers from
   *  the app layer so `createBuiltinRegistry` stays sync; absent / empty
   *  providers list means delegate_agent is NOT registered. */
  delegateAgent?: {
    providers: DetectedProvider[];
    onEvent?: AgentEventHandler;
    timeoutMs?: number;
    stateDir?: string;
  };
  exclude?: string[];
}

export function createBuiltinRegistry(options: BuiltinToolsOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const exclude = new Set(options.exclude ?? []);
  const defaultCwd = options.executeCommand?.defaultCwd;

  if (!exclude.has("read_file")) registry.register(readFileTool({ defaultCwd, ...options.readFile }));
  if (!exclude.has("write_file")) registry.register(writeFileTool({ defaultCwd, ...options.writeFile }));
  if (!exclude.has("edit_file")) registry.register(editFileTool({ defaultCwd, ...options.editFile }));
  if (!exclude.has("multi_edit")) registry.register(multiEditTool({ defaultCwd, ...options.multiEdit }));
  if (!exclude.has("delete_file")) registry.register(deleteFileTool({ defaultCwd, ...options.deleteFile }));
  if (!exclude.has("move_file")) registry.register(moveFileTool({ defaultCwd, ...options.moveFile }));
  if (!exclude.has("list_tree")) registry.register(listTreeTool({ defaultCwd, ...options.listTree }));
  if (!exclude.has("bash")) registry.register(executeCommandTool(options.executeCommand));
  if (!exclude.has("http_fetch")) registry.register(httpFetchTool(options.httpFetch));
  if (!exclude.has("http_request")) registry.register(httpRequestTool(options.httpRequest));
  if (!exclude.has("search_files")) registry.register(searchFilesTool({ defaultCwd, ...options.searchFiles }));
  if (!exclude.has("glob_files")) registry.register(globFilesTool({ defaultCwd, ...options.globFiles }));
  if (!exclude.has("web_search")) registry.register(webSearchTool(options.webSearch));
  if (!exclude.has("current_time")) registry.register(currentTimeTool());
  if (!exclude.has("browser_screenshot")) registry.register(browserScreenshotTool({ defaultCwd, ...options.browserScreenshot }));
  if (!exclude.has("read_document")) registry.register(readDocumentTool({ defaultCwd, ...options.documentRead }));
  if (options.todoWrite && !exclude.has("todo_write")) {
    registry.register(todoWriteTool(options.todoWrite));
  }
  if (options.planMode) {
    if (!exclude.has("enter_plan_mode")) registry.register(enterPlanModeTool(options.planMode));
    if (!exclude.has("exit_plan_mode")) registry.register(exitPlanModeTool(options.planMode));
  }
  if (options.askUser && !exclude.has("ask_user_question")) registry.register(askUserQuestionTool(options.askUser));
  if (options.skill && !exclude.has("skill")) {
    registry.register(skillTool(options.skill));
  }

  if (options.cronHandle) {
    if (!exclude.has("cron_create")) registry.register(options.cronHandle.cronCreate);
    if (!exclude.has("cron_delete")) registry.register(options.cronHandle.cronDelete);
    if (!exclude.has("cron_list")) registry.register(options.cronHandle.cronList);
  }

  if (options.monitorHandle && !exclude.has("monitor")) {
    registry.register(options.monitorHandle.tool);
  }

  if (options.taskTools) {
    if (!exclude.has("task_status")) registry.register(taskStatusTool(options.taskTools));
    if (!exclude.has("task_stop")) registry.register(taskStopTool(options.taskTools));
  }

  if (options.delegateAgent && !exclude.has("delegate_agent")) {
    const tool = delegateAgentTool({
      providers: options.delegateAgent.providers,
      onEvent: options.delegateAgent.onEvent,
      defaultCwd: options.executeCommand?.defaultCwd,
      timeoutMs: options.delegateAgent.timeoutMs,
      stateDir: options.delegateAgent.stateDir,
    });
    if (tool) registry.register(tool);
  }

  return registry;
}
