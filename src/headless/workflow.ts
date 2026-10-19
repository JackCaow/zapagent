import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DeferredAcceptanceCoordinator } from "../../zapsdk/runtime/deferred-acceptance.js";
import { SqliteWorkflowControlStore } from "../../zapsdk/runtime/workflow-store.js";
import { workflowExecutionAllowsRelease } from "../../zapsdk/runtime/workflow-control.js";

export const WORKFLOW_HELP = "Usage: zap workflow list|read|wait|cancel --db <sqlite-file> [--id <workflow-id>] [--revision <n>] [--timeout-ms <n>] [--after <id>] [--limit <n>]";

/** Separate control command: never imports provider settings, reads stdin or starts the Agent. */
export async function runWorkflowCommand(argv: readonly string[], output: (text: string) => void = text => { process.stdout.write(text); }): Promise<number> {
  let store: SqliteWorkflowControlStore | undefined;
  try {
    const [command, ...args] = argv;
    if (!["list", "read", "wait", "cancel"].includes(command ?? "")) throw new Error(WORKFLOW_HELP);
    const values = new Map<string, string>();
    const allowed = ["--db", ...(command === "list" ? ["--after", "--limit"] : ["--id"]),
      ...(command === "cancel" ? ["--revision"] : []), ...(command === "wait" ? ["--timeout-ms"] : [])];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!; const value = args[i + 1];
      if (!allowed.includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error(WORKFLOW_HELP);
      values.set(key, value);
    }
    const db = values.get("--db"); const id = values.get("--id");
    if (!db || !existsSync(resolve(db)) || (command !== "list" && !id)) throw new Error("Existing --db and workflow --id are required");
    const number = (key: string, fallback: number) => {
      const raw = values.get(key); const n = raw === undefined ? fallback : Number(raw);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${key}`);
      return n;
    };
    const revision = command === "cancel" ? number("--revision", 0) : 0;
    const timeoutMs = number("--timeout-ms", 30_000);
    if (timeoutMs > 300_000) throw new Error("--timeout-ms must be at most 300000");
    store = new SqliteWorkflowControlStore(resolve(db));
    const coordinator = new DeferredAcceptanceCoordinator(store, []);
    if (command === "list") {
      output(JSON.stringify({ schema: "zap.workflow-list", schemaVersion: 1, records: store.list(values.get("--after"), number("--limit", 100)) }) + "\n");
      return 0;
    }
    if (command === "cancel") coordinator.cancel(id!, revision);
    const state = command === "wait" ? await coordinator.wait(id!, { timeoutMs }) : coordinator.read(id!);
    output(JSON.stringify({ schema: "zap.workflow-control", schemaVersion: 1, ...state }) + "\n");
    if (command !== "wait") return 0;
    if (state.record.cancelled || state.record.outcome.execution.status === "cancelled") return 130;
    if (state.decision.code === "WORKFLOW_DEADLINE_EXCEEDED") return 124;
    return state.record.acceptance.status === "passed" ? workflowExecutionAllowsRelease(state.record) ? 0 : 7 : state.record.acceptance.status === "failed" ? 5
      : state.record.acceptance.status === "error" ? 6 : state.record.acceptance.status === "pending" ? 124 : 7;
  } catch (error) {
    const code = (error as { code?: string }).code ?? "INVALID_PARAMS";
    output(JSON.stringify({ schema: "zap.workflow-error", schemaVersion: 1, code, message: error instanceof Error ? error.message : String(error) }) + "\n");
    return code === "WORKFLOW_WAIT_TIMEOUT" ? 124 : 2;
  } finally { store?.close(); }
}
