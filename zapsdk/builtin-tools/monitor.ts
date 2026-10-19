import { z } from "zod";
import { backgroundTaskLifecycle, describeBackgroundTaskLifecycle } from "../tasks/lifecycle.js";
import type { Tool } from "../tools/types.js";
import { TaskStore } from "../tasks/store.js";
import type { TaskSnapshot } from "../tasks/types.js";

/** Public shape of a tracked task. Kept as an alias of TaskSnapshot for
 *  call-site stability — existing consumers import `MonitorTask` directly. */
export type MonitorTask = TaskSnapshot;

export interface MonitorToolOptions {
  /** Override the directory where log files are written. Only used when
   *  `store` is not supplied. Defaults to TaskStore's own default
   *  (`<getAppDataDir()>/projects/<project-id>/tasks/outputs`). */
  outputDir?: string;
  /** Project cwd used to derive TaskStore's default output directory when
   *  `store` and `outputDir` are not supplied. */
  projectCwd?: string;
  /** Inject a shared TaskStore so monitor / bash bg / task_* tools all
   *  see the same task registry. When omitted, monitor creates its own
   *  isolated store (back-compat for callers that don't wire one). */
  store?: TaskStore;
  /** Whether the OS-sandboxed monitor may access the network. Defaults false. */
  sandboxNetwork?: boolean;
}

export interface MonitorToolHandle {
  tool: Tool;
  /** Read-only view of tasks spawned through this tool. Delegates to the
   *  underlying TaskStore. */
  snapshot: () => MonitorTask[];
  /** Look up a task by id. */
  get: (taskId: string) => MonitorTask | undefined;
  /** Kill every still-running child and close streams. Safe to call
   *  multiple times. */
  stopAll: (signal?: NodeJS.Signals) => void;
}

/** Thin wrapper around TaskStore that exposes a model-facing tool for
 *  starting streaming/watch processes. Output is appended to a log file
 *  a shared TaskStore can expose through task_status. Use this when intent is "tail
 *  this thing" — for fire-and-check-later style work, `bash` with
 *  `run_in_background: true` is more idiomatic and shares the same store. */
export function monitorTool(options: MonitorToolOptions = {}): MonitorToolHandle {
  const defaultCwd = options.projectCwd ?? process.cwd();
  const store = options.store ?? new TaskStore({
    outputDir: options.outputDir,
    projectCwd: options.projectCwd,
  });
  const outputGuidance = options.store
    ? "Use task_status with task_id and include_output=true for recent output, or output_offset=0 for log pages. outputFile does not grant read_file access. "
    : "The host owns access to captured logs; outputFile does not grant read_file permission. ";

  const tool: Tool = {
    definition: {
      name: "monitor",
      backgroundTaskStoreId: store.instanceId,
      description:
        "Spawn a managed background command; returned lifecycle describes its lifetime. Returns {taskId, outputFile, pid} immediately. " +
        outputGuidance +
        "Use for streaming/watch commands (tail -f, log followers, dev servers). Do NOT use for interactive commands — they will hang.",
      parameters: z.object({
        command: z.string().min(1).describe("Shell command to run in the background"),
        description: z.string().min(1).describe("Short label describing what this monitor is watching"),
      }),
      permission: "confirm",
      sandboxAware: true,
      executionLocation: "host",
      resolveShellCommands: args => [String(args.command ?? "")],
      resolveEffects: () => ({
        filesystem: [
          { kind: "filesystem", operation: "read", paths: [defaultCwd] },
          { kind: "filesystem", operation: "modify", paths: [defaultCwd] },
        ],
        network: options.sandboxNetwork === true
          ? [{ kind: "network", operation: "connect", destinations: ["*"], methods: [] }]
          : [],
        process: [{
          kind: "process",
          operation: "spawn",
          commandClass: "shell",
          background: true,
        }],
        external: [],
        workspace: { mode: "root-integration" },
        confidence: "declared",
      }),
    },
    handler: async (args, _signal, context) => {
      try {
        const snap = store.spawnShell({
          command: args.command as string,
          description: args.description as string,
          cwd: defaultCwd,
          process: context?.process,
          maxOutputBytes: context?.limits?.maxBackgroundOutputBytes,
          resources: context?.resources,
        });
        const lifecycle = backgroundTaskLifecycle(context?.backgroundTaskOwner, store.instanceId);
        return {
          success: true,
          output: JSON.stringify(
            {
              taskId: snap.taskId,
              outputFile: snap.outputFile,
              pid: snap.pid,
              description: snap.description,
              lifecycle,
              lifecycleHint: describeBackgroundTaskLifecycle(lifecycle),
              hint: outputGuidance.trim(),
            },
            null,
            2,
          ),
        };
      } catch (err) {
        return {
          success: false,
          output: "",
          error: (err as Error).message,
        };
      }
    },
  };

  return {
    tool,
    snapshot: () => store.list(),
    get: (id) => store.get(id),
    stopAll: (signal) => store.stopAll(signal),
  };
}
