import { expect, it } from "bun:test";
import { benchmarkContextMaintenance } from "../../../scripts/bench-context-maintenance.js";

it("reduces input on the same real tool trajectory with one maintenance rewrite followed by append-only prefixes", async () => {
  const { scenarios: [baseline, prune] } = await benchmarkContextMaintenance();
  expect(baseline.quality && prune.quality).toBe(true);
  expect(baseline.tools).toBe(4); expect(prune.tools).toBe(4);
  expect(prune.totalInput).toBeLessThan(baseline.totalInput);
  // This short cached workload pays a cold-prefix rebuild after pruning.
  // Smaller total context must not be presented as guaranteed cheaper fresh input.
  expect(prune.fresh).toBeGreaterThan(baseline.fresh);
  expect(prune.mainCalls).toBe(baseline.mainCalls);
  expect(prune.maintenanceCalls).toBe(0);
  expect(prune.pruneEvents).toHaveLength(1);
  expect(prune.prefixChanges.map((row: any) => row.change)).toEqual(["initial", "rewrite", "append", "append", "append"]);
  expect(prune.prefixChanges[1].reason).toBe("prune");
  expect(baseline.prefixChanges.map((row: any) => row.change)).toEqual(["initial", "append", "append", "append", "append"]);
}, 10000);
