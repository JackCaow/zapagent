import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import { readOnlyBashTool, validateReadOnlyBash } from "../../builtin-tools/subagent.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

// POSIX shell commands; Windows AppContainer has its own acceptance suite.
const describeSandbox = process.platform !== "win32" && createPlatformSandbox().status().available ? describe : describe.skip;

// The verifier's shell validator is only defense in depth. These commands are
// run directly against the OS sandbox, without the validator, to prove the
// read-only effects of the verifier shell alone keep the workspace unchanged.
describeSandbox("read-only verifier shell inside the OS sandbox (real execution)", () => {
  function run(root: string, command: string): string {
    const effects = readOnlyBashTool(root).definition.resolveEffects!({ command }, { cwd: root, toolName: "bash" });
    expect(effects.workspace.mode).toBe("shared-readonly");
    expect(effects.filesystem.every((effect) => effect.operation === "read")).toBe(true);
    const context = createPlatformSandbox().createContext({ executionId: "verifier", workspace: { root, mode: "shared-readonly" }, effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 120_000) });
    const prepared = context.prepareShell(command, { cwd: root });
    try {
      const result = spawnSync(prepared.executable, prepared.args, { env: prepared.env, cwd: root, encoding: "utf8", timeout: 60_000 });
      return `${result.stdout}${result.stderr}`;
    } finally { prepared.release(); }
  }

  test("reads succeed while every write to the workspace is refused", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-sandbox-readonly-")));
    cleanup.push(root);
    writeFileSync(join(root, "report.txt"), "b\na\n");
    expect(run(root, "cat report.txt")).toContain("b\na");
    run(root, [
      "printf x > forbidden.txt",
      "printf x >> report.txt",
      "sort -o sorted.txt report.txt",
      "touch touched.txt",
      "mkdir made",
      "mv report.txt moved.txt",
      "rm -f report.txt",
    ].map((command) => `(${command}) 2>/dev/null`).join("; "));
    expect(readdirSync(root)).toEqual(["report.txt"]);
    expect(readFileSync(join(root, "report.txt"), "utf8")).toBe("b\na\n");
  });

  test("host secrets in the runtime environment do not reach the verifier shell", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-sandbox-readonly-env-")));
    cleanup.push(root);
    const command = "echo probe:$ZAP_VERIFIER_SECRET_PROBE:$ANTHROPIC_API_KEY:end";
    // The validator allows plain variable expansion; only the sandbox environment protects it.
    expect(validateReadOnlyBash(command)).toBeNull();
    const previous = process.env.ZAP_VERIFIER_SECRET_PROBE;
    process.env.ZAP_VERIFIER_SECRET_PROBE = "host-secret";
    try {
      expect(run(root, command).trim()).toBe("probe:::end");
    } finally {
      if (previous === undefined) delete process.env.ZAP_VERIFIER_SECRET_PROBE; else process.env.ZAP_VERIFIER_SECRET_PROBE = previous;
    }
  });
});
