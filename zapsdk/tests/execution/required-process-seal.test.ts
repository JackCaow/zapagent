import { describe, expect, it } from "bun:test";
import { requireProcessSealing } from "../../execution/required-process-seal.js";
import type { ExecutionBroker, ExecutionBrokerRequest } from "../../execution/types.js";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { TransparentExecutionBroker } from "../../execution/zapvm.js";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { makeGoalMachineToolReadOnly } from "../../../src/headless/goalPhase.js";
import { goalTreeHash } from "../../goal/workspace.js";

function request(): ExecutionBrokerRequest {
  return { executionId: "exec-1", name: "bash", tool: { definition: { executionLocation: "workspace" } },
    effects: { process: [{ kind: "process" }] } } as unknown as ExecutionBrokerRequest;
}

describe("Host process sealing gate", () => {
  it("derives a read-only machine tool without changing its original definition", () => {
    const original = executeCommandTool({ defaultCwd: process.cwd() });
    const effects = original.definition.resolveEffects;
    const readonly = makeGoalMachineToolReadOnly(original);
    expect(readonly).not.toBe(original);
    expect(original.definition.resolveEffects).toBe(effects);
    expect(readonly.definition.resolveEffects).not.toBe(effects);
  });
  it("refuses an unsupported backend before it can execute a command", async () => {
    let started = 0;
    const broker = requireProcessSealing({ sandboxStatus: () => ({ provider: "macos-seatbelt", available: true }),
      async execute() { started++; return { success: true, output: "" }; } });
    const result = await broker.execute(request());
    expect(result.success).toBe(false);
    expect(result.failure?.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(started).toBe(0);
  });

  it("rejects missing and mismatched receipts, and accepts only a bound receipt", async () => {
    let seal: unknown;
    const inner: ExecutionBroker = { sandboxStatus: () => ({ provider: "zapvm", available: true }),
      supportsProcessSeal: () => true,
      async execute(req) {
        expect(req.requireProcessSeal).toBe(true);
        return { success: true, output: "ok", runtime: { processSeal: seal as any } };
      } };
    const broker = requireProcessSealing(inner);
    expect((await broker.execute(request())).success).toBe(false);
    seal = { state: "sealed", executionId: "other" };
    expect((await broker.execute(request())).success).toBe(false);
    seal = { state: "sealed", executionId: "exec-1" };
    expect((await broker.execute(request())).success).toBe(true);
  });

  it("reports an unconfirmed receipt to the host even if the caller handles the failure", async () => {
    let tainted = false;
    const inner: ExecutionBroker = { sandboxStatus: () => ({ provider: "zapvm", available: true }),
      supportsProcessSeal: () => true, async execute() { return { success: false, output: "", error: "connection lost" }; } };
    const broker = requireProcessSealing(inner, () => { tainted = true; });
    expect((await broker.execute(request())).success).toBe(false);
    // A model can continue and claim completion; the host must retain taint.
    expect(tainted).toBe(true);
  });

  for (const mode of ["valid", "missing", "wrong-id", "bad-exit", "guest-failure", "readonly", "readonly-existing"]) {
    it(`binds VM process receipt and actual exit status: ${mode}`, async () => {
      if (process.platform === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "goal-seal-test-"));
      try {
        const bin = join(root, "fake-zapvm");
        const script = [
          "#!/bin/sh", "request=; session=; result=; readonly=",
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in --request-id) request="$2"; shift 2;; --session-id) session="$2"; shift 2;; --result-file) result="$2"; shift 2;; --workspace-read-only) readonly=yes; shift;; *) shift;; esac',
          "done",
          ...(mode.startsWith("readonly") ? ['[ "$readonly" = yes ] || exit 93'] : []),
          ...(mode === "missing" ? [] : [
            ...(mode === "wrong-id" ? ['request="wrong"'] : []),
            `printf '{"request_id":"%s","session_id":"%s","exit_code":${mode === "bad-exit" || mode === "guest-failure" ? 7 : 0},"seal":{"mechanism":"cgroup-v2","state":"empty"}}' "$request" "$session" > "$result"`,
          ]),
          `exit ${mode === "guest-failure" ? 7 : 0}`,
        ].join("\n");
        writeFileSync(bin, script); chmodSync(bin, 0o755);
        if (mode === "readonly-existing") {
          mkdirSync(join(root, ".zapcode")); writeFileSync(join(root, ".zapcode", "user.txt"), "preserve me");
        }
        const before = mode.startsWith("readonly") ? await goalTreeHash(root) : "";
        const registry = new ToolRegistry(); const tool = executeCommandTool({ defaultCwd: root });
        registry.register(mode.startsWith("readonly") ? makeGoalMachineToolReadOnly(tool) : tool);
        const runtime = { endpoint: "fixture", installation: { runtimeRoot: root, binaryPath: bin, imageRoot: root, publicKeyPath: root, stateRoot: root }, async ensureReady() {} };
        const selected = new TransparentExecutionBroker({ local: new DefaultExecutionBroker(), runtime });
        const executor = new ToolExecutor(registry, { cwd: root, onApproval: async () => true, executionBroker: requireProcessSealing(selected) });
        const result = await executor.execute("bash", { command: "ignored" });
        if (mode === "valid" || mode.startsWith("readonly")) {
          expect(result.success).toBe(true); expect(result.runtime?.processSeal?.state).toBe("sealed");
          if (mode.startsWith("readonly")) expect(await goalTreeHash(root)).toBe(before);
        } else if (mode === "guest-failure") {
          expect(result.success).toBe(false); expect(result.runtime?.processSeal?.state).toBe("sealed");
          expect(result.runtime?.command?.exitCode).toBe(7);
        } else {
          expect(result.success).toBe(false); expect(result.runtime?.processSeal).toBeUndefined();
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});
