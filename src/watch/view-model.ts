import type { WatchEdge, WatchNode } from "./protocol.js";

export type Tone = "active" | "waiting" | "error" | "done" | "neutral";
export function tone(node: Pick<WatchNode, "status" | "terminal" | "observationClosed" | "success" | "activity">): Tone {
  if (node.status === "failed" || node.status === "blocked" || node.success === false) return "error";
  if (node.observationClosed) return "neutral";
  if (node.terminal) return ["completed", "returned"].includes(node.status) ? "done" : "neutral";
  if (/^waiting_|^(retrying|scheduled|ready_to_merge|idle|submitted|authorized)$/.test(node.status) || /^waiting_/.test(node.activity ?? "")) return "waiting";
  return "active";
}

/** Keep selected/active nodes with their ownership ancestors, within a hard DOM bound. */
export function visibleNodes(nodes: WatchNode[], edges: WatchEdge[], selected: string, limit = 200): WatchNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const parents = new Map(edges.filter(e => e.kind !== "depends_on").map(e => [e.to, e.from]));
  const keep = new Set<string>();
  const priority = [...nodes].sort((a, b) => Number(b.id === selected) - Number(a.id === selected)
    || Number(!b.terminal && !b.observationClosed) - Number(!a.terminal && !a.observationClosed)
    || b.createdAt - a.createdAt);
  for (const n of priority) {
    const chain: string[] = [], seen = new Set<string>();
    let id: string | undefined = n.id;
    while (id && byId.has(id) && !seen.has(id) && !keep.has(id)) {
      seen.add(id); chain.push(id); id = parents.get(id);
    }
    if (keep.size + chain.length <= limit) for (const item of chain) keep.add(item);
  }
  return nodes.filter(n => keep.has(n.id));
}

export interface Point { x: number; y: number }
export const CARD_WIDTH = 218, CARD_HEIGHT = 112;
/** Ownership forms the hierarchy; dependency links never move a node into another branch. */
export function layout(nodes: WatchNode[], edges: WatchEdge[]) {
  const ids = new Set(nodes.map(n => n.id)), parents = new Map<string, string>();
  for (const e of edges) {
    if (e.kind === "depends_on" || !ids.has(e.from) || !ids.has(e.to) || parents.has(e.to)) continue;
    let cursor: string | undefined = e.from;
    const seen = new Set([e.to]);
    while (cursor && !seen.has(cursor)) { seen.add(cursor); cursor = parents.get(cursor); }
    if (!cursor) parents.set(e.to, e.from);
  }
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const parent = parents.get(n.id);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), n.id]);
  }
  const positions = new Map<string, Point>();
  let row = 0, maxDepth = 0;
  function visit(id: string, depth: number): number {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(id) ?? [];
    const rows = kids.map(child => visit(child, depth + 1));
    const y = rows.length ? (rows[0] + rows[rows.length - 1]) / 2 : row++;
    positions.set(id, { x: 36 + depth * 284, y: 36 + y * 146 });
    return y;
  }
  for (const n of nodes) if (!parents.has(n.id)) visit(n.id, 0);
  return { positions, width: 72 + maxDepth * 284 + CARD_WIDTH, height: Math.max(300, row * 146 + 40) };
}

export function edgePath(a: Point, b: Point, dependency = false): string {
  const x1 = a.x + CARD_WIDTH, y1 = a.y + CARD_HEIGHT / 2, x2 = b.x, y2 = b.y + CARD_HEIGHT / 2;
  const bend = dependency ? Math.max(55, Math.abs(x2 - x1) / 2) : 36;
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}
