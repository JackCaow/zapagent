import { randomUUID } from "node:crypto";
import { localExecutionShell } from "../execution/shell.js";
import { z } from "zod";
import { backgroundTaskLifecycle, describeBackgroundTaskLifecycle } from "../tasks/lifecycle.js";
import type { Tool } from "../tools/types.js";
import type { ExecutionEnvironmentFacts } from "../execution/types.js";
import { zodToJsonSchema } from "../tools/schema.js";
import {
  createLocalProcessBroker,
  terminateProcessTree,
  terminateProcessTreeWithGrace,
} from "../execution/process.js";
import { pathConverter } from "../utils/path.js";
import { matchesAnyCommandPattern, shellCommandDisplay, shellExecutionCommands } from "../utils/shell.js";
import type { TaskStore } from "../tasks/store.js";
import { resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";

export interface ExecuteCommandOptions {
  timeoutMs?: number;
  defaultCwd?: string;
  /** Backend-reported shell for the tool description. Does not select or
   * launch an interpreter; the execution broker owns that decision. */
  executionShell?: string;
  sandboxTemporaryDirectory?: ExecutionEnvironmentFacts["sandboxTemporaryDirectory"];
  /** Inject a shared TaskStore to enable the `run_in_background:true`
   *  flag. When omitted (or when `ZAPCODE_DISABLE_BACKGROUND_TASKS=1` is
   *  set), background fields are stripped from the schema entirely — the
   *  model can't see or use them. Mirrors CCB's `schema.omit` pattern. */
  store?: TaskStore;
  /** Explicit override for tests/embedders. Defaults to the env kill switch. */
  disableBackgroundTasks?: boolean;
  /** Stamped onto background tasks so `taskStore.killByOwner` can clean
   *  them up when this agent (typically a sub-agent) terminates. */
  ownerAgentId?: string;
  /** Whether sandboxed commands may open outbound network connections.
   * Defaults to false; network tools are the brokered egress path. */
  sandboxNetwork?: boolean;
  /** Expose destination declarations for a restricted execution backend. */
  restrictedNetwork?: boolean;
  /** Offer the per-call `dangerouslyDisableSandbox` retry. Defaults to true;
   * hosts set false when a backend (VM) or policy has no sandbox escape. */
  allowUnsandboxed?: boolean;
  /** Command patterns (bash-rule syntax) that always run outside the OS sandbox,
   * for tools that cannot work inside it (browsers, docker). Ignored when
   * allowUnsandboxed is false. Permission still goes through the normal rules. */
  sandboxExcludedCommands?: string[];
  /** @deprecated Package availability is runtime data, not tool policy.
   * Retained for source compatibility; no longer changes the tool prompt. */
  persistentPackageManagement?: boolean;
  /** Trusted, non-secret runtime variables that sandboxed shell children
   * must inherit. The sandbox still removes every other host variable. */
  preserveEnvironment?: string[];
}

/**
 * Parse raw error output into structured diagnostic info.
 * Extracts file, line number, error type, and actionable hint.
 */
function formatError(raw: string, command: string, exitCode?: number | null): string {
  const lines = raw.split("\n").filter((l) => l.trim());

  const fileLineMatch = raw.match(/(?:at\s+)?([^\s:]+\.(?:ts|js|mjs|mts|cjs)):(\d+)/);
  const syntaxMatch = raw.match(/SyntaxError:\s*(.+)/);
  const typeMatch = raw.match(/TypeError:\s*(.+)/);
  const refMatch = raw.match(/ReferenceError:\s*(.+)/);
  const moduleMatch = raw.match(/Cannot find module\s+'([^']+)'/);
  const environmentError = raw.match(/\b[A-Z][A-Z0-9_]*_ERROR\[([A-Z0-9_]+)\]:\s*([^\n]+)/);
  const commandNotFound = raw.match(/(?:command\s+not\s+found|(?:^|:\s)[^:\n]+:\s+not\s+found)/im);
  const workspaceExecutionDenied = /\/workspace\/[^\n]*Permission denied/i.test(raw);

  let diagnostic = `Command failed: ${command}\n`;

  const errorType = environmentError
    ? "EnvironmentError"
    : syntaxMatch
    ? "SyntaxError"
    : typeMatch
      ? "TypeError"
      : refMatch
        ? "ReferenceError"
        : moduleMatch
          ? "ModuleError"
          : "Error";
  const errorMsg = environmentError?.[2] ??
    syntaxMatch?.[1] ?? typeMatch?.[1] ?? refMatch?.[1] ?? moduleMatch?.[1] ?? lines[0];

  const diagnosticCode = environmentError?.[1]
    ?? (commandNotFound ? "COMMAND_NOT_FOUND" : undefined)
    ?? (workspaceExecutionDenied ? "WORKSPACE_EXECUTION_DENIED" : undefined);

  diagnostic += `\nType: ${errorType}`;
  if (diagnosticCode) diagnostic += `\nCode: ${diagnosticCode}`;
  if (exitCode !== undefined && exitCode !== null) diagnostic += `\nExit code: ${exitCode}`;
  diagnostic += `\nMessage: ${errorMsg}`;

  if (fileLineMatch) {
    diagnostic += `\nFile: ${fileLineMatch[1]}`;
    diagnostic += `\nLine: ${fileLineMatch[2]}`;
  }

  if (syntaxMatch) {
    if (raw.includes("Unexpected string")) {
      diagnostic += `\n\nHint: There's likely an unescaped quote inside a string. Use backtick template literals (\`) instead of double quotes, or escape inner quotes with \\.`;
    } else if (raw.includes("Unexpected token")) {
      diagnostic += `\n\nHint: Check the syntax around line ${fileLineMatch?.[2] ?? "?"}. Common causes: missing comma, bracket, or semicolon.`;
    } else if (raw.includes("Cannot use import")) {
      diagnostic += `\n\nHint: Add "type": "module" to package.json, or rename the file to .mjs.`;
    }
  } else if (typeMatch) {
    if (raw.includes("is not a constructor")) {
      diagnostic += `\n\nHint: The default export may not be a constructor. Try: const X = mod.default ?? mod; new X()`;
    } else if (raw.includes("is not a function")) {
      diagnostic += `\n\nHint: Check the import — the function may be a named export, not default.`;
    }
  } else if (moduleMatch) {
    diagnostic += `\n\nHint: Run "npm install ${moduleMatch[1]}" to install the missing module.`;
  }

  const relevantLines = lines
    .filter((l) => !l.includes("at ") || l.includes(fileLineMatch?.[1] ?? "__none__"))
    .slice(0, 12);

  diagnostic += `\n\nRelevant output:\n${relevantLines.join("\n")}`;

  return diagnostic;
}

export function executeCommandTool(options: ExecuteCommandOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? 120_000;
  /** Longest a single foreground call may ask for. Past this, use run_in_background. */
  const MAX_TIMEOUT_MS = 600_000;
  const callTimeoutMs = (args: Record<string, unknown>): number => {
    const asked = (args as { timeout_ms?: unknown }).timeout_ms;
    return typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(Math.max(Math.round(asked), 1_000), Math.max(MAX_TIMEOUT_MS, timeoutMs))
      : timeoutMs;
  };
  const maxBuffer = 10 * 1024 * 1024; // 10 MB

  // Background mode is opt-in per registry. Disabled when no store is
  // wired in (subagent registries don't get one) or when the user sets
  // `ZAPCODE_DISABLE_BACKGROUND_TASKS=1` to nuke the feature entirely.
  const disableBackgroundTasks =
    options.disableBackgroundTasks ?? process.env.ZAPCODE_DISABLE_BACKGROUND_TASKS === "1";
  const supportsBackground =
    !!options.store && !disableBackgroundTasks;

  const baseSchema = z.object({
    command: z.string().optional().describe("Shell command (or use check_steps)"),
    check_steps: z.array(z.string().min(1)).min(1).max(32).optional()
      .describe("Self-checks without command. Fresh shells at cwd; stop on nonzero. Inner pipelines keep shell semantics."),
    cwd: z.string().optional().describe("Initial directory"),
    timeout_ms: z.number().int().min(1000).max(600_000).optional()
      .describe("Foreground timeout (ms)"),
  });

  const timeoutSeconds = Math.round(timeoutMs / 1000);

  // When background is enabled we extend the schema; when not, the fields
  // never appear in the JSON Schema the model sees — same effect as CCB's
  // `.omit({ run_in_background: true })`.
  const inputSchema = baseSchema.extend({
      ...(supportsBackground ? {
        run_in_background: z
          .boolean()
          .optional()
          .describe(
            "For >30s commands. Returns taskId/outputFile; <task-notification> on exit. Do not poll.",
          ),
        description: z
          .string()
          .optional()
          .describe(
            "Optional short label for a background task",
          ),
      } : {}),
      ...(options.allowUnsandboxed !== false ? {
        dangerouslyDisableSandbox: z
          .boolean()
          .optional()
          .describe(
            "Request approved access outside the sandbox; explain the required resource.",
          ),
      } : {}),
      ...(options.restrictedNetwork ? {
        network_destinations: z
          .array(z.string().min(1))
          .max(128)
          .optional()
          .describe("Exact HTTP(S) URLs, domains, or wildcard subdomains requested by this command; subject to the execution backend's network policy"),
      } : {}),
    });

  const schema = inputSchema.superRefine((args, ctx) => {
    if (args.command === undefined && !args.check_steps) {
      ctx.addIssue({ code: "custom", message: "command or check_steps is required" });
    }
    if (args.check_steps && (args.run_in_background === true
      || (args.command !== undefined && args.command !== shellCommandDisplay({ check_steps: args.check_steps })))) {
      ctx.addIssue({ code: "custom", message: "check_steps requires foreground execution and command matching the complete parenthesized step list when provided" });
    }
  }).overwrite(args => ({ ...args, command: args.command ?? shellCommandDisplay(args) }));
  // Keep an object schema for embedders. Parsing supplies the canonical command
  // before policy, approval, argument hashing and execution see the call.
  const rawSchema = {
    ...zodToJsonSchema(inputSchema),
    anyOf: [{ required: ["command"] }, { required: ["check_steps"] }],
  };

  const baseDescription =
    `Run in ${JSON.stringify(options.executionShell ?? localExecutionShell().executable)}; returns stdout/stderr.`;
  const timeoutNote = ` Foreground timeout: ${timeoutSeconds}s; raise with timeout_ms.`;
  let description = supportsBackground
    ? `${baseDescription}${timeoutNote} Background >30s: run_in_background; check lifecycle.`
    : `${baseDescription}${timeoutNote}`;
  if (options.restrictedNetwork) {
    description += " Declare required destinations in network_destinations; the execution backend enforces its network policy.";
  }

  const promptLines = supportsBackground
    ? [
        "## bash execution mode",
        "",
        `Foreground has a ${timeoutSeconds}s timeout (timeout_ms raises it to 600s); on timeout, stops the command and returns bounded partial output.`,
        "",
        "- Foreground: quick reads, status checks, one-file tests, and short commands.",
        "- Background: installs, full builds/tests, dev servers, watchers, large clones, containers, and migrations.",
        "No sleep/ps polling. Exit sends a <task-notification>. For logs, use task_status: task_id with include_output=true (tail) or output_offset=0 (pages). outputFile grants no read_file access. Wait only for dependencies.",
      ]
    : [];
  if (options.restrictedNetwork) {
    promptLines.push(
      "",
      "network_destinations declares requested egress, not a guarantee of access. The runtime may apply a narrower policy or a shared environment allowlist. Execution errors report the observed outcome.",
    );
  }
  promptLines.push(
    "",
    "Exit 0 reports final shell status only. Inspect stderr for warnings or masked failures; do not auto-replay side effects. Chain dependencies with &&. Pipelines report the last stage: check stages or use supported pipefail. Use check_steps for independent checks; each uses a fresh shell and stops on nonzero.",
  );
  if (options.sandboxTemporaryDirectory) {
    promptLines.push(
      `Local sandbox: expand ${options.sandboxTemporaryDirectory.environmentVariables.join(", ")} for a private writable scratch directory; avoid hard-coded /tmp or disposable project files.`,
      "Create and consume scratch files in one command; cleanup happens on exit. Neither separate Bash calls nor check_steps entries share this directory. Unsandboxed commands differ.",
    );
  }
  const prompt = promptLines.length > 0 ? promptLines.join("\n") : undefined;

  // An explicit approved escape, or a command the user listed as incompatible
  // with the sandbox (sandboxExcludedCommands).
  const runsUnsandboxed = (args: Record<string, unknown>): boolean => options.allowUnsandboxed !== false
    && ((args as { dangerouslyDisableSandbox?: boolean }).dangerouslyDisableSandbox === true
      || shellExecutionCommands(args).some((command) => matchesAnyCommandPattern(command, options.sandboxExcludedCommands)));

  return {
    definition: {
      name: "bash",
      checkpointTracking: "unsupported",
      ...(supportsBackground ? { backgroundTaskStoreId: options.store!.instanceId } : {}),
      description,
      prompt,
      parameters: schema,
      rawSchema,
      permission: "confirm",
      sandboxAware: true,
      executionLocation: "workspace",
      resolveShellCommands: shellExecutionCommands,
      resolveTimeoutMs: (args) => callTimeoutMs(args) + 5_000,
      resolveEffects: (args, context) => {
        const cwd = resolveToolPathCanonical(
          (args.cwd as string | undefined) ?? options.defaultCwd ?? context.cwd,
          options.defaultCwd ?? context.cwd,
        );
        const declaredDestinations = options.restrictedNetwork
          && Array.isArray((args as { network_destinations?: unknown }).network_destinations)
          ? ((args as { network_destinations: string[] }).network_destinations)
          : [];
        return {
          filesystem: [
            { kind: "filesystem", operation: "read", paths: [cwd] },
            { kind: "filesystem", operation: "modify", paths: [cwd] },
          ],
          network: declaredDestinations.length > 0
            ? [{ kind: "network", operation: "connect", destinations: declaredDestinations, methods: [] }]
            : options.sandboxNetwork === true
              ? [{ kind: "network", operation: "connect", destinations: ["*"], methods: [] }]
              : [],
          process: [{
            kind: "process",
            operation: "spawn",
            commandClass: "shell",
            background: (args as { run_in_background?: boolean }).run_in_background === true,
            ...(runsUnsandboxed(args) ? { unsandboxed: true } : {}),
          }],
          external: [],
          workspace: { mode: "root-integration" },
          confidence: "declared",
        };
      },
    },
    handler: async (args, signal, context) => {
      // Direct SDK callers must use the same validation as ToolExecutor.
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { success: false, output: "", error: `Invalid arguments: ${parsed.error.message}` };
      args = parsed.data;
      const runInBackground =
        supportsBackground && (args as { run_in_background?: boolean }).run_in_background === true;

      let command = args.command as string;
      const checkSteps = args.check_steps as string[] | undefined;
      if (checkSteps && (runInBackground || command !== checkSteps.map((step) => `(${step})`).join(" && "))) {
        return { success: false, output: "", error: "check_steps requires foreground execution and command matching the complete parenthesized step list" };
      }
      let cwd = (args.cwd as string | undefined) ?? options.defaultCwd;

      // Keep shell commands intact. Extracting a leading cd changes quoting,
      // expansion and relative-path semantics, and can override the cwd that
      // was used for authorization. The shell owns directory changes within
      // a command; args.cwd owns its initial working directory.

      // Cross-platform: sanitize /dev/null -> NUL on Windows
      command = pathConverter.sanitizeDevNull(command);

      if (cwd) cwd = resolveToolPath(cwd, options.defaultCwd ?? process.cwd());

      if (runInBackground && options.store) {
        try {
          const snap = options.store.spawnShell({
            command,
            cwd,
            description: (args as { description?: string }).description,
            ownerAgentId: options.ownerAgentId,
            sessionId: context?.sessionId,
            process: context?.process,
            preserveEnvironment: options.preserveEnvironment,
            maxOutputBytes: context?.limits?.maxBackgroundOutputBytes,
            resources: context?.resources,
          });
          const lifecycle = backgroundTaskLifecycle(context?.backgroundTaskOwner, options.store.instanceId);
          return {
            success: true,
            output: JSON.stringify(
              {
                taskId: snap.taskId,
                outputFile: snap.outputFile,
                pid: snap.pid,
                description: snap.description,
                status: "running",
                lifecycle,
                lifecycleHint: describeBackgroundTaskLifecycle(lifecycle),
                hint: "Continue independent work. You will be notified on completion. Use task_status with task_id and include_output=true for recent output, or output_offset=0 for log pages; outputFile does not grant read_file access.",
              },
              null,
              2,
            ),
          };
        } catch (err) {
          return {
            success: false,
            output: "",
            error: `Failed to start background task: ${(err as Error).message}`,
          };
        }
      }

      const processBroker = context?.process ?? createLocalProcessBroker(signal);
      const commandRef = context?.executionId ?? randomUUID();
      const outputs: string[] = [];
      const observedSteps: Array<{ command: string; exitCode: number | null }> = [];
      let outcome: CommandOutcome | undefined;
      let checkedCommand = command;
      let pendingStep: string | undefined;
      let stderrPresent = false;
      try {
        const callTimeout = callTimeoutMs(args);
        const deadline = Date.now() + callTimeout;
        let outputBytes = 0;
        for (const step of checkSteps ?? [command]) {
          pendingStep = step;
          // A later launch exception has no exit code. Never reuse the last
          // completed step's successful status as the outcome of this attempt.
          outcome = undefined;
          checkedCommand = pathConverter.sanitizeDevNull(step);
          const child = processBroker.spawnShell(checkedCommand, {
            cwd: cwd ?? options.defaultCwd ?? process.cwd(),
            preserveEnvironment: options.preserveEnvironment,
          });
          outcome = await captureCommand(child, signal, Math.max(1, deadline - Date.now()), Math.max(1, maxBuffer - outputBytes));
          observedSteps.push({ command: step, exitCode: outcome.code });
          pendingStep = undefined;
          stderrPresent ||= outcome.stderr.trim().length > 0;
          // Do not bury diagnostics below stdout when a later shell command
          // masks an earlier error. Stderr alone is not a nonzero exit code.
          const output = (outcome.code === 0 && outcome.stderr.trim()
            ? ["[stderr]", outcome.stderr, ...(outcome.stdout ? ["[stdout]", outcome.stdout] : [])]
            : [outcome.stdout, outcome.stderr]).filter(Boolean).join("\n");
          outputBytes += Buffer.byteLength(output);
          if (checkSteps) outputs.push(`[Check ${observedSteps.length}/${checkSteps.length}: exit ${outcome.code ?? "unknown"}]\n${output}`);
          else outputs.push(output);
          if (outcome.code !== 0 || outcome.spawnError || outcome.aborted || outcome.timedOut || outcome.outputExceeded) break;
          if (Date.now() >= deadline || signal?.aborted) break;
        }
        if (!outcome) throw new Error("No command was executed");
        const combined = outputs.join("\n");
        const runtime = {
          command: { commandRef,
            ...(outcome.code === null ? {} : { exitCode: outcome.code }),
            ...(stderrPresent ? { stderrPresent: true } : {}),
            timedOut: outcome.timedOut, aborted: outcome.aborted },
          ...(checkSteps ? { verification: {
            passed: observedSteps.length === checkSteps.length && outcome.code === 0
              && !outcome.spawnError && !outcome.aborted && !outcome.timedOut && !outcome.outputExceeded,
            steps: observedSteps,
          } } : {}),
        };
        if (outcome.aborted) {
          return { success: false, output: combined, error: "aborted", runtime };
        }
        if (outcome.timedOut) {
          const diagnostics = outcome.stderr.trim();
          return {
            runtime,
            success: false,
            output: combined,
            error: diagnostics
              ? `Command timed out after ${callTimeout}ms\n${diagnostics}`
              : `Command timed out after ${callTimeout}ms`,
          };
        }
        if (outcome.outputExceeded) {
          return {
            runtime,
            success: false,
            output: combined,
            error: `Command output exceeded ${maxBuffer} bytes`,
          };
        }
        // A command name cannot explain the final shell status: a successful
        // grep may precede a failed check. Preserve the observed nonzero code;
        // callers can explicitly handle expected statuses in their command.
        if (outcome.spawnError || outcome.code !== 0) {
          const rawError = outcome.stderr || outcome.spawnError?.message || `Process exited with code ${outcome.code}`;
          return {
            runtime,
            success: false,
            // The summary below is lossy; retain both channels for model
            // feedback and recoverable storage, including trailing errors.
            output: combined,
            error: formatError(rawError, checkedCommand, outcome.code)
              + (processBroker.sandboxedSpawnCount > 0 && options.allowUnsandboxed !== false
                ? sandboxBlockHint() : ""),
          };
        }
        if (checkSteps && !runtime.verification?.passed) {
          return { success: false, output: combined, error: "Checks did not all complete within the foreground deadline", runtime };
        }
        return { success: true, output: stderrPresent
          ? "[Shell exited 0 with stderr; earlier commands may have failed. Inspect diagnostics before treating the operation as successful.]\n" + combined
          : combined, runtime };
      } catch (error) {
        return {
          success: false,
          output: outputs.join("\n"),
          error: formatError(error instanceof Error ? error.message : String(error), checkedCommand),
          runtime: {
            command: { commandRef, timedOut: outcome?.timedOut ?? false,
              aborted: signal?.aborted === true || outcome?.aborted === true
                || (error instanceof Error && (error.name === "AbortError" || error.message === "aborted")) },
            ...(checkSteps ? { verification: { passed: false,
              steps: [...observedSteps, ...(pendingStep === undefined ? [] : [{ command: pendingStep, exitCode: null }])],
            } } : {}),
          },
        };
      }
    },
  };
}

/** Explain the boundary without treating a generic process error as evidence
 * that the sandbox must be bypassed. */
function sandboxBlockHint(): string {
  return "\n\nThis command ran inside the OS sandbox. This error alone does not establish a sandbox denial. "
    + "Check the original error, path permissions and declared readable inputs first. "
    + "If access outside the sandbox is necessary, explain the exact resource and request approval with dangerouslyDisableSandbox: true. "
    + "Do not retry outside the sandbox merely because a command failed.";
}

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
  aborted: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
}

function captureCommand(
  child: import("node:child_process").ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxBuffer: number,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let aborted = signal?.aborted === true;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    const onAbort = () => { aborted = true; };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const append = (target: "stdout" | "stderr", chunk: string) => {
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(target === "stdout" ? stdout : stderr, "utf8") > maxBuffer) {
        outputExceeded = true;
        terminateProcessTree(child, "SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
    child.once("error", (error) => { spawnError = error; });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTreeWithGrace(child);
    }, timeoutMs);
    timeout.unref();
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, spawnError, aborted, timedOut, outputExceeded });
    });
  });
}
