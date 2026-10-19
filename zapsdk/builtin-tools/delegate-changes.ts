import type { ExecutionProcessBroker } from "../execution/types.js";
import { createLocalProcessBroker, terminateProcessTreeWithGrace } from "../execution/process.js";

export interface ChangeSummary {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export type Snapshot = Map<string, string>;

const CAP = 50;

function capList(items: string[]): string[] {
  if (items.length <= CAP) return items;
  return [...items.slice(0, CAP), `...and ${items.length - CAP} more`];
}

export async function gitStatusSnapshot(
  cwd: string,
  processBroker: ExecutionProcessBroker = createLocalProcessBroker(),
): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let failed = false;
    let settled = false;
    let child;
    try {
      child = processBroker.spawnCommand(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd },
      );
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", () => { failed = true; });
    const timeout = setTimeout(() => {
      failed = true;
      terminateProcessTreeWithGrace(child);
    }, 5000);
    timeout.unref();
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (failed || code !== 0) {
        resolve(null);
        return;
      }
        const map: Snapshot = new Map();
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const status = line.slice(0, 2);
          const rest = line.slice(3);
          if (rest.includes(" -> ")) {
            const idx = rest.indexOf(" -> ");
            const to = rest.slice(idx + 4);
            map.set(to, status);
          } else {
            map.set(rest, status);
          }
        }
        resolve(map);
    });
  });
}

export function diffSnapshots(
  before: Snapshot | null,
  after: Snapshot | null,
): ChangeSummary | null {
  if (!before || !after) return null;
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, statusAfter] of after) {
    const statusBefore = before.get(path);
    if (statusBefore === undefined) {
      // Brand new in `after`. Discriminate by porcelain code:
      //   "??" = untracked (treat as added new file)
      //   " A" / "A " / "AM" = added to index (added)
      //   " M" / "M " / "MM" = tracked & modified (treat as modified — file
      //     existed pre-call but was clean, so before-snapshot omitted it)
      //   " D" / "D " = deleted (treat as deleted)
      if (statusAfter.startsWith("?") || statusAfter.includes("A")) {
        added.push(path);
      } else if (statusAfter.includes("D")) {
        deleted.push(path);
      } else {
        modified.push(path);
      }
    } else if (statusBefore !== statusAfter) {
      modified.push(path);
    }
  }
  for (const [path] of before) {
    if (!after.has(path)) deleted.push(path);
  }
  return {
    added: capList(added),
    modified: capList(modified),
    deleted: capList(deleted),
    renamed: [],
  };
}

export function formatChangeSummary(
  provider: string,
  cwd: string,
  change: ChangeSummary,
): string {
  const isEmpty =
    change.added.length === 0 &&
    change.modified.length === 0 &&
    change.deleted.length === 0 &&
    change.renamed.length === 0;
  if (isEmpty) return "";

  const lines: string[] = [];
  lines.push(`**Changes by ${provider} (cwd: ${cwd}):**`);
  if (change.modified.length) {
    lines.push(`• Modified (${change.modified.length}): ${change.modified.join(", ")}`);
  }
  if (change.added.length) {
    lines.push(`• Added (${change.added.length}): ${change.added.join(", ")}`);
  }
  if (change.deleted.length) {
    lines.push(`• Deleted (${change.deleted.length}): ${change.deleted.join(", ")}`);
  }
  if (change.renamed.length) {
    lines.push(
      `• Renamed (${change.renamed.length}): ${change.renamed.map((r) => `${r.from} → ${r.to}`).join(", ")}`,
    );
  }
  lines.push("");
  lines.push("Run `git diff` to inspect, or `git checkout -- <path>` to revert specific files.");
  return lines.join("\n");
}
