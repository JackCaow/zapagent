import type { WatchTimelineItem } from "./protocol.js";

/** Snapshot replacement can reuse sequence IDs. Refresh both visible metadata
 * and the click target instead of retaining the original item's closure. */
export function updateTimelineRow(row: HTMLButtonElement, item: WatchTimelineItem, select: (id: string) => void): void {
  row.querySelector("time")!.textContent = new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false });
  row.querySelector(".badge")!.textContent = item.kind;
  row.onclick = () => { if (item.nodeId) select(item.nodeId); };
}
