import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, writeFileTool } from "../../builtin-tools/filesystem.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor, isToolAuthorization } from "../../tools/executor.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(approve = true, delegated = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-file-grant-")));
  dirs.push(root);
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const target = join(root, "external.txt");
  writeFileSync(target, "external content");
  const options = { allowedPaths: [cwd], useExecutionGrants: delegated, protectedPaths: [join(cwd, ".git")] };
  const registry = new ToolRegistry();
  registry.register(readFileTool(options));
  registry.register(writeFileTool(options));
  let approvals = 0;
  const executor = new ToolExecutor(registry, { cwd,
    onApproval: async () => { approvals++; return approve; },
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "disabled" }),
  });
  return { root, cwd, target, executor, registry, approvals: () => approvals };
}

describe("approved file capabilities reach handlers", () => {
  it("reads and writes the approved outside path through the real executor", async () => {
    const f = setup();
    const read = await f.executor.execute("read_file", { path: f.target });
    expect(read.success).toBe(true);
    expect(read.output).toContain("external content");
    const write = await f.executor.execute("write_file", { path: f.target, content: "approved update" });
    expect(write.success).toBe(true);
    expect(readFileSync(f.target, "utf8")).toBe("approved update");
    expect(f.approvals()).toBe(2);
  });
  it("keeps SDK static roots and explicit denials effective", async () => {
    expect((await setup(true, false).executor.execute("read_file", { path: "/etc/hosts" })).success).toBe(false);
    const denied = setup(false);
    expect((await denied.executor.execute("write_file", { path: denied.target, content: "bad" })).success).toBe(false);
    expect(readFileSync(denied.target, "utf8")).toBe("external content");
  });
  it("fails closed without a host grant, and read permission never grants writes", async () => {
    const f = setup();
    expect((await f.registry.get("read_file")!.handler({ path: f.target })).success).toBe(false);
    const context = { toolCallId: "call", grant: { callId: "call", expiresAt: Date.now() + 60_000, filesystem: { read: [f.target], write: [] } } };
    expect((await f.registry.get("write_file")!.handler({ path: f.target, content: "bad" }, undefined, context)).success).toBe(false);
    expect((await f.registry.get("read_file")!.handler({ path: f.target }, undefined, { ...context, toolCallId: "other" })).success).toBe(false);
    expect((await f.registry.get("read_file")!.handler({ path: f.target }, undefined, { ...context, grant: { ...context.grant, expiresAt: 0 } })).success).toBe(false);
  });
  it("does not let the app opt-in widen an isolated child workspace", async () => {
    const f = setup();
    let prompted = false;
    const executor = new ToolExecutor(f.registry, { cwd: f.cwd,
      workspace: { root: f.cwd, mode: "isolated-write", sandbox: "enforced" },
      onApproval: async () => { prompted = true; return true; },
      executionBroker: new DefaultExecutionBroker({ sandboxMode: "disabled" }),
    });
    expect((await executor.execute("read_file", { path: f.target })).success).toBe(false);
    expect(prompted).toBe(false);
  });
  it("rechecks canonical targets after approval and preserves protected paths", async () => {
    const f = setup();
    const link = join(f.cwd, "link.txt");
    const secret = join(f.root, "secret.txt");
    writeFileSync(secret, "unapproved");
    symlinkSync(f.target, link);
    const authorization = await f.executor.authorize("read_file", { path: link });
    expect(isToolAuthorization(authorization)).toBe(true);
    unlinkSync(link);
    symlinkSync(secret, link);
    if (!isToolAuthorization(authorization)) throw new Error("authorization missing");
    expect((await f.executor.executeAuthorized(authorization)).success).toBe(false);
    mkdirSync(join(f.cwd, ".git"));
    expect((await f.executor.execute("write_file", { path: join(f.cwd, ".git", "config"), content: "bad" })).success).toBe(false);
  });
});
