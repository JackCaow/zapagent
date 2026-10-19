import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const platformProvider = createPlatformSandbox({ trace: process.platform === "win32" });
const status = platformProvider.status();
const describePlatformSandbox = (
  (process.platform === "linux" || process.platform === "win32") && status.available
) ? describe : describe.skip;

describePlatformSandbox(`${status.provider} acceptance`, () => {
  test("allows workspace writes and denies outside reads and writes", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "zap-platform-sandbox-"));
    cleanup.push(fixture);
    const root = join(fixture, "workspace");
    const outsideWrite = join(fixture, "outside.txt");
    const outsideSecret = join(fixture, "secret.txt");
    mkdirSync(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".zapcode"));
    writeFileSync(outsideSecret, "sandbox-secret");
    writeFileSync(join(root, ".git", "config"), "git-original");
    writeFileSync(join(root, ".zapcode", "settings.json"), "zap-original");

    const registry = new ToolRegistry();
    registry.register(executeCommandTool({
      defaultCwd: root,
      sandboxNetwork: false,
      timeoutMs: 10_000,
    }));
    const executor = new ToolExecutor(registry, {
      cwd: root,
      onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({
        sandbox: platformProvider,
        sandboxMode: "required",
      }),
    });
    const allowedCommand = process.platform === "win32"
      ? "echo allowed>inside.txt"
      : "printf allowed > inside.txt";
    const writeCommand = process.platform === "win32"
      ? `echo denied>${shellQuote(outsideWrite)}`
      : `printf denied > ${shellQuote(outsideWrite)}`;
    const readCommand = process.platform === "win32"
      ? `type ${shellQuote(outsideSecret)}`
      : `cat ${shellQuote(outsideSecret)}`;

    // The first Windows launch includes PowerShell/.NET startup and compiling
    // the cached launcher. This is an isolation test, not a cold-start latency
    // gate; subsequent commands retain the ten-second execution limit.
    const coldStartAt = performance.now();
    const allowed = await executor.execute("bash", {
      command: allowedCommand,
      ...(process.platform === "win32" ? { timeout_ms: 30_000 } : {}),
    });
    if (process.platform === "win32") {
      console.info(`[sandbox-acceptance] cold workspace command: ${Math.round(performance.now() - coldStartAt)}ms`);
    }
    const deniedWrite = await executor.execute("bash", { command: writeCommand });
    const deniedRead = await executor.execute("bash", { command: readCommand });
    const gitWriteCommand = process.platform === "win32"
      ? "echo hacked>.git\\config"
      : "printf hacked > .git/config";
    const zapWriteCommand = process.platform === "win32"
      ? "echo hacked>.zapcode\\settings.json"
      : "printf hacked > .zapcode/settings.json";
    const deniedGitWrite = await executor.execute("bash", { command: gitWriteCommand });
    const deniedZapWrite = await executor.execute("bash", { command: zapWriteCommand });
    const server = createServer((_request, response) => response.end("reachable-with-network"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const networkCommand = process.platform === "win32"
      ? `curl.exe --connect-timeout 2 --max-time 3 -fsS http://127.0.0.1:${port}`
      : `curl --connect-timeout 2 --max-time 3 -fsS http://127.0.0.1:${port}`;
    const deniedNetwork = await executor.execute("bash", { command: networkCommand });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (!allowed.success) {
      throw new Error(`inside write failed through ${status.provider}: ${allowed.error ?? allowed.output}`);
    }
    if (deniedGitWrite.success) {
      throw new Error([
        "protected .git write unexpectedly reported success",
        `content=${JSON.stringify(readFileSync(join(root, ".git", "config"), "utf8"))}`,
        `output=${JSON.stringify(deniedGitWrite.output)}`,
        `error=${JSON.stringify(deniedGitWrite.error)}`,
      ].join("\n"));
    }
    expect(allowed.success).toBe(true);
    // A killed bootstrap/child is not evidence that the sandbox denied access.
    for (const result of [allowed, deniedWrite, deniedRead, deniedGitWrite, deniedZapWrite, deniedNetwork]) {
      expect(result.runtime?.command?.timedOut).toBe(false);
      expect(result.runtime?.command?.aborted).toBe(false);
    }
    expect(readFileSync(join(root, "inside.txt"), "utf8").trim()).toBe("allowed");
    expect(deniedWrite.success).toBe(false);
    expect(existsSync(outsideWrite)).toBe(false);
    expect(deniedRead.success).toBe(false);
    expect(deniedRead.output).not.toContain("sandbox-secret");
    expect(deniedZapWrite.success).toBe(false);
    expect(deniedNetwork.success).toBe(false);
    expect(deniedNetwork.output).not.toContain("reachable-with-network");
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("git-original");
    expect(readFileSync(join(root, ".zapcode", "settings.json"), "utf8")).toBe("zap-original");
    expect(allowed.runtime?.broker?.sandbox).toBe(status.provider);
    expect(allowed.runtime?.broker?.sandboxEnforced).toBe(true);
  }, 90_000);
});

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}
