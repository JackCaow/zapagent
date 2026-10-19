import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeCommandTool } from "../../builtin-tools/command.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
import { createPlatformSandbox } from "../../execution/sandbox.js";
import { linkedWorktreeReadRoots, workspaceRuntimeDirectory, workspaceRuntimeTemporaryDirectory } from "../../execution/workspace-runtime.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

let fixture: string, root: string, storage: string;
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "zap-workspace-runtime-")));
  root = join(fixture, "workspace"); storage = join(fixture, "private");
  mkdirSync(join(root, "nested"), { recursive: true });
});
afterEach(() => {
  if (existsSync(storage)) for (const entry of readdirSync(storage)) {
    rmSync(workspaceRuntimeTemporaryDirectory(join(storage, entry)), { recursive: true, force: true });
  }
  rmSync(fixture, { recursive: true, force: true });
});
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
function executor(cwd = root) {
  const registry = new ToolRegistry();
  registry.register(executeCommandTool({ defaultCwd: cwd }));
  return new ToolExecutor(registry, { cwd, onApproval: async () => true,
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "required",
      sandbox: createPlatformSandbox({ workspaceStateRoot: storage }) }) });
}
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, stdio: ["ignore", "pipe", "pipe"] });
}

describe("workspace runtime storage", () => {
  it("persists by canonical workspace and separates other workspaces", () => {
    const first = workspaceRuntimeDirectory(storage, root);
    writeFileSync(join(first, "home", "state"), "fixture");
    expect(workspaceRuntimeDirectory(storage, root)).toBe(first);
    expect(readFileSync(join(first, "home", "state"), "utf8")).toBe("fixture");
    expect(workspaceRuntimeDirectory(storage, join(root, "nested"))).not.toBe(first);
  });
  it("rejects a redirected private HOME", () => {
    const runtime = workspaceRuntimeDirectory(storage, root);
    rmSync(join(runtime, "home"), { recursive: true });
    symlinkSync(root, join(runtime, "home"), "junction");
    expect(() => workspaceRuntimeDirectory(storage, root)).toThrow("real directory");
  });
  it("requires reciprocal worktree metadata before adding read roots", () => {
    git("init", "-q"); git("commit", "--allow-empty", "-qm", "fixture");
    const linked = join(fixture, "linked"); git("worktree", "add", "--detach", linked, "HEAD");
    const roots = linkedWorktreeReadRoots(linked);
    expect(roots).toHaveLength(2);
    expect(roots[1]).toBe(join(root, ".git"));
    const forged = join(fixture, "forged"); mkdirSync(forged);
    writeFileSync(join(forged, ".git"), readFileSync(join(linked, ".git")));
    expect(linkedWorktreeReadRoots(forged)).toEqual([]);
  });
  (process.platform === "win32" ? it.skip : it)("does not block on FIFO worktree metadata or accept oversized pointers", () => {
    const gitDir = join(fixture, "fake.git", "worktrees", "id"); mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
    execFileSync("mkfifo", [join(gitDir, "commondir")]);
    const module = fileURLToPath(new URL("../../execution/workspace-runtime.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["-e", `import {linkedWorktreeReadRoots} from ${JSON.stringify(module)}; console.log(JSON.stringify(linkedWorktreeReadRoots(${JSON.stringify(root)})))`], { encoding: "utf8", timeout: 3000 });
    expect(output.trim()).toBe("[]");
    writeFileSync(join(root, ".git"), "gitdir: " + "x".repeat(4097));
    expect(linkedWorktreeReadRoots(root)).toEqual([]);
  });
});

const native = process.platform === "darwin" && createPlatformSandbox().status().available;
(native ? describe : describe.skip)("workspace sandbox workflows (real macOS)", () => {
  it("keeps the workspace scope at nested cwd while denying undeclared siblings", async () => {
    writeFileSync(join(root, "config"), "root-config");
    writeFileSync(join(fixture, "outside"), "outside");
    const shell = executor();
    const inside = await shell.execute("bash", { command: "cat ../config", cwd: join(root, "nested") });
    expect(inside).toMatchObject({ success: true, output: "root-config" });
    expect((await shell.execute("bash", { command: "cat ../outside" })).success).toBe(false);
    expect(await shell.execute("bash", { command: "cat ../outside", read_paths: ["../outside"] }))
      .toMatchObject({ success: true, output: "outside" });
    expect(await shell.execute("bash", { command: "printf output > ../output", write_paths: ["../output"] }))
      .toMatchObject({ success: true });
    expect(readFileSync(join(fixture, "output"), "utf8")).toBe("output");
  });
  it("retains scratch and HOME across commands, without granting another workspace's storage", async () => {
    const shell = executor();
    const first = await shell.execute("bash", { command: 'printf home > "$HOME/state" && printf scratch > "$TMPDIR/state" && printf "%s" "$TMPDIR"' });
    expect(first.success).toBe(true);
    expect(existsSync(first.output)).toBe(true);
    expect(Buffer.byteLength(first.output)).toBeLessThan(80);
    expect(await shell.execute("bash", { check_steps: ['cat "$HOME/state"', 'cat "$TMPDIR/state"'] }))
      .toMatchObject({ success: true });
    const other = executor(join(root, "nested"));
    expect((await other.execute("bash", { command: `cat ${quote(join(first.output, "state"))}` })).success).toBe(false);
  });
  it("reads linked worktree Git metadata without allowing mutations", async () => {
    git("init", "-q"); git("commit", "--allow-empty", "-qm", "fixture");
    const linked = join(fixture, "linked"); git("worktree", "add", "--detach", linked, "HEAD");
    const shell = executor(linked);
    expect(await shell.execute("bash", { command: "git status --porcelain" })).toMatchObject({ success: true });
    writeFileSync(join(linked, "input"), "fixture");
    expect((await shell.execute("bash", { command: "git add input" })).success).toBe(false);
  });
  it("makes private user-install entry points available on later commands", async () => {
    const shell = executor();
    expect((await shell.execute("bash", { command: 'mkdir -p "$HOME/.local/bin" && printf "#!/bin/sh\\nprintf private-cli" > "$HOME/.local/bin/zap-fixture-cli" && chmod +x "$HOME/.local/bin/zap-fixture-cli"' })).success).toBe(true);
    expect(await shell.execute("bash", { command: "zap-fixture-cli" })).toMatchObject({ success: true, output: "private-cli" });
  });
  it("permits local Unix socket clients as well as listeners", async () => {
    const result = await executor().execute("bash", { command: `node -e 'const n=require("net"),p=process.env.TMPDIR+"/ipc.sock";const s=n.createServer(c=>c.end("ok"));s.listen(p,()=>{const c=n.connect(p);c.on("data",d=>process.stdout.write(d));c.on("end",()=>s.close())})'` });
    expect(result).toMatchObject({ success: true, output: "ok" });
  });
  it("does not extend local IPC permission to outside host sockets", async () => {
    const directory = mkdtempSync("/private/tmp/zap-outside-ipc-");
    const socket = join(directory, "server.sock");
    let contacted = false;
    const server = createServer(client => { contacted = true; client.end(); });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    try {
      const result = await executor().execute("bash", { command: `node -e 'require("net").connect(${JSON.stringify(socket)}).on("error",()=>process.stdout.write("denied"))'` });
      expect(result).toMatchObject({ success: true, output: "denied" });
      expect(contacted).toBe(false);
    } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
