import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Real hooks/tools/executor, isolated from the suite's React and app singletons.
// No provider calls or real configuration writes.
const fixture = String.raw`
  import { mock } from "bun:test";
  import { strict as assert } from "node:assert";
  let pending = null, cleanup, updates = 0, writes = 0;
  mock.module("react", () => ({
    useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }),
    useState: () => [null, value => { pending = value; updates++; }],
    useEffect: effect => { cleanup = effect(); },
  }));
  mock.module("./src/config.ts", () => ({ saveAppConfig: () => { writes++; } }));
  mock.module("./src/session.ts", () => ({ configPath: "/unused-fixture-config" }));
  const { useAskUser } = await import("./src/hooks/useAskUser.ts");
  const { usePlanMode } = await import("./src/hooks/usePlanMode.ts");
  const { askUserQuestionTool } = await import("./zapsdk/builtin-tools/ask-user.ts");
  const { exitPlanModeTool } = await import("./zapsdk/builtin-tools/plan-mode.ts");
  const { ToolExecutor } = await import("./zapsdk/tools/executor.ts");
  const { ToolRegistry } = await import("./zapsdk/tools/registry.ts");
  const configRef = { current: { permissionMode: "bypassPermissions" } };
  const kind = process.env.KIND, scenario = process.env.SCENARIO;
  const cb = kind === "ask" ? useAskUser().askUserCallbacks
    : usePlanMode({ configRef, setConfig: next => { configRef.current = next; } }).planCallbacks;
  if (kind === "plan") { cb.enter(); assert.equal(configRef.current.permissionMode, "plan"); }
  const initialWrites = writes;
  const questions = [{ question: "Choose?", options: [{ label: "A" }, { label: "B" }] }];
  const answer = kind === "ask" ? [{ question: "Choose?", answers: ["A"] }] : { kind: "approve" };
  const request = signal => kind === "ask" ? cb.ask(questions, signal) : cb.requestExit("A plan", signal);
  const cancelled = result => kind === "ask" ? assert.equal(result, null) : assert.equal(result.approved, false);
  const controller = new AbortController();
  const signal = controller.signal;
  const listeners = new Set();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => { if (type === "abort") listeners.add(listener); add(type, listener, options); };
  signal.removeEventListener = (type, listener, options) => { if (type === "abort") listeners.delete(listener); remove(type, listener, options); };
  if (scenario === "executor-abort" || scenario === "deadline") {
    const tool = kind === "ask" ? askUserQuestionTool({ callbacks: cb }) : exitPlanModeTool({ callbacks: cb });
    const registry = new ToolRegistry(); registry.register(tool);
    const run = new ToolExecutor(registry).execute(tool.definition.name,
      kind === "ask" ? { questions } : { plan: "A plan" }, signal,
      scenario === "deadline" ? { deadlineAtMs: Date.now() + 100 } : undefined);
    for (let i = 0; i < 100 && !pending; i++) await Bun.sleep(1);
    assert(pending, "interaction opened");
    const old = pending;
    if (scenario === "executor-abort") controller.abort();
    const result = await run;
    assert.equal(result.failure.code, scenario === "deadline" ? "DEADLINE_EXCEEDED" : "CANCELLED");
    assert.equal(pending, null);
    old.resolve(answer);
    await Promise.resolve();
    assert.equal(writes, initialWrites);
  } else {
    const first = request(signal);
    const old = pending;
    assert(old);
    if (scenario === "abort") {
      controller.abort(); cancelled(await first); assert.equal(pending, null);
      old.resolve(answer); await Promise.resolve(); assert.equal(writes, initialWrites);
    } else if (scenario === "unmount") {
      const before = updates;
      cleanup(); cancelled(await first); assert.equal(updates, before);
      old.resolve(answer); cancelled(await request()); assert.equal(updates, before);
      assert.equal(writes, initialWrites);
    } else if (scenario === "replace") {
      const second = request(); const current = pending;
      cancelled(await first);
      controller.abort(); old.resolve(answer); assert.equal(pending, current);
      current.resolve(answer); await second; assert.equal(pending, null);
    } else if (scenario === "pre-aborted") {
      const stopped = new AbortController(); stopped.abort();
      cancelled(await request(stopped.signal)); assert.equal(pending, old);
      old.resolve(answer); await first;
    } else if (scenario === "repeat") {
      old.resolve(answer); await first; assert.equal(pending, null);
      const before = writes;
      if (kind === "plan") cb.enter();
      const second = request(); const current = pending;
      old.resolve(answer); controller.abort(); assert.equal(pending, current);
      current.resolve(answer); await second;
      assert.equal(writes, before + (kind === "plan" ? 2 : 0));
    } else if (scenario === "reject-then-approve") {
      old.resolve(kind === "ask" ? null : { kind: "reject", reason: "Revise" });
      cancelled(await first); assert.equal(writes, initialWrites);
      const second = request(); pending.resolve(answer); const result = await second;
      if (kind === "plan") { assert.equal(result.approved, true); assert.equal(configRef.current.permissionMode, "bypassPermissions"); }
    }
  }
  assert.equal(listeners.size, 0, "abort listener removed after settlement");
  console.log("verified");
`

for (const kind of ["ask", "plan"]) {
  describe(`${kind} interaction lifecycle`, () => {
    for (const scenario of ["executor-abort", "deadline", "abort", "unmount", "replace", "pre-aborted", "repeat", "reject-then-approve"]) {
      it(scenario, () => {
        const root = mkdtempSync(join(tmpdir(), "zap-input-lifecycle-"))
        try {
          const child = spawnSync(process.execPath, ["-e", fixture], {
            cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
            env: { ...process.env, ZAPCODE_DATA_DIR: root, KIND: kind, SCENARIO: scenario },
          })
          expect({ status: child.status, stderr: child.stderr, error: child.error?.message }).toEqual({ status: 0, stderr: "", error: undefined })
          expect(child.stdout).toContain("verified")
        } finally { rmSync(root, { recursive: true, force: true }) }
      })
    }
  })
}
