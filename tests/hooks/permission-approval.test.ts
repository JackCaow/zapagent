import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate React/singleton mocks from the rest of the app suite.
const fixture = String.raw`
  import { mock } from "bun:test";
  import { mkdirSync, writeFileSync } from "node:fs";
  import { dirname } from "node:path";
  import { PermissionManager, getProjectSettingsPath, getProjectAuthorizationSettingsPath, savePermissionSettings } from "./src/permissions.ts";
  let pending = null, sessionId = "first";
  const mgr = new PermissionManager(process.env.ZAPCODE_DATA_DIR);
  const logs = [];
  mock.module("react", () => ({ useState: () => [null, value => { pending = typeof value === "function" ? value(pending) : value; }], useCallback: callback => callback, useRef: value => ({ current: value }), useEffect() {} }));
  mock.module("./src/singletons.ts", () => ({ appLogger: { info() {}, warn() {} }, permissionManager: mgr }));
  mock.module("./src/session.ts", () => ({ getCurrentSessionId: () => sessionId }));
  const { usePermissionApproval } = await import("./src/hooks/usePermissionApproval.ts");
  const configRef = { current: { permissionMode: "default" } };
  const hook = usePermissionApproval({ configRef, addLog: (type, text) => logs.push([type, text]) });
  const args = { command: "printf hi", dangerouslyDisableSandbox: true };
  const scenario = process.env.SCENARIO;
  const result = {};
  const request = (ar = args, signal) => hook.onApproval("bash", ar, signal);
  if (scenario.startsWith("custom") || scenario === "late-deny" || scenario === "late-ask") {
    const controller = new AbortController();
    const ordinary = { command: "printf hi" };
    const first = request(ordinary, controller.signal); const saved = pending;
    if (scenario === "custom-abort") controller.abort();
    if (scenario === "custom-stale") sessionId = "next";
    if (scenario.startsWith("late-")) {
      savePermissionSettings(getProjectSettingsPath(process.env.ZAPCODE_DATA_DIR), { rules: [{ pattern: "Bash(*)", type: scenario === "late-deny" ? "deny" : "ask" }] });
      saved.resolve("forever");
    } else {
      const tools = scenario === "custom-unrelated" ? ["read_file"] : ["bash", "read_file"];
      result.error = saved.grant({ tools, resource: { kind: "all" }, lifetime: "project" }, ["bash", "read_file"]);
      if (pending) pending.resolve("deny");
    }
    result.first = await first;
    result.ordinary = mgr.checkPermission("bash", ordinary).decision;
    result.persisted = mgr.getSummary().find(group => group.label === "project grants")?.rules.length ?? 0;
  } else if (["session", "project"].includes(scenario)) {
    const first = request(); result.scopeOptions = pending.allowScope;
    pending.resolve(scenario === "session" ? "always" : "forever"); result.first = await first;
    result.next = await request({ ...args, command: "echo different" });
    result.scope = mgr.checkSandboxEscape().scope;
    result.fresh = new PermissionManager(process.env.ZAPCODE_DATA_DIR).checkSandboxEscape().decision;
    sessionId = "new";
    const next = request();
    result.promptAgain = pending !== null;
    if (pending) pending.resolve("deny");
    result.afterNew = await next;
  } else if (scenario === "abort") {
    const controller = new AbortController();
    const first = request(args, controller.signal); const saved = pending;
    controller.abort(); saved.resolve("forever");
    result.first = await first;
  } else if (scenario === "stale") {
    const first = request(); const saved = pending;
    sessionId = "changed"; saved.resolve("forever"); result.first = await first;
  } else if (scenario === "mode-change") {
    const first = request(); configRef.current.permissionMode = "plan"; pending.resolve("forever"); result.first = await first;
  } else if (scenario === "double") {
    const first = request(); const saved = pending;
    saved.resolve("once"); saved.resolve("forever"); result.first = await first;
  } else if (scenario === "save-failure") {
    const path = getProjectAuthorizationSettingsPath(process.env.ZAPCODE_DATA_DIR);
    mkdirSync(dirname(dirname(path)), { recursive: true }); writeFileSync(dirname(path), "blocked");
    const first = request(); pending.resolve("forever"); result.first = await first;
  } else if (["danger", "ask", "deny", "plan", "ordinary-allow"].includes(scenario)) {
    if (scenario === "ordinary-allow") savePermissionSettings(getProjectSettingsPath(process.env.ZAPCODE_DATA_DIR), { rules: [{ pattern: "Bash(*)", type: "allow" }] });
    else mgr.grantSandboxEscape("session");
    if (["ask", "deny"].includes(scenario)) savePermissionSettings(getProjectSettingsPath(process.env.ZAPCODE_DATA_DIR), { rules: [{ pattern: "Bash(*)", type: scenario }] });
    mgr.reload();
    if (scenario === "plan") configRef.current.permissionMode = "plan";
    const first = request(scenario === "danger" ? { ...args, command: "rm -rf /" } : args);
    result.prompted = !!pending;
    if (pending) { result.allowScope = pending.allowScope; pending.resolve("forever"); }
    result.first = await first;
  }
  result.grant = mgr.checkSandboxEscape().decision;
  result.logs = logs;
  console.log(JSON.stringify(result));
`

function run(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "zap-approval-hook-"))
  try {
    const child = spawnSync(process.execPath, ["-e", fixture], { encoding: "utf8", cwd: process.cwd(),
      env: { ...process.env, ZAPCODE_DATA_DIR: root, SCENARIO: scenario } })
    expect(child.status).toBe(0)
    expect(child.stderr).toBe("")
    return JSON.parse(child.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe("sandbox approval through the real hook", () => {
  for (const scope of ["session", "project"]) {
    it(`${scope} consent covers subsequent commands with the right lifetime`, () => {
      const result = run(scope)
      expect(result.scopeOptions).toBe(true)
      expect(result.first).toBe(true)
      expect(result.next).toBe(true)
      expect(result.scope).toBe(scope)
      expect(result.fresh).toBe(scope === "project" ? "allow" : "ask")
      expect(result.promptAgain).toBe(scope === "session")
      expect(result.afterNew).toEqual(scope === "project" ? true : { approved: false, source: "approval", reason: "user declined approval" })
    })
  }
  for (const scenario of ["abort", "stale", "double", "mode-change"]) {
    it(`${scenario} callbacks never install a grant`, () => {
      expect(run(scenario).grant).toBe("ask")
    })
  }
  it("reports persistence failure and grants only the selected command", () => {
    const result = run("save-failure")
    expect(result.first).toBe(true)
    expect(result.grant).toBe("ask")
    expect(result.logs.some(([type, text]: string[]) => type === "error" && text.includes("Approved this command only"))).toBe(true)
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
  it("ordinary Bash allow rules still require dedicated escape consent", () => {
    const result = run("ordinary-allow")
    expect(result.prompted).toBe(true)
    expect(result.allowScope).toBe(true)
  })
})


describe("custom tool authorization through the real hook", () => {
  it("saves a reviewed batch and approves the covered waiting command", () => {
    const result = run("custom")
    expect(result.first).toBe(true)
    expect(result.ordinary).toBe("allow")
    expect(result.persisted).toBe(2)
  })
  for (const scenario of ["custom-unrelated", "custom-abort", "custom-stale", "late-deny", "late-ask"]) {
    it(`${scenario} cannot install broad rules`, () => {
      const result = run(scenario)
      expect(result.persisted).toBe(0)
      expect(result.ordinary).not.toBe("allow")
      if (scenario === "late-ask") expect(result.first).toBe(true)
      else expect(result.first).not.toBe(true)
      if (scenario === "custom-unrelated") expect(result.error).toContain("must cover")
    })
  }
})
