import { DefaultToolPolicyEngine } from "../../policy/engine.js";
import { isToolAuthorization } from "../../tools/executor.js";
import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import {
  ToolExecutor,
  type ApprovalLifecycleEvent,
} from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

function confirmRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "confirm_write",
      description: "test",
      parameters: z.object({ path: z.string(), content: z.string() }),
      permission: "confirm",
    },
    handler: async () => ({ success: true, output: "ok" }),
  });
  return registry;
}

describe("ToolExecutor approval lifecycle", () => {
  it("persists requested before approved without exposing raw arguments", async () => {
    const events: ApprovalLifecycleEvent[] = [];
    const executor = new ToolExecutor(confirmRegistry(), {
      onApproval: async () => true,
      onApprovalLifecycle: (event) => { events.push(event); },
    });

    const result = await executor.execute(
      "confirm_write",
      { path: "secret.txt", content: "do-not-persist" },
      undefined,
      { sessionId: "thread-1", toolCallId: "tool-1", step: 2 },
    );

    expect(result.success).toBe(true);
    expect(events.map((event) => event.status)).toEqual(["requested", "approved"]);
    expect(events[0]).toMatchObject({
      approvalId: "approval:tool-1",
      toolName: "confirm_write",
      toolCallId: "tool-1",
      sessionId: "thread-1",
      step: 2,
    });
    expect(events[0].argumentsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(events)).not.toContain("do-not-persist");
  });

  it("records denial before returning and keeps composed observers", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const executor = new ToolExecutor(confirmRegistry(), {
      onApproval: async () => false,
      onApprovalLifecycle: (event) => { first.push(event.status); },
    }).withApprovalLifecycle((event) => { second.push(event.status); });

    const result = await executor.execute(
      "confirm_write",
      { path: "a.txt", content: "x" },
      undefined,
      { toolCallId: "tool-2" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("approval not granted");
    expect(result.error).not.toContain("user");
    expect(first).toEqual(["requested", "denied"]);
    expect(second).toEqual(first);
  });

  for (const source of ["policy", "approval"] as const) {
    it(`retains ${source} denial without invoking the handler`, async () => {
      const events: ApprovalLifecycleEvent[] = [];
      const reason = source === "policy" ? "plan-mode is read-only" : "user declined approval";
      const executor = new ToolExecutor(confirmRegistry(), {
        onApproval: async () => ({ approved: false, source, reason }),
        onApprovalLifecycle: event => { events.push(event); },
      });
      const result = await executor.execute("confirm_write", { path: "a.txt", content: "x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain(reason);
      expect(result.failure).toMatchObject({ code: "POLICY_DENIED", source, retryable: false });
      expect(events.map(event => event.status)).toEqual(["requested", "denied"]);
      expect(events[1].error).toBe(reason);
      expect(result.runtime?.execution).toBeUndefined();
    });
  }

  it("does not grant approval for a truthy malformed response", async () => {
    const executor = new ToolExecutor(confirmRegistry(), { onApproval: async () => ({ approved: true } as any) });
    const result = await executor.execute("confirm_write", { path: "a.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.failure?.code).toBe("POLICY_DENIED");
  });
});

describe("ToolExecutor execution lifecycle", () => {
  it("persists started before invoking the handler and then records completion", async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    registry.register({
      definition: {
        name: "write",
        description: "test",
        parameters: z.object({ value: z.string() }),
      },
      handler: async () => {
        order.push("handler");
        return { success: true, output: "ok" };
      },
    });
    const executor = new ToolExecutor(registry, {
      onExecutionLifecycle: async (event) => {
        order.push(event.status);
      },
    });

    const result = await executor.execute(
      "write",
      { value: "secret" },
      undefined,
      { toolCallId: "tool-3" },
    );

    expect(result.success).toBe(true);
    expect(order).toEqual(["started", "handler", "completed"]);
  });

  it("fails closed before handler effects when started persistence fails", async () => {
    const registry = new ToolRegistry();
    let handlerRan = false;
    registry.register({
      definition: {
        name: "write",
        description: "test",
        parameters: z.object({}),
      },
      handler: async () => {
        handlerRan = true;
        return { success: true, output: "ok" };
      },
    });
    const executor = new ToolExecutor(registry, {
      onExecutionLifecycle: async (event) => {
        if (event.status === "started") throw new Error("state disk unavailable");
      },
    });

    await expect(executor.execute("write", {}, undefined, { toolCallId: "tool-4" }))
      .rejects.toThrow("state disk unavailable");
    expect(handlerRan).toBe(false);
  });
});


describe("approval grant activation", () => {
  it("starts the default grant lifetime after a delayed affirmative approval", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const executor = new ToolExecutor(confirmRegistry(), {
        policyEngine: new DefaultToolPolicyEngine({ grantTtlMs: 100 }),
        onApproval: async () => { now += 1000; return true; },
      });
      const authorization = await executor.authorize("confirm_write", { path: "a", content: "x" });
      if (!isToolAuthorization(authorization)) throw new Error("missing authorization");
      expect(authorization.grant.expiresAt).toBe(now + 100);
      expect((await executor.executeAuthorized(authorization)).success).toBe(true);
      now += 101;
      expect((await executor.executeAuthorized(authorization)).error).toContain("authorization expired");
    } finally { clock.mockRestore(); }
  });
  it("keeps an absolute custom-policy expiry even when the user approves later", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const defaults = new DefaultToolPolicyEngine({ grantTtlMs: 100 });
      const executor = new ToolExecutor(confirmRegistry(), {
        policyEngine: { evaluate(request) {
          const decision = defaults.evaluate(request);
          if (decision.decision === "ask") delete decision.request.grantTtlMs;
          return decision;
        } },
        onApproval: async () => { now += 1000; return true; },
      });
      const result = await executor.execute("confirm_write", { path: "a", content: "x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("authorization expired");
    } finally { clock.mockRestore(); }
  });
  it("does not extend a task deadline when approval arrives after that deadline", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const executor = new ToolExecutor(confirmRegistry(), { onApproval: async () => { now += 1000; return true; } });
      const result = await executor.execute("confirm_write", { path: "a", content: "x" }, undefined, { deadlineAtMs: now + 100 });
      expect(result.failure?.code).toBe("DEADLINE_EXCEEDED");
    } finally { clock.mockRestore(); }
  });
  it("does not activate a grant after denial or cancellation", async () => {
    const controller = new AbortController();
    const cancelled = new ToolExecutor(confirmRegistry(), { onApproval: async () => { controller.abort(); return true; } });
    expect((await cancelled.execute("confirm_write", { path: "a", content: "x" }, controller.signal)).failure?.code).toBe("CANCELLED");
    const denied = new ToolExecutor(confirmRegistry(), { onApproval: async () => false });
    expect((await denied.execute("confirm_write", { path: "a", content: "x" })).failure?.code).toBe("POLICY_DENIED");
  });
});


it("activates queued approvals independently after their own affirmative decision", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let approveFirst!: (approved: boolean) => void;
  let requested!: () => void;
  const entered = new Promise<void>(resolve => { requested = resolve; });
  let calls = 0;
  try {
    const executor = new ToolExecutor(confirmRegistry(), {
      policyEngine: new DefaultToolPolicyEngine({ grantTtlMs: 100 }),
      onApproval: async () => {
        if (++calls === 1) { requested(); return new Promise<boolean>(resolve => { approveFirst = resolve; }); }
        now += 1000; return true;
      },
    });
    const first = executor.authorize("confirm_write", { path: "a", content: "x" });
    await entered;
    const second = executor.authorize("confirm_write", { path: "b", content: "y" });
    now += 1000; approveFirst(true);
    const [one, two] = await Promise.all([first, second]);
    expect(calls).toBe(2);
    if (!isToolAuthorization(one) || !isToolAuthorization(two)) throw new Error("missing queued authorizations");
    expect(two.grant.expiresAt).toBe(now + 100);
    expect((await executor.executeAuthorized(two)).success).toBe(true);
    // Queue time is excluded, but a completed authorization still expires if
    // scheduling waits too long after approval.
    now += 101;
    expect((await executor.executeAuthorized(two)).error).toContain("authorization expired");
  } finally { clock.mockRestore(); }
});
