import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Run each host-hook scenario in its own process so module mocks never leak
// into the application suite. Every filesystem grant stays in disposable data.
const hookFixture = String.raw`
  import { mock } from "bun:test";
  import * as React from "react";
  import { PermissionManager } from "./src/permissions.ts";
  let pending = null, sessionId = "first";
  const manager = new PermissionManager(process.env.ZAPCODE_DATA_DIR);
  mock.module("react", () => ({ ...React,
    useState: () => [null, value => { pending = typeof value === "function" ? value(pending) : value; }],
    useCallback: callback => callback, useRef: value => ({ current: value }), useEffect() {},
  }));
  mock.module("./src/singletons.ts", () => ({ appLogger: { info() {}, warn() {} }, permissionManager: manager }));
  mock.module("./src/session.ts", () => ({ getCurrentSessionId: () => sessionId }));
  const { usePermissionApproval } = await import("./src/hooks/usePermissionApproval.ts");
  const hook = usePermissionApproval({ configRef: { current: { permissionMode: "default" } }, addLog() {} });
  const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(setImmediate); };
  const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve("unsettled"), 120))]);
  const firstController = new AbortController(), nextController = new AbortController();
  const first = hook.onApproval("bash", { command: "printf fixture" }, firstController.signal);
  await flush();
  const initial = pending;
  const scenario = process.env.SCENARIO;
  const nextName = scenario === "covered" ? "bash" : "mcp_sampling:fixture";
  const nextArgs = nextName === "bash" ? { command: "echo fixture" } : { messageCount: 1, maxTokens: 8 };
  const next = hook.onApproval(nextName, nextArgs, nextController.signal);
  await flush();
  const result = { initialName: initial?.name, keptFirst: pending === initial };
  const batch = { tools: ["bash"], resource: { kind: "all" }, lifetime: "project" };
  if (scenario === "queued-cancel") {
    nextController.abort(); await flush();
    result.next = await bounded(next);
    result.keptAfterCancel = pending === initial;
    initial?.resolve("once"); result.first = await bounded(first);
  } else if (scenario === "active-cancel") {
    firstController.abort(); await flush();
    result.first = await bounded(first);
    const active = pending;
    result.nextName = active?.name;
    initial?.resolve("forever"); initial?.grant(batch, ["bash"]);
    result.keptAfterStale = pending === active;
    active?.resolve("once"); result.next = await bounded(next);
  } else if (scenario === "double") {
    initial?.resolve("once"); await flush();
    result.first = await bounded(first);
    const active = pending;
    result.nextName = active?.name;
    initial?.resolve("forever"); initial?.grant(batch, ["bash"]);
    result.keptAfterStale = pending === active;
    active?.resolve("once"); result.next = await bounded(next);
  } else if (scenario === "session-change") {
    sessionId = "changed";
    initial?.resolve("forever"); await flush();
    result.first = await bounded(first);
    result.next = await bounded(next);
    result.pendingAfterChange = pending?.name ?? null;
  } else if (scenario === "covered") {
    result.grantError = initial?.grant({ ...batch, lifetime: "session" }, ["bash"]) ?? null;
    await flush(); result.first = await bounded(first); result.next = await bounded(next);
    result.pendingAfterGrant = pending?.name ?? null;
  } else {
    initial?.resolve("once"); await flush();
    result.first = await bounded(first);
    result.nextName = pending?.name;
    result.uniqueIds = typeof initial?.id === "string" && typeof pending?.id === "string" && initial.id !== pending.id;
    pending?.resolve("deny"); result.next = await bounded(next);
  }
  result.persisted = manager.getSummary().find(group => group.label === "project grants")?.rules.length ?? 0;
  console.log(JSON.stringify(result));
`

const componentFixture = String.raw`
  import { mock } from "bun:test";
  import * as React from "react";
  const values = []; let position = 0, input;
  mock.module("react", () => ({ ...React,
    useState: initial => {
      const index = position++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], value => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
    useRef: value => ({ current: value }), useEffect() {},
  }));
  mock.module("ink", () => ({ Box: "Box", Text: "Text", useInput: (callback, options) => { if (options?.isActive !== false) input = callback; } }));
  mock.module("./src/ui/dialog-frame.js", () => ({ useHideNativeCursor() {} }));
  const { ApprovalBar } = await import("./src/ui/dialog-approval.tsx");
  const chosen = [];
  let props = { toolName: "write_file", args: { path: "src/fixture.txt", content: "fixture" },
    allowScope: true, onChoose: value => chosen.push(value), onGrant() {}, availableTools: ["write_file", "bash"] };
  const render = () => { position = 0; input = undefined; return ApprovalBar(props); };
  render(); input("g", {});
  const before = render();
  props = { ...props, toolName: "bash", args: { command: "printf fixture", dangerouslyDisableSandbox: true }, allowScope: false };
  const after = render();
  const text = node => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(text).join(" ");
    return node?.props ? text(node.props.children) : "";
  };
  input?.("1", {});
  console.log(JSON.stringify({ customizedBefore: before.type.name === "ToolGrantDialog",
    customizedAfter: after.type.name === "ToolGrantDialog", text: text(after), chosen }));
`

function run(scenario: string, fixture = hookFixture) {
  const root = mkdtempSync(join(tmpdir(), "zap-approval-review-"))
  try {
    const child = spawnSync(process.execPath, ["-e", fixture], {
      encoding: "utf8", cwd: process.cwd(), timeout: 5000,
      env: { ...process.env, ZAPCODE_DATA_DIR: root, SCENARIO: scenario },
    })
    expect(child.status).toBe(0)
    expect(child.stderr).toBe("")
    return JSON.parse(child.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe("shared host approval requests", () => {
  it("queues MCP sampling behind a waiting tool without losing either response", () => {
    const result = run("fifo")
    expect(result.keptFirst).toBe(true)
    expect(result.first).toBe(true)
    expect(result.nextName).toBe("mcp_sampling:fixture")
    expect(result.uniqueIds).toBe(true)
    expect(result.next).toMatchObject({ approved: false })
  })
  it("settles a queued cancellation without clearing the active prompt", () => {
    const result = run("queued-cancel")
    expect(result.keptFirst).toBe(true)
    expect(result.next).not.toBe("unsettled")
    expect(result.next).not.toBe(true)
    expect(result.keptAfterCancel).toBe(true)
    expect(result.first).toBe(true)
  })
  for (const scenario of ["active-cancel", "double"]) {
    it(`${scenario} leaves the next prompt usable and prevents stale grant writes`, () => {
      const result = run(scenario)
      expect(result.keptFirst).toBe(true)
      expect(result.first).not.toBe("unsettled")
      expect(result.nextName).toBe("mcp_sampling:fixture")
      expect(result.keptAfterStale).toBe(true)
      expect(result.next).toBe(true)
      expect(result.persisted).toBe(0)
    })
  }
  it("expires old-session queued approvals instead of transferring their consent", () => {
    const result = run("session-change")
    expect(result.first).not.toBe(true)
    expect(result.first).not.toBe("unsettled")
    expect(result.next).not.toBe(true)
    expect(result.next).not.toBe("unsettled")
    expect(result.pendingAfterChange).toBeNull()
    expect(result.persisted).toBe(0)
  })
  it("rechecks queued calls after a preceding authorization covers them", () => {
    const result = run("covered")
    expect(result.keptFirst).toBe(true)
    expect(result.grantError).toBeNull()
    expect(result.first).toBe(true)
    expect(result.next).toBe(true)
    expect(result.pendingAfterGrant).toBeNull()
  })
})

it("exits a previous customization when a request becomes once-only", () => {
  const result = run("component", componentFixture)
  expect(result.customizedBefore).toBe(true)
  expect(result.customizedAfter).toBe(false)
  expect(result.text).toContain("Runs outside the OS sandbox")
  expect(result.text).toContain("this once")
  expect(result.chosen).toEqual(["once"])
})
