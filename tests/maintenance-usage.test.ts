import { expect, it } from "bun:test";
import { recordMaintenanceUsage } from "../src/agent/maintenanceUsage.js";
import { parseLatestUsageJsonl, parseUsageJournalJsonl } from "../src/session.js";
it("journals maintenance without replacing the main request's context calibration", () => {
  const rows = [{ type: "usage", total: 500, localEstimateAtTime: 400, output: 10 }];
  recordMaintenanceUsage({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50 }, (total, localEstimateAtTime, output, detail) => {
    rows.push({ type: "usage", total, localEstimateAtTime, output, ...detail });
  });
  const raw = rows.map(row => JSON.stringify(row)).join("\n");
  expect(parseUsageJournalJsonl(raw)).toHaveLength(2);
  expect(parseUsageJournalJsonl(raw)[1]).toMatchObject({ purpose: "maintenance", total: 150, output: 20 });
  expect(parseLatestUsageJsonl(raw)?.total).toBe(500);
});
