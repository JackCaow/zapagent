import { expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { updateTimelineRow } from "../../src/watch/timeline.js";

it("refreshes a reused event row after snapshot sequence IDs restart", () => {
  const { document } = parseHTML('<button><time></time><span class="badge"></span></button>');
  const row = document.querySelector("button")!;
  const selected: string[] = [];
  const item = { id: 1, at: 1000, nodeId: "old", kind: "started", status: "running" };
  updateTimelineRow(row, item, id => selected.push(id));
  row.click();
  updateTimelineRow(row, { ...item, at: 2000, nodeId: "new", kind: "returned" }, id => selected.push(id));
  row.click();
  expect(selected).toEqual(["old", "new"]);
  expect(row.querySelector("time")!.textContent).toBe(new Date(2000).toLocaleTimeString("zh-CN", { hour12: false }));
  expect(row.querySelector(".badge")!.textContent).toBe("returned");
  updateTimelineRow(row, { ...item, nodeId: undefined }, id => selected.push(id));
  row.click();
  expect(selected).toEqual(["old", "new"]);
});
