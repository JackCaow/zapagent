import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate React/singleton mocks from the rest of the app suite.
const fixture = String.raw`
  import { mock } from "bun:test";
  import { mkdirSync, writeFileSync } from "node:fs";
  import { dirname, join } from "node:path";
  import { PermissionManager, getProjectSettingsPath, getProjectAuthorizationSettingsPath, savePermissionSettings } from "./src/permissions.ts";
  let pending = null, sessionId = "first";
  const cwd = join(dirname(process.env.ZAPCODE_DATA_DIR), "project");
  mkdirSync(cwd);
  const mgr = new PermissionManager(cwd);
  const logs = [];
  mock.module("react", () => ({ useState: () => [null, value => { pending = typeof value === "function" ? value(pending) : value; }], useCallback: callback => callback, useRef: value => ({ current: value }), useEffect() {} }));
  mock.module("./src/singletons.ts", () => ({ appLogger: { info() {}, warn() {} }, permissionManager: mgr }));
  mock.module("./src/session.ts", () => ({ getCurrentSessionId: () => sessionId }));
  const { usePermissionApproval } = await import("./src/hooks/usePermissionApproval.ts");
  const configRef = { current: { permissionMode: "default" } };
  const { WorkspaceAccess } = await import("./src/workspace-access.ts");
  process.chdir(cwd);
  const access = new WorkspaceAccess(cwd);
  const scope = access.begin(sessionId, "run", "auto", { kind: "user" });
  configRef.current.permissionMode = "acceptEdits";
  const hook = usePermissionApproval({ configRef, access, allowProjectCommands: () => access.choose("project", sessionId),
    addLog: (type, text) => logs.push([type, text]) });
  const args = { command: "printf hi" };
  const scenario = process.env.SCENARIO;
  const result = {};
  const request = (ar = args, signal) => hook.onApproval("bash", ar, signal, { actor: scope.actor, cwd, workspaceRoot: cwd, shell: { syntax: "posix", filesystem: "host" } });
  if (scenario === "reads") {
    for (const mode of ["default", "bypassPermissions"]) {
      configRef.current.permissionMode = mode;
      const directory = mode === "default" ? "/fixture/screenshots" : cwd;
      for (const path of [join(directory, "first.jpg"), join(directory, "second.jpg")]) {
        const approval = hook.onApproval("read_file", { path });
        if (pending) { result.prompted = true; pending.resolve("deny"); }
        (result.decisions ??= []).push(await approval);
      }
    }
    result.prompted ??= false;
  } else if (scenario === "project") {
    const first = request(); result.projectOption = pending.allowScope;
    pending.resolve("forever"); result.first = await first;
    const same = request();
    if (pending) pending.resolve("deny");
    result.same = await same;
    const next = request({ command: "echo different" });
    result.nextAsked = !!pending;
    if (pending) pending.resolve("deny");
    await next;
    result.persisted = new WorkspaceAccess(cwd).remembered();
    access.choose("revoke", sessionId);
    configRef.current.permissionMode = "plan";
    result.revoked = await request();
  } else if (scenario === "repeats") {
    mgr.setSandboxConfined(false);
    const push = { command: "git push origin main" };
    result.repeats = [];
    for (const ar of [push, push, { command: "git push origin other" }, { command: "npm publish" }]) {
      const next = request(ar); result.repeats.push(pending.repeats); pending.resolve("once"); await next;
    }
    sessionId = "next";
    const next = request(push); result.afterNew = pending.repeats; pending.resolve("deny"); await next;

  } else if (scenario === "abort") {
    const controller = new AbortController();
    const first = request(args, controller.signal); const saved = pending;
    controller.abort(); saved.resolve("forever");
    result.first = await first;
  } else if (scenario === "stale") {
    const first = request(); const saved = pending;
    sessionId = "changed"; saved.resolve("forever"); result.first = await first;
  } else if (scenario === "late-ask" || scenario === "late-deny") {
    const first = request();
    const type = scenario === "late-ask" ? "ask" : "deny";
    savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(*)", type }] });
    pending.resolve("forever");
    result.first = await first;
  } else if (scenario === "mode-change") {
    const first = request(); configRef.current.permissionMode = "plan"; pending.resolve("forever"); result.first = await first;
  } else if (scenario === "double") {
    const first = request(); const saved = pending;
    saved.resolve("once"); saved.resolve("forever"); result.first = await first;
  } else if (scenario === "save-failure") {
    const path = getProjectAuthorizationSettingsPath(cwd);
    mkdirSync(dirname(dirname(path)), { recursive: true }); writeFileSync(dirname(path), "blocked");
    const first = request(); pending.resolve("forever"); result.first = await first;
  } else if (["danger", "ask", "deny", "plan", "ordinary-allow"].includes(scenario)) {
    if (scenario === "ordinary-allow") savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(*)", type: "allow" }] });
    else access.choose("project", sessionId);
    if (["ask", "deny"].includes(scenario)) savePermissionSettings(getProjectSettingsPath(cwd), { rules: [{ pattern: "Bash(*)", type: scenario }] });
    mgr.reload();
    if (scenario === "plan") configRef.current.permissionMode = "plan";
    const first = request(scenario === "danger" ? { ...args, command: "rm -rf /" } : args);
    result.prompted = !!pending;
    if (pending) { result.allowScope = pending.allowScope; pending.resolve("forever"); }
    result.first = await first;
  }
  result.grant = access.remembered();
  result.logs = logs;
  console.log(JSON.stringify(result));
`

function run(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "zap-approval-hook-"))
  try {
    const child = spawnSync(process.execPath, ["-e", fixture], { encoding: "utf8", cwd: process.cwd(), timeout: 10000,
      env: { ...process.env, ZAPCODE_DATA_DIR: join(root, "data"), SCENARIO: scenario } })
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" })
    return JSON.parse(child.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe("local project authorization through the real hook", () => {
  it("reads consecutive paths without prompting", () => {
    const result = run("reads")
    expect(result.prompted).toBe(false)
    expect(result.decisions).toEqual([true, true, true, true])
  })
  it("persists project authorization, reuses it for commands and revokes it", () => {
    const result = run("project")
    expect(result.projectOption).toBe(true)
    expect(result.first).toBe(true)
    expect(result.same).toBe(true)
    expect(result.nextAsked).toBe(true)
    expect(result.persisted).toBe(true)
    expect(result.revoked).toMatchObject({ approved: false })
    expect(result.grant).toBe(false)
  })
  for (const scenario of ["abort", "stale", "double", "mode-change", "late-ask", "late-deny"]) {
    it(`${scenario} callbacks never install a grant`, () => {
      expect(run(scenario).grant).toBe(false)
    })
  }
  it("reports persistence failure and denies the selected command", () => {
    const result = run("save-failure")
    expect(result.first).toBe(false)
    expect(result.grant).toBe(false)
    expect(result.logs.some(([type, text]: string[]) => type === "error" && text.includes("Could not save project access"))).toBe(true)
  })
  for (const scenario of ["danger", "ask", "deny", "plan"]) {
    it(`${scenario} still overrides scoped consent`, () => {
      const result = run(scenario)
      expect(result.prompted).toBe(["danger", "ask"].includes(scenario))
      if (result.prompted) expect(result.allowScope).toBe(false)
      else expect(result.first).toMatchObject({ approved: false })
      expect(result.logs.some(([, text]: string[]) => text.includes("allowed for this project"))).toBe(false)
    })
  }
  it("older Bash allow rules do not become local command authorization", () => {
    const result = run("ordinary-allow")
    expect(result.prompted).toBe(true)
    expect(result.allowScope).toBe(true)
  })
})


describe("repeated one-time approvals through the real hook", () => {
  it("counts approvals of the same consent within a session", () => {
    const result = run("repeats")
    expect(result.repeats).toEqual([0, 1, 2, 0])
    expect(result.afterNew).toBe(0)
  })
})
