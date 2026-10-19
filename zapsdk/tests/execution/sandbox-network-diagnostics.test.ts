import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { NetworkProxy } from "../../execution/network-proxy.js";
import { createPlatformSandbox, type PlatformSandboxOptions } from "../../execution/sandbox.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

const native = process.platform === "darwin" && createPlatformSandbox().status().available;
(native ? describe : describe.skip)("sandbox network evidence (real macOS)", () => {
  function executor(root: string, networkProxy: PlatformSandboxOptions["networkProxy"]) {
    const registry = new ToolRegistry();
    registry.register(executeCommandTool({ defaultCwd: root, sandboxNetwork: true, timeoutMs: 10_000 }));
    return new ToolExecutor(registry, { cwd: root, onApproval: async () => true,
      executionBroker: new DefaultExecutionBroker({ sandboxMode: "required", sandbox: createPlatformSandbox({ networkProxy }) }) });
  }
  it("adapts Node fetch, attributes concurrent refusals separately, and keeps the real exit code", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-network-evidence-")));
    // Exercise the proxy against a local origin without external DNS/network.
    const origin = createServer((_req, res) => res.end("origin-ok"));
    origin.listen(0, "127.0.0.1");
    const port = (origin.address() as { port: number }).port;
    const allowed = new NetworkProxy(() => ({ allowedDomains: [] }));
    const denied = new NetworkProxy(() => ({ allowedDomains: [], deniedDomains: ["127.0.0.1"] }));
    const url = `http://127.0.0.1:${port}/`;
    const command = `node -e 'process.env.no_proxy=process.env.NO_PROXY="";fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(console.log).catch(()=>{process.exitCode=7})'`;
    try {
      const ok = await executor(root, allowed).execute("bash", { command });
      expect(ok).toMatchObject({ success: true, output: "origin-ok\n" });
      const shell = executor(root, denied);
      const [blocked, clean] = await Promise.all([
        shell.execute("bash", { command }),
        shell.execute("bash", { command: "printf independent" }),
      ]);
      expect(blocked).toMatchObject({ success: false, failure: { code: "SANDBOX_DENIED", source: "backend", missingCapabilities: ["network:127.0.0.1"] },
        runtime: { command: { exitCode: 7 }, networkDenials: [{ host: "127.0.0.1" }] } });
      expect(clean).toMatchObject({ success: true, output: "independent" });
      expect(clean.runtime?.networkDenials).toBeUndefined();
      expect(denied.blockedHosts().size).toBe(0);
      const masked = await shell.execute("bash", { command: `${command}; true` });
      expect(masked.success).toBe(true);
      expect(masked.runtime?.command?.exitCode).toBe(0);
      expect(masked.output).toContain("Sandbox network refusals");
    } finally { origin.close(); allowed.close(); denied.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
  it("fails closed with structured evidence when the proxy cannot start", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-proxy-failure-")));
    mkdirSync(join(root, "workspace"));
    try {
      const shell = executor(join(root, "workspace"), () => { throw new Error("test bind failure"); });
      const result = await shell.execute("bash", { command: "printf must-not-run" });
      expect(result).toMatchObject({ success: false, failure: { code: "BACKEND_UNAVAILABLE", source: "backend" } });
      expect(result.output).not.toContain("must-not-run");
      expect(result.runtime?.broker?.sandboxEnforced).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
