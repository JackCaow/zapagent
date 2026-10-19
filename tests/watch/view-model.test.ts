import { readFile } from "node:fs/promises";
import { expect, it } from "bun:test";
import { layout, visibleNodes, tone, CARD_HEIGHT } from "../../src/watch/view-model.js";
import type { WatchNode, WatchEdge } from "../../src/watch/protocol.js";
import { buildWatchHtml } from "../../scripts/build-watch.js";
const node = (id: string, extra: Partial<WatchNode> = {}): WatchNode => ({ id, kind: "run", scope: { threadId: "t", turnId: "turn", runId: id }, label: id, status: "running", source: "runtime", coverage: "full", createdAt: 0, updatedAt: 0, elapsedMs: 0, terminal: false, ...extra });
const edge = (from: string, to: string, kind: WatchEdge["kind"] = "owns"): WatchEdge => ({ id: from + to, from, to, kind });
it("lays out nested ownership without dependency-induced reparenting, overlapping siblings or cycles", () => {
  const nodes = [node("root"), node("tool"), node("child"), node("a"), node("b")];
  const edges = [edge("root", "tool"), edge("tool", "child", "spawns"), edge("child", "a"), edge("child", "b")];
  const a = layout(nodes, edges), b = layout(nodes, [...edges, edge("a", "tool", "depends_on"), edge("child", "root")]);
  expect(a.positions).toEqual(b.positions);
  expect(a.positions.get("child")!.x).toBeGreaterThan(a.positions.get("tool")!.x);
  expect(a.positions.get("b")!.y - a.positions.get("a")!.y).toBeGreaterThan(CARD_HEIGHT);
  expect(new Set([...a.positions.values()].map(p => `${p.x},${p.y}`)).size).toBe(nodes.length);
});
it("retains selected and active ownership paths while bounding large histories", () => {
  const nodes = [node("root", { terminal: true }), ...Array.from({ length: 300 }, (_, i) => node(`tool${i}`, { kind: "tool", terminal: true, createdAt: i })), node("active", { createdAt: 301 })];
  const edges = nodes.slice(1).map(n => edge("root", n.id));
  const shown = visibleNodes(nodes, edges, "tool2", 200);
  expect(shown).toHaveLength(200);
  expect(shown.map(n => n.id)).toContain("root"); expect(shown.map(n => n.id)).toContain("tool2"); expect(shown.map(n => n.id)).toContain("active");
});
it("does not animate input waits or present cancelled/unverified outcomes as success", () => {
  expect(tone(node("n", { activity: "waiting_input" }))).toBe("waiting");
  expect(tone(node("n", { status: "waiting_approval" }))).toBe("waiting");
  expect(tone(node("n", { terminal: true, status: "finished" }))).toBe("neutral");
  expect(tone(node("n", { terminal: true, status: "cancelled" }))).toBe("neutral");
  expect(tone(node("n", { observationClosed: true }))).toBe("neutral");
  expect(tone(node("n", { terminal: true, status: "returned", success: false }))).toBe("error");
});
it("ships the current self-contained browser bundle with nonce slots and Motion attribution", async () => {
  const html = await buildWatchHtml();
  expect(html).toBe(await readFile(new URL("../../src/watch/client.html", import.meta.url), "utf8"));
  expect(html).toContain("Copyright (c) 2024"); expect(html).toContain("Copyright (c) 2018 Framer");
  expect(html.match(/nonce="__WATCH_NONCE__"/g)).toHaveLength(2);
  expect(html).not.toMatch(/<(script|link)[^>]+(?:src|href)="https?:/);
});
