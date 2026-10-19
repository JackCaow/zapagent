#!/usr/bin/env bun
// Real-provider integration fixture; never reads Terminal-Bench tests or scores.
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../zapsdk/core/providers/openai-compatible.js";
import { declaredMutationEffects } from "../zapsdk/builtin-tools/filesystem.js";
import { ToolRegistry } from "../zapsdk/tools/registry.js";
import { ToolExecutor } from "../zapsdk/tools/executor.js";
import { runWithBoundedRepair } from "../zapsdk/runtime/bounded-repair.js";
import { FileBytesSnapshotProvider, FileSizeVerifier } from "../zapsdk/runtime/file-acceptance.js";
import { JsonAcceptanceStore } from "../zapsdk/runtime/acceptance-store.js";
import { JsonRuntimeStateStore } from "../zapsdk/runtime/state-store.js";

const { ZAP_REPAIR_API_KEY: apiKey, ZAP_REPAIR_BASE_URL: baseURL, ZAP_REPAIR_MODEL: model } = process.env;
if (!apiKey || !baseURL || !model) throw new Error("Set ZAP_REPAIR_API_KEY, ZAP_REPAIR_BASE_URL and ZAP_REPAIR_MODEL");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--inject-size-fault")) throw new Error("Only --inject-size-fault is supported");
const injectFault = args.includes("--inject-size-fault");
const root = await mkdtemp(join(tmpdir(), "zap-public-repair-"));
const file = join(root, "result.json");
const registry = new ToolRegistry();
registry.register({ definition: { name: "write_result", description: "Write the complete result.json file", parameters: z.object({ content: z.string() }), permission: "auto",
  writesPath: () => [file], resolveEffects: () => declaredMutationEffects([file]) },
  async handler(args) { await writeFile(file, args.content as string); return { success: true, output: "result.json written" }; } });
registry.register({ definition: { name: "read_result", description: "Read result.json to inspect or self-check it", parameters: z.object({}), readOnly: true, permission: "auto" },
  async handler() { return { success: true, output: await readFile(file, "utf8") }; } });
let injected = false;
const result = await runWithBoundedRepair('Write result.json containing valid JSON with "ok": true and a nonempty string "message". Use at most 64 UTF-8 bytes.', {
  runtime: { threadId: "public-repair-fixture", workspace: { root }, subagent: false,
    stateStore: new JsonRuntimeStateStore({ directory: join(root, "runtime-state") }),
    loopAgent: { provider: new OpenAICompatibleProvider({ apiKey, baseURL, model, maxTokens: 1024 }), registry,
      executor: new ToolExecutor(registry, { cwd: root }), maxSteps: 10, storageProjectCwd: root,
      systemPrompt: "Complete the task using the provided file tools. Check public requirements before reporting completion." },
    async onRunEnd() {
      if (injectFault && !injected) {
        // Explicit fault injection after attempt 1: preserve valid JSON while
        // making the file exceed the public size constraint.
        await appendFile(file, " ".repeat(256));
        injected = true;
      }
    },
  },
  acceptance: { mode: "required", timing: "inline", timeoutMs: 5000,
    spec: { id: "public-json", revision: 1, subjects: [{ id: "file", path: "result.json", expected: "exists" }], checks: [
      { id: "size", verifierId: "file-size-v1", subjectIds: ["file"] }, { id: "content", verifierId: "public-json-v1", subjectIds: ["file"] },
    ] }, snapshotProvider: new FileBytesSnapshotProvider(root), store: new JsonAcceptanceStore(join(root, "acceptance")),
    verifiers: [new FileSizeVerifier([{ checkId: "size", subjectId: "file", maxBytes: 64 }]), {
      id: "public-json-v1", async verify({ outcome, spec, snapshot, signal }) {
        let passed = false;
        try { const value = JSON.parse(new TextDecoder().decode(await snapshot.readFile("file", signal)));
          passed = value?.ok === true && typeof value?.message === "string" && value.message.length > 0;
        } catch { signal.throwIfAborted(); }
        return [{ checkId: "content", attemptId: outcome.attemptId, specId: spec.id, specRevision: spec.revision,
          snapshotId: snapshot.id, dependencies: snapshot.subjects, status: passed ? "passed" : "failed",
          code: passed ? "JSON_OK" : "JSON_REQUIREMENTS_FAILED", evidenceRefs: [] }];
      },
    }],
  },
  repair: { maxAttempts: 2, publicChecks: [
    { checkId: "size", instruction: "result.json must contain at most 64 UTF-8 bytes", repairableCodes: ["FILE_TOO_LARGE"] },
    { checkId: "content", instruction: 'result.json must be valid JSON with "ok": true and a nonempty string "message"', repairableCodes: ["JSON_REQUIREMENTS_FAILED"] },
  ] },
  budget: { modelCalls: 16, toolCalls: 12, timeoutMs: 180_000 },
});
await writeFile(join(root, "result-report.json"), JSON.stringify({ model, faultInjected: injected, ...result }, null, 2));
console.log(JSON.stringify({ root, model, faultInjected: injected, status: result.status, code: result.code,
  attempts: result.attempts.map(item => ({ attemptId: item.outcome.attemptId, turnId: item.outcome.turnId,
    execution: item.outcome.execution.status, acceptance: item.acceptance.report.status,
    checks: item.acceptance.report.checks.map(check => ({ checkId: check.checkId, status: check.status, evidenceRefs: check.evidenceRefs })) })), usage: result.usage }, null, 2));
process.exitCode = result.status === "passed" ? 0 : 1;
