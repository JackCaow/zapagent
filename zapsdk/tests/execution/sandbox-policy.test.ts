import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { createCapabilityGrant } from "../../policy/engine.js";
import type { ToolEffects } from "../../tools/effects.js";
import { WINDOWS_APPCONTAINER_HELPER } from "../../execution/windows-appcontainer.js";
import { monitorTool } from "../../builtin-tools/monitor.js";
import { NetworkProxy } from "../../execution/network-proxy.js";

const cleanup: string[] = [];
const originalProgramFiles = process.env.ProgramFiles;
afterEach(() => {
  delete process.env.ZAP_TEST_SANDBOX_SECRET;
  delete process.env.ZAP_TEST_TRUSTED_PROXY;
  if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
  else process.env.ProgramFiles = originalProgramFiles;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("sandbox policy construction", () => {
  test("only broker-authorized CLI integration can extend command proxy domains", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-proxy-scope-")); cleanup.push(root);
    const proxies: NetworkProxy[] = [];
    const sandbox = createPlatformSandbox({ platform: "darwin", sandboxExecPath: process.execPath,
      tempRoot: join(root, "temp"), networkProxy: () => {
        const proxy = new NetworkProxy(() => ({ allowedDomains: [], deniedDomains: ["api.anthropic.com"] }));
        proxies.push(proxy); return proxy;
      } });
    const effects = processEffects(root);
    effects.network = [{ kind: "network", operation: "connect", destinations: ["*"] }];
    const input = { executionId: "proxy-scope", workspace: { root }, effects,
      grant: createCapabilityGrant("proxy", effects, Date.now() + 10000) };
    const options = { cwd: root, networkDomains: ["chatgpt.com", "api.anthropic.com"] };
    const ordinary = sandbox.createContext(input).prepareShell("true", options);
    const delegate = sandbox.createContext({ ...input, externalCliIntegration: true }).prepareCommand("codex", [], options);
    try {
      expect(proxies[0]!.decideHost("chatgpt.com").allowed).toBe(false);
      expect(proxies[1]!.decideHost("chatgpt.com").allowed).toBe(true);
      expect(proxies[1]!.decideHost("api.anthropic.com").allowed).toBe(false);
    } finally { ordinary.release(); delegate.release(); }
  });
  test("adapter env values do not grant writes and temp aliases use the private command directory", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-delegate-env-"));
    cleanup.push(root);
    const effects = processEffects(root);
    const sandbox = createPlatformSandbox({ platform: "darwin", sandboxExecPath: process.execPath,
      tempRoot: join(root, "temp") });
    const context = sandbox.createContext({ executionId: "delegate:env", workspace: { root }, effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000) });
    const prepared = context.prepareCommand("claude", [], { cwd: root, hostHome: true,
      environment: { CLAUDE_CONFIG_DIR: "/not-granted", CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
        TMPDIR: "/not-granted", CLAUDE_CODE_TMPDIR: "/not-granted" },
      temporaryDirectoryEnvironment: ["CLAUDE_CODE_TMPDIR"] });
    try {
      expect(prepared.env.CLAUDE_CONFIG_DIR).toBe("/not-granted");
      expect(prepared.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
      expect(prepared.env.CLAUDE_CODE_TMPDIR).toBe(prepared.env.TMPDIR);
      expect(prepared.env.TMPDIR).not.toBe("/not-granted");
      expect(prepared.env.XDG_CONFIG_HOME).toBe(join(prepared.env.TMPDIR!, "config"));
      expect(context.writablePaths).not.toContain("/not-granted");
      expect(existsSync(prepared.env.TMPDIR!)).toBe(true);
    } finally { prepared.release(); }
    expect(existsSync(prepared.env.TMPDIR!)).toBe(false);
  });
  test("uses an environment allowlist and only preserves explicitly named credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-sandbox-policy-"));
    cleanup.push(root);
    process.env.ZAP_TEST_SANDBOX_SECRET = "do-not-leak";
    process.env.ZAP_TEST_TRUSTED_PROXY = "http://127.0.0.1:3128";
    process.env.ProgramFiles = "C:\\Program Files";
    const effects = processEffects(root);
    const sandbox = createPlatformSandbox({
      platform: "darwin",
      sandboxExecPath: process.execPath,
      tempRoot: join(root, "temp"),
      trustedEnvironmentNames: ["ZAP_TEST_TRUSTED_PROXY"],
    });
    const context = sandbox.createContext({
      executionId: "execution:env",
      workspace: { root, mode: "root" },
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
    });

    const filtered = context.prepareShell("true", { cwd: root });
    const preserved = context.prepareShell("true", {
      cwd: root,
      preserveEnvironment: ["ZAP_TEST_SANDBOX_SECRET"],
    });
    try {
      // The host PATH is passed through unchanged. On macOS exactly one directory
      // may be prepended: the real git, so the xcrun shim is never involved.
      const hostPath = process.env.PATH!;
      expect(filtered.env.PATH!.endsWith(hostPath)).toBe(true);
      const prefix = filtered.env.PATH!.slice(0, filtered.env.PATH!.length - hostPath.length);
      if (prefix) {
        expect(process.platform).toBe("darwin");
        expect(prefix.endsWith(delimiter)).toBe(true);
        expect(prefix.slice(0, -1).includes(delimiter)).toBe(false);
        expect(existsSync(join(prefix.slice(0, -1), "git"))).toBe(true);
      }
      expect(filtered.env.ProgramFiles).toBe("C:\\Program Files");
      expect(filtered.env.ZAP_TEST_SANDBOX_SECRET).toBeUndefined();
      expect(filtered.env.ZAP_TEST_TRUSTED_PROXY).toBe("http://127.0.0.1:3128");
      expect(preserved.env.ZAP_TEST_SANDBOX_SECRET).toBe("do-not-leak");
      expect(context.protectedPaths).toContain(join(root, ".git"));
      expect(context.protectedPaths).toContain(join(root, ".zapcode"));
    } finally {
      filtered.release();
      preserved.release();
    }
  });

  test("Linux policy overlays protected paths read-only and keeps network unshared", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-bwrap-policy-"));
    cleanup.push(root);
    mkdirSync(join(root, ".git"));
    const effects = processEffects(root);
    const sandbox = createPlatformSandbox({
      platform: "linux",
      bwrapPath: process.execPath,
      tempRoot: join(root, "temp"),
    });
    const context = sandbox.createContext({
      executionId: "execution:linux-policy",
      workspace: { root, mode: "root" },
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
    });
    const prepared = context.prepareShell("true", { cwd: root });
    try {
      const gitIndex = prepared.args.findIndex((arg, index) => (
        arg === "--ro-bind" && prepared.args[index + 1] === context.protectedPaths[0]
      ));
      expect(gitIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.args).not.toContain("--share-net");
      expect(prepared.args).toContain("--unshare-all");
      expect(prepared.args).toContain(context.protectedPaths[1]);
      expect(existsSync(join(root, ".zapcode"))).toBe(true);
    } finally {
      prepared.release();
    }
    expect(existsSync(join(root, ".zapcode"))).toBe(false);
  });

  test("Linux policy preserves an embedder-owned writable tool store", () => {
    const fixture = mkdtempSync(join(tmpdir(), "zap-bwrap-trusted-write-"));
    cleanup.push(fixture);
    const root = join(fixture, "workspace");
    const toolStore = join(fixture, "computer", "nix");
    mkdirSync(root, { recursive: true });
    mkdirSync(toolStore, { recursive: true });
    const effects = processEffects(root);
    const sandbox = createPlatformSandbox({
      platform: "linux",
      bwrapPath: process.execPath,
      tempRoot: join(fixture, "temp"),
      trustedWritablePaths: [toolStore],
    });
    const context = sandbox.createContext({
      executionId: "execution:trusted-write",
      workspace: { root, mode: "root" },
      effects,
      grant: createCapabilityGrant("call", effects, Date.now() + 60_000),
    });
    const prepared = context.prepareShell("true", { cwd: root });
    const canonicalToolStore = realpathSync(toolStore);
    try {
      const bindIndex = prepared.args.findIndex((arg, index) => (
        arg === "--bind" && prepared.args[index + 1] === canonicalToolStore
      ));
      expect(bindIndex).toBeGreaterThanOrEqual(0);
      expect(context.writablePaths).toContain(canonicalToolStore);
    } finally {
      prepared.release();
    }
  });

  test("embedded Windows helper replaces inherited writes with a read-only protected-path ACL", () => {
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("ProtectReadOnly");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("SetAccessRuleProtection(true, true)");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("PurgeAccessRules(sid)");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("protectedPaths");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("createdProtected");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("loading cached launcher");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("-OutputAssembly $temporaryAssembly");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("Remove-Item -LiteralPath $launcherAssembly");
    expect(WINDOWS_APPCONTAINER_HELPER).toContain("if (-not (Test-Path -LiteralPath $launcherAssembly -PathType Leaf)) { throw }");
    expect(WINDOWS_APPCONTAINER_HELPER.indexOf("leases.Add(AclLease.ProtectReadOnly"))
      .toBeLessThan(WINDOWS_APPCONTAINER_HELPER.indexOf("foreach (string path in allPaths) leases.Add(AclLease.Grant"));
  });

  test("monitor shell execution is offline unless an embedder opts in", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-monitor-policy-"));
    cleanup.push(root);
    const offline = monitorTool({ projectCwd: root }).tool;
    const online = monitorTool({ projectCwd: root, sandboxNetwork: true }).tool;
    const context = { cwd: root, toolName: "monitor" };

    expect(offline.definition.resolveEffects?.({}, context).network).toEqual([]);
    expect(online.definition.resolveEffects?.({}, context).network[0]?.destinations).toEqual(["*"]);
  });
});

function processEffects(root: string): ToolEffects {
  return {
    filesystem: [
      { kind: "filesystem", operation: "read", paths: [root] },
      { kind: "filesystem", operation: "modify", paths: [root] },
    ],
    network: [],
    process: [{ kind: "process", operation: "spawn", commandClass: "test" }],
    external: [],
    workspace: { mode: "root-integration" },
    confidence: "declared",
  };
}
