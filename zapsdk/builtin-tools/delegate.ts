import { z } from "zod";
import { currentRuntimeObservation, observeRuntime } from "../runtime/observation.js";
import { existsSync, mkdirSync, lstatSync, symlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool, ToolResult } from "../tools/types.js";
import type { AgentEventHandler } from "../agent/events.js";
import type { DetectedProvider } from "./delegate-detect.js";
import {
  makeParserCtx,
  parseClaudeLine,
  parseCodexLine,
  type ParserCtx,
} from "./delegate-stream.js";
import {
  gitStatusSnapshot,
  diffSnapshots,
  formatChangeSummary,
} from "./delegate-changes.js";
import { integrationGitWriteRoots } from "../execution/workspace-runtime.js";
import { resolveToolPath, resolveToolPathCanonical } from "./filesystem.js";
import { createLocalProcessBroker, terminateProcessTreeWithGrace } from "../execution/process.js";

export interface DelegateAgentOptions {
  providers: DetectedProvider[];
  onEvent?: AgentEventHandler;
  defaultCwd?: string;
  /** Override for tests; default 1_200_000 (20 min). */
  timeoutMs?: number;
  /** Private persistent CLI state; separate from host credentials/settings. */
  stateDir?: string;
}

const TASK_MAX_CHARS = 100_000;
const STDERR_TAIL_BYTES = 4 * 1024;
const STDERR_BUF_CAP = 64 * 1024;
const SIGTERM_GRACE_MS = 3000;

/** Build the argv to pass to the external CLI. Pure function — kept out of
 *  the handler so unit tests don't need spawn. Resume semantics differ:
 *  - claude:  `--resume <id> -p <task>`  (flag-based on the same `claude -p` invocation)
 *  - codex:   `exec resume <id> <task>`  (subcommand changes from `exec` to `exec resume <id>`) */
export function buildCliArgs(
  provider: "claude" | "codex",
  task: string,
  resumeId?: string,
): string[] {
  if (provider === "claude") {
    const args = ["--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
    if (resumeId) args.push("--resume", resumeId);
    args.push("-p", task);
    return args;
  }
  // Codex must preserve the broker environment: login profiles reset PATH and
  // bypass the sandbox toolchain shims (notably Apple git/xcrun).
  if (resumeId) {
    return ["exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "--config", "allow_login_shell=false", "--json", resumeId, task];
  }
  return ["exec", "--dangerously-bypass-approvals-and-sandbox", "--config", "allow_login_shell=false", "--json", task];
}

function buildDescription(providers: DetectedProvider[]): string {
  const names = providers.map((p) => p.name);
  const provLine = names.join(" | ");
  const claudeBlurb = names.includes("claude")
    ? "`claude` suits planning and large multi-file refactors."
    : "";
  const codexBlurb = names.includes("codex")
    ? "`codex` suits algorithmic and code-focused tasks."
    : "";

  return [
    `Delegate a complex coding task to an installed external CLI (${provLine}) running autonomously.`,
    "Use for multi-file work likely to need more than 10 tool calls; use `agent` for read-only investigation and work directly for small edits.",
    claudeBlurb,
    codexBlurb,
    "Returns a final report, git change summary, and resumable session id.",
    "Sandbox temp is per-call; save reusable files in cwd.",
  ].filter(Boolean).join(" ");
}

export function delegateAgentTool(opts: DelegateAgentOptions): Tool | null {
  if (!opts.providers || opts.providers.length === 0) return null;

  const providerNames = opts.providers.map((p) => p.name) as ["claude" | "codex", ...Array<"claude" | "codex">];
  const providerByName = new Map(opts.providers.map((p) => [p.name, p]));
  const timeoutMs = opts.timeoutMs ?? 1_200_000;

  return {
    definition: {
      name: "delegate_agent",
      checkpointTracking: "unsupported",
      description: buildDescription(opts.providers),
      parameters: z.object({
        provider: z.enum(providerNames),
        task: z.string().describe(
          "Goal, known context, and expected deliverable. For a resumed session, provide only the follow-up instruction.",
        ),
        cwd: z.string().optional().describe("Working directory. Defaults to zap's cwd."),
        resume_session_id: z.string().optional().describe(
          "Session id from a prior `Session resumable` result. The provider must match the original call.",
        ),
      }),
      permission: "confirm",
      timeoutMs: timeoutMs + 30_000,
      sandboxAware: true,
      executionLocation: "host",
      resolveEffects: (args, context) => {
        const cwd = resolveToolPathCanonical(
          (args.cwd as string | undefined) ?? opts.defaultCwd ?? context.cwd,
          opts.defaultCwd ?? context.cwd,
        );
        const provider = String(args.provider) as "claude" | "codex";
        const keychain = macKeychainPaths();
        return {
          filesystem: [
            { kind: "filesystem", operation: "read", paths: [cwd] },
            ...integrationGitWriteRoots(cwd).map(path => ({ kind: "filesystem" as const, operation: "modify" as const, paths: [path] })),
            ...delegateCredentialPaths(provider).map((path) => ({
              kind: "filesystem" as const,
              operation: "read" as const,
              paths: [path],
            })),
            ...(keychain ? [
              { kind: "filesystem" as const, operation: "read" as const, paths: keychain.read },
              { kind: "filesystem" as const, operation: "modify" as const, paths: [keychain.lock] },
            ] : []),
            { kind: "filesystem", operation: "modify", paths: [cwd] },
            { kind: "filesystem" as const, operation: "modify" as const,
              paths: [delegateStateDirectory(provider, cwd, opts.stateDir)] },
          ],
          network: [{ kind: "network", operation: "connect", destinations: ["*"], methods: [] }],
          process: [{
            kind: "process",
            operation: "spawn",
            commandClass: "external-cli",
            background: false,
          }],
          external: [],
          workspace: { mode: "root-integration" },
          confidence: "declared",
        };
      },
    },
    handler: async (args, signal, context): Promise<ToolResult> => {
      const provider = String(args.provider) as "claude" | "codex";
      const task = String(args.task ?? "");
      const cwd = resolveToolPath(
        (args.cwd as string | undefined) ?? opts.defaultCwd ?? process.cwd(),
        opts.defaultCwd ?? process.cwd(),
      );

      const detected = providerByName.get(provider);
      if (!detected) {
        return {
          success: false,
          output: "",
          error: `Provider ${provider} is not available on this machine.`,
        };
      }
      if (task.length > TASK_MAX_CHARS) {
        return {
          success: false,
          output: "",
          error: `Task is too long (${task.length} chars > ${TASK_MAX_CHARS}). Externalize via files in cwd and reference them in a shorter brief.`,
        };
      }

      const resumeId = (args.resume_session_id as string | undefined)?.trim() || undefined;
      const cliArgs = buildCliArgs(provider, task, resumeId);

      const subagentId = `da_${provider}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const ctx: ParserCtx = makeParserCtx(subagentId, []);
      const observation = currentRuntimeObservation();
      const observeExternal = (phase: "starting" | "running" | "failed" | "cancelled" | "exited", exitCode?: number) => {
        if (observation) observeRuntime({ kind: "external_run", scope: observation.scope, childRunId: subagentId,
          toolCallId: context?.toolCallId, step: context?.step, phase, at: Date.now(), exitCode }, observation);
      };
      const parseLine = provider === "claude" ? parseClaudeLine : parseCodexLine;

      const processBroker = context?.process ?? createLocalProcessBroker(signal);
      const before = await gitStatusSnapshot(cwd, processBroker);
      // Cancellation may arrive while the asynchronous workspace snapshot runs.
      if (signal?.aborted) return { success: false, output: "", error: "aborted" };

      let environment: Record<string, string>;
      {
        const stateDir = delegateStateDirectory(provider, resolveToolPathCanonical(cwd, cwd), opts.stateDir);
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const state = lstatSync(stateDir);
        if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0) {
          return { success: false, output: "", error: "Delegate state must be a private directory (0700)." };
        }
        environment = provider === "claude" ? {
          CLAUDE_CONFIG_DIR: stateDir,
          // Keep the login/keychain namespace, but never make host settings or
          // credentials writable. Session/debug/cache writes use private state.
          // Empty selects Claude's default credential/keychain namespace;
          // a nonempty path hashes into a different, unauthenticated namespace.
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
        } : { CODEX_HOME: stateDir };
        if (provider === "codex") {
          const host = codexHome();
          for (const name of ["auth.json", "config.toml"]) {
            const source = join(host, name), target = join(stateDir, name);
            if (existsSync(source)) {
              try { lstatSync(target); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                symlinkSync(realpathSync(source), target);
              }
            }
          }
        }
      }

      observeExternal("starting");
      let child: ReturnType<typeof processBroker.spawnCommand>;
      try { child = processBroker.spawnCommand(detected.bin, cliArgs, {
        cwd,
        hostHome: true,
        networkDomains: provider === "claude"
          ? ["api.anthropic.com", "console.anthropic.com", "claude.ai", "*.claude.ai"]
          : ["chatgpt.com", "*.chatgpt.com", "api.openai.com", "auth.openai.com", "*.oaiusercontent.com"],
        environment,
        temporaryDirectoryEnvironment: provider === "claude" ? ["CLAUDE_CODE_TMPDIR"] : undefined,
        preserveEnvironment: provider === "claude"
          ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
          : ["OPENAI_API_KEY", "CODEX_API_KEY"],
      }); } catch (error) { observeExternal("failed"); throw error; }
      observeExternal("running");

      let stdoutBuf = "";
      let stderrBuf = "";
      let eventCount = 0;
      let aborted = false;
      let timedOut = false;

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const evs = parseLine(line, ctx);
            if (observation && !evs.length) observeRuntime({ kind: "external_unknown", scope: {
              ...observation.scope, runId: subagentId, parentRunId: observation.scope.runId } }, observation);
            for (const ev of evs) {
              eventCount += 1;
              if (observation) observeRuntime({ kind: "external_event", scope: { ...observation.scope,
                runId: subagentId, parentRunId: observation.scope.runId }, event: ev }, observation);
              opts.onEvent?.(ev);
            }
          } catch {
            // parser must not throw; if it does, swallow and keep stream alive
          }
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        stderrBuf = (stderrBuf + chunk).slice(-STDERR_BUF_CAP);
      });

      let processClosed = false;
      const onAbort = () => {
        if (processClosed) return;
        aborted = true;
        terminateProcessTreeWithGrace(child, SIGTERM_GRACE_MS);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutHandle = setTimeout(() => {
        if (processClosed) return;
        timedOut = true;
        terminateProcessTreeWithGrace(child, SIGTERM_GRACE_MS);
      }, timeoutMs);
      timeoutHandle.unref();

      const startedAt = Date.now();
      const exitInfo = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, sig) => {
          processClosed = true;
          clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          resolve({ code: code ?? null, sig: sig ?? null });
        });
        child.on("error", () => {
          clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          resolve({ code: null, sig: null });
        });
      });

      observeExternal(aborted ? "cancelled" : timedOut || exitInfo.code !== 0 ? "failed" : "exited", exitInfo.code ?? undefined);
      const durationMs = Date.now() - startedAt;
      const after = await gitStatusSnapshot(cwd, processBroker);
      const changes = diffSnapshots(before, after);

      // Defensive: emit sub_agent_finished if the parser never did
      // (e.g. stream cut mid-flight, missing terminal "result"/"task_complete" line).
      if (!ctx.finishedEmitted) {
        opts.onEvent?.({
          type: "sub_agent_finished",
          subagentId,
          agentType: provider,
          success: exitInfo.code === 0 && !aborted && !timedOut,
          path: [],
        });
      }

      const stderrTail = stderrBuf.slice(-STDERR_TAIL_BYTES);
      const meta = {
        provider,
        bin: detected.bin,
        durationMs,
        exitCode: exitInfo.code,
        signal: exitInfo.sig,
        events: eventCount,
        changes,
        sessionId: ctx.sessionId,
        resumed: !!resumeId,
      };

      // The "Session resumable" hint goes into `output` (which the LLM sees)
      // — not just `meta` — because ToolResult.meta is consumed by UI/telemetry,
      // not fed back to the LLM. Without surfacing the id in `output`, the
      // main agent has no way to learn what id to pass back next call.
      const sessionLine = ctx.sessionId
        ? `\n\n_Session resumable: pass \`resume_session_id="${ctx.sessionId}"\` (provider="${provider}") in your next delegate_agent call to continue this session._`
          + (processBroker.sandboxedSpawnCount > 0 ? "\n_Sandbox temporary files were cleaned up at CLI exit; session resume does not restore TMPDIR files. Save reusable artifacts in cwd._" : "")
        : "";

      if (aborted) {
        return { success: false, output: ctx.finalText, error: "aborted", meta };
      }
      if (timedOut) {
        return {
          success: false,
          output: ctx.finalText,
          error: `${provider} timed out after ${Math.round(timeoutMs / 1000)}s. Partial output above (if any).`,
          meta,
        };
      }
      if (exitInfo.code !== 0) {
        return {
          success: false,
          output: "",
          error: `${provider} exited with code ${exitInfo.code}. ${ctx.error ? `${ctx.error}\n` : ""}stderr (last ${STDERR_TAIL_BYTES}B):\n${stderrTail}`,
          meta,
        };
      }

      const summary = changes ? formatChangeSummary(provider, cwd, changes) : "";
      const hasChanges = !!summary;

      if (ctx.finalText && hasChanges) {
        return { success: true, output: `${ctx.finalText}\n\n---\n${summary}${sessionLine}`, meta };
      }
      if (ctx.finalText) {
        return { success: true, output: `${ctx.finalText}${sessionLine}`, meta };
      }
      if (hasChanges) {
        return {
          success: true,
          output: `_(External CLI did not produce a final summary)_\n\n---\n${summary}${sessionLine}`,
          meta,
        };
      }
      return {
        success: false,
        output: "",
        error: `${provider} finished cleanly but produced no output and no file changes.`,
        meta,
      };
    },
  };
}

function delegateStateDirectory(provider: "claude" | "codex", cwd: string, stateDir?: string): string {
  const root = stateDir ?? join(process.env.ZAPCODE_DATA_DIR || join(homedir(), ".zapcode"), "delegates");
  const workspaceId = createHash("sha256").update(resolveToolPathCanonical(cwd, cwd)).digest("hex").slice(0, 24);
  const target = resolve(root, provider, workspaceId);
  // Do not canonicalize an existing state symlink into a new host write grant.
  for (const path of [resolve(root), resolve(root, provider), target]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
        throw new Error("Delegate state must be a private directory (0700).");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolveToolPathCanonical(target, process.cwd());
}

/** Security.framework reads its per-user MDS cache and locks mds.lock even
 * for keychain reads. Grant only the existing cache/lock, never keychain writes. */
function macKeychainPaths(): { read: string[]; lock: string } | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const cache = execFileSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8", timeout: 1000 }).trim();
    const mds = join(cache, "mds");
    const lock = join(mds, "mds.lock");
    if (!existsSync(lock)) return undefined;
    return { read: [join(homedir(), "Library", "Keychains"), mds], lock };
  } catch { return undefined; }
}

function delegateCredentialPaths(provider: "claude" | "codex"): string[] {
  const home = homedir();
  const candidates = provider === "claude"
    ? [join(home, ".claude"), join(home, ".claude.json"), join(home, ".config", "claude")]
    : [codexHome(), join(home, ".config", "codex")];
  return candidates.filter(existsSync);
}

function codexHome(): string { return process.env.CODEX_HOME || join(homedir(), ".codex"); }
