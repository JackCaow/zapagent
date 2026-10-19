import { expect, test } from "bun:test";
import { snapshotDescendants, type ProcessTable } from "../../execution/process-tree.js";

test("tracks only descendants, including a reparented survivor and its new children", () => {
  const before: ProcessTable = new Map([
    [10, { parentPid: 1, birth: "root" }],
    [11, { parentPid: 10, birth: "wrapper" }],
    [12, { parentPid: 11, birth: "worker" }],
    [20, { parentPid: 1, birth: "unrelated" }],
  ]);
  const owned = snapshotDescendants(10, before, new Map());
  expect([...owned.keys()]).toEqual([11, 12]);
  const after: ProcessTable = new Map([
    [12, { parentPid: 1, birth: "worker" }],
    [13, { parentPid: 12, birth: "new-worker" }],
    [20, { parentPid: 1, birth: "unrelated" }],
  ]);
  expect([...snapshotDescendants(undefined, after, owned).keys()]).toEqual([12, 13]);
});

test("does not signal a reused descendant PID or its new children", () => {
  const table: ProcessTable = new Map([
    [12, { parentPid: 1, birth: "replacement" }],
    [13, { parentPid: 12, birth: "unrelated-child" }],
  ]);
  expect(snapshotDescendants(undefined, table, new Map([[12, "original"]])).size).toBe(0);
});
