import { describe, expect, it } from "bun:test";
import { ToolBatchScheduler, resourceClaimsConflict } from "../../scheduler/batch-scheduler.js";

const shared = (key: string) => [{ key, mode: "shared" as const }];
const exclusive = (key: string) => [{ key, mode: "exclusive" as const }];

describe("resourceClaimsConflict", () => {
  it("allows shared access to the same resource", () => {
    expect(resourceClaimsConflict(shared("fs:/repo/a"), shared("fs:/repo/a"))).toBe(false);
  });

  it("detects parent/child filesystem conflicts", () => {
    expect(resourceClaimsConflict(shared("fs:/repo/src"), exclusive("fs:/repo/src/a.ts"))).toBe(true);
    expect(resourceClaimsConflict(shared("fs:/repo"), exclusive("fs:/repo/..hidden/a.ts"))).toBe(true);
  });

  it("makes unknown effects globally exclusive", () => {
    expect(resourceClaimsConflict(exclusive("global:unknown"), shared("network:search"))).toBe(true);
  });
});

describe("ToolBatchScheduler", () => {
  it("runs sibling reads in parallel but orders a conflicting write", async () => {
    const scheduler = new ToolBatchScheduler();
    const started: string[] = [];
    let releaseReads!: () => void;
    const readsBlocked = new Promise<void>((resolve) => { releaseReads = resolve; });

    const readA = scheduler.schedule("read-a", shared("fs:/repo/a"), async () => {
      started.push("read-a");
      await readsBlocked;
      return "a";
    });
    const readB = scheduler.schedule("read-b", shared("fs:/repo/a"), async () => {
      started.push("read-b");
      await readsBlocked;
      return "b";
    });
    const write = scheduler.schedule("write", exclusive("fs:/repo/a"), async () => {
      started.push("write");
      return "w";
    });

    await Promise.resolve();
    expect(started).toEqual(["read-a", "read-b"]);
    releaseReads();
    expect(await Promise.all([readA, readB, write])).toEqual(["a", "b", "w"]);
    expect(started).toEqual(["read-a", "read-b", "write"]);
  });

  it("lets unrelated work pass a blocked dependency", async () => {
    const scheduler = new ToolBatchScheduler();
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = scheduler.schedule("first", exclusive("fs:/repo/a"), async () => {
      started.push("first");
      await blocked;
    });
    const second = scheduler.schedule("second", exclusive("fs:/repo/a"), async () => {
      started.push("second");
    });
    const unrelated = scheduler.schedule("unrelated", exclusive("fs:/repo/b"), async () => {
      started.push("unrelated");
    });

    await Promise.resolve();
    expect(started).toEqual(["first", "unrelated"]);
    release();
    await Promise.all([first, second, unrelated]);
    expect(started).toEqual(["first", "unrelated", "second"]);
  });
});
