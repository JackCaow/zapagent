import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destructiveShellRisk } from "../../zapsdk/utils/destructive-shell.js";
import { matchDangerousToolCall } from "../../zapsdk/utils/safety.js";

// Classification only. Never remove or modify a real device in these tests.
const context = {
  cwd: "/workspace", workspaceRoot: "/workspace",
  syntax: "posix", pathResolution: "lexical",
} as const;

describe("device namespace removal", () => {
  for (const command of [
    "rm -f /dev/null",
    "rm -- /dev/zero /dev/random",
    "unlink /dev/urandom",
    "cd /dev && rm -f null",
    "cd /dev; unlink zero",
    "env LC_ALL=C /bin/rm -f '/dev/null'",
    "timeout 1 unlink /dev/tty",
    "sh -c 'cd /dev && rm -f null'",
    "rm -f /dev/n*",
    "echo ok; rm -f /dev/../dev/null; echo finished",
  ]) {
    it(`recognizes ${command}`, () => {
      expect(destructiveShellRisk(command, context)).toBe("device_removal");
      expect(matchDangerousToolCall({ command }, "/host/project", "/host/project", {
        syntax: "posix", filesystem: "workspace-mapped", workspaceRoot: "/workspace",
      })?.id).toBe("device_removal");
    });
  }

  for (const command of [
    "rm -f output.log 2>/dev/null",
    "rm -f output.log < /dev/null",
    "cat /dev/null",
    "echo 'rm -f /dev/null'",
    "printf '%s' 'unlink /dev/null'",
    "rm -f /workspace/dev/null",
    "unlink /tmp/output.log",
  ]) {
    it(`preserves ordinary use: ${command}`, () => {
      expect(destructiveShellRisk(command, context)).toBeNull();
    });
  }

  it("does not make device removal safe when the workspace is root", () => {
    expect(destructiveShellRisk("rm -f /dev/null", { ...context, workspaceRoot: "/" }))
      .toBe("device_removal");
  });

  (process.platform === "win32" ? it.skip : it)("resolves parent links but does not dereference the removed entry", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-device-policy-"));
    try {
      symlinkSync("/dev", join(root, "devices"));
      symlinkSync("/dev/null", join(root, "output-link"));
      const local = { cwd: root, workspaceRoot: root, syntax: "posix" } as const;
      expect(destructiveShellRisk("rm -f devices/null", local)).toBe("device_removal");
      expect(destructiveShellRisk("rm -f output-link", local)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
