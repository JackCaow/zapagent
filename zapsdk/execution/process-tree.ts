import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

interface ProcessIdentity {
  parentPid: number;
  birth: string;
}

export type ProcessTable = Map<number, ProcessIdentity>;

/** Read process ancestry without command lines or a dependency on ps in Linux images. */
export function readProcessTable(): ProcessTable {
  const table: ProcessTable = new Map();
  try {
    if (process.platform === "linux") {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          // comm can contain spaces and parentheses. Fields after its closing
          // parenthesis start at field 3; starttime is field 22.
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          if (fields.length >= 20) table.set(Number(entry), { parentPid: Number(fields[1]), birth: fields[19]! });
        } catch { /* The process may exit while /proc is being read. */ }
      }
    } else if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
        encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" },
      });
      if (result.status === 0) {
        for (const line of result.stdout.split("\n")) {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
          if (match) table.set(Number(match[1]), { parentPid: Number(match[2]), birth: match[3]! });
        }
      }
    }
  } catch { /* Process-group signalling remains available if enumeration fails. */ }
  return table;
}

/** Retain identities across TERM/KILL so reparenting does not lose ownership.
 * Birth markers reject observed PID reuse; this is best-effort teardown, not
 * containment against processes that escape before the first snapshot. */
export function snapshotDescendants(
  rootPid: number | undefined,
  table: ProcessTable,
  previous: ReadonlyMap<number, string>,
): Map<number, string> {
  const owned = new Map<number, string>();
  const queue: number[] = [];
  if (rootPid !== undefined && table.has(rootPid)) queue.push(rootPid);
  for (const [pid, birth] of previous) {
    if (table.get(pid)?.birth === birth) {
      owned.set(pid, birth);
      queue.push(pid);
    }
  }
  const children = new Map<number, number[]>();
  for (const [pid, info] of table) {
    const siblings = children.get(info.parentPid) ?? [];
    siblings.push(pid);
    children.set(info.parentPid, siblings);
  }
  const visited = new Set<number>();
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    for (const pid of children.get(parent) ?? []) {
      owned.set(pid, table.get(pid)!.birth);
      queue.push(pid);
    }
  }
  return owned;
}
