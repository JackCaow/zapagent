import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const sandbox = createPlatformSandbox();
const available = process.platform !== "win32" && sandbox.status().available;

(available ? describe : describe.skip)("sandbox command scratch space (POSIX)", () => {
  it("supports bare mktemp without granting the host temporary directory", async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "zap-mktemp-test-")));
    try {
      const root = join(fixture, "workspace");
      mkdirSync(root);
      const registry = new ToolRegistry();
      registry.register(executeCommandTool({ defaultCwd: root, timeoutMs: 10_000 }));
      const executor = new ToolExecutor(registry, {
        cwd: root, onApproval: async () => true,
        executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }),
      });
      const result = await executor.execute("bash", {
        command: 'set -eu; path=$(mktemp -d); case "$path" in "$TMPDIR"/*) ;; *) exit 1 ;; esac; printf ok > "$path/file"; cat "$path/file"; printf "\\n%s" "$path"',
      });
      expect(result.success).toBe(true);
      expect(result.runtime?.broker?.sandboxEnforced).toBe(true);
      expect(result.output.split("\n")[0]).toBe("ok");
      expect(existsSync(result.output.split("\n")[1]!)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("allows scratch writes, removes them on exit, and warns on masked outside-write failures", async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "zap-scratch-test-")));
    try {
      const root = join(fixture, "workspace");
      mkdirSync(root);
      const registry = new ToolRegistry();
      registry.register(executeCommandTool({ defaultCwd: root, timeoutMs: 10_000 }));
      const executor = new ToolExecutor(registry, {
        cwd: root, onApproval: async () => true,
        executionBroker: new DefaultExecutionBroker({ sandbox, sandboxMode: "required" }),
      });
      const scratch = await executor.execute("bash", {
        command: 'test "$TMPDIR" = "$TMP" && test "$TMPDIR" = "$TEMP" && printf scratch > "$TMPDIR/input" && cat "$TMPDIR/input" && printf "\\n%s" "$TMPDIR"',
      });
      expect(scratch.success).toBe(true);
      expect(scratch.runtime?.broker?.sandboxEnforced).toBe(true);
      expect(scratch.output.split("\n")[0]).toBe("scratch");
      const firstDirectory = scratch.output.split("\n")[1]!;
      expect(firstDirectory.length).toBeGreaterThan(0);
      expect(existsSync(firstDirectory)).toBe(false);

      const second = await executor.execute("bash", { command: 'printf "%s" "$TMPDIR"' });
      expect(second.success).toBe(true);
      expect(second.output).not.toBe(firstDirectory);
      expect(existsSync(second.output)).toBe(false);

      // Same failure shape as the reported command: denied setup, then a
      // successful final pipeline that masks the missing intermediate file.
      const outside = join(fixture, "outside");
      const quoted = `'${outside.replace(/'/g, `'"'"'`)}'`;
      const masked = await executor.execute("bash", {
        command: `mkdir -p ${quoted} && printf data > ${quoted}/input\ncat ${quoted}/input | wc -l`,
      });
      expect(masked.runtime?.broker?.sandboxEnforced).toBe(true);
      expect(masked.runtime?.command).toMatchObject({ exitCode: 0, stderrPresent: true, timedOut: false, aborted: false });
      expect(masked.output.startsWith("[Shell exited 0 with stderr;")).toBe(true);
      expect(masked.output).toContain("[stderr]");
      expect(masked.output).toContain("[stdout]");
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
