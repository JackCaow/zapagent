import { closeSync, openSync, readSync } from "node:fs";
import { availableParallelism } from "node:os";
import { posix } from "node:path";

/** Observations of this process, not guarantees about a remote executor or throughput. */
export interface ExecutionCapacityFacts {
  source: "local-process";
  availableParallelism: number | null;
  cgroupV2: "observed" | "partial" | "unavailable" | "not-applicable";
  visibleCpuQuotaCores?: number;
  visibleMemoryLimitBytes?: number;
}

interface CapacityObservationOptions {
  platform?: NodeJS.Platform;
  parallelism?: () => number;
  readText?: (path: string) => string;
}

function readBounded(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(65_537);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > 65_536) throw new Error("capacity observation exceeds read limit");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { closeSync(fd); }
}

function decodePath(path: string): string {
  return path.replace(/\\(040|011|012|134)/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
}

function absolutePath(path: string): boolean {
  return posix.isAbsolute(path) && !path.includes("\0") && !path.split("/").some(p => p === "." || p === "..");
}

function positiveInteger(value: string, minimum = 1): number {
  if (!/^\d+$/.test(value)) throw new Error("invalid capacity value");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error("invalid capacity value");
  return number;
}

/** Read once at local backend selection. Never spawns a process or changes limits.
 * Hidden ancestors, other controllers and later quota changes remain unobserved. */
export function observeLocalExecutionCapacity(options: CapacityObservationOptions = {}): ExecutionCapacityFacts {
  const facts: ExecutionCapacityFacts = { source: "local-process", availableParallelism: null, cgroupV2: "unavailable" };
  try {
    const count = (options.parallelism ?? availableParallelism)();
    if (Number.isSafeInteger(count) && count > 0) facts.availableParallelism = count;
  } catch {}
  if ((options.platform ?? process.platform) !== "linux") {
    facts.cgroupV2 = "not-applicable";
    return facts;
  }
  const read = (path: string) => {
    const value = (options.readText ?? readBounded)(path);
    if (value.length > 65_536) throw new Error("capacity observation exceeds read limit");
    return value;
  };
  try {
    const own = decodePath(read("/proc/self/cgroup").split("\n").find(line => line.startsWith("0::"))?.slice(3) ?? "");
    if (!absolutePath(own)) return facts;
    const mounts = read("/proc/self/mountinfo").split("\n").flatMap(line => {
      const [left, right] = line.split(" - ");
      if (right?.split(" ")[0] !== "cgroup2") return [];
      const fields = left.split(" ");
      const rawRoot = decodePath(fields[3] ?? ""), rawMount = decodePath(fields[4] ?? "");
      if (!absolutePath(rawRoot) || !absolutePath(rawMount)) return [];
      const root = posix.resolve(rawRoot), mount = posix.resolve(rawMount);
      const relative = posix.relative(root, own);
      return relative === ".." || relative.startsWith("../") ? [] : [{ root, mount, relative }];
    }).sort((a, b) => b.root.length - a.root.length);
    const selected = mounts[0];
    if (!selected) return facts;
    let directory = posix.join(selected.mount, selected.relative);
    let complete = true, reachedRoot = false;
    for (let depth = 0; depth < 64; depth++) {
      try {
        const [quota, period, ...rest] = read(posix.join(directory, "cpu.max")).trim().split(/\s+/);
        if (rest.length) throw new Error("invalid cpu.max");
        const interval = positiveInteger(period);
        if (quota !== "max") {
          const cores = positiveInteger(quota) / interval;
          facts.visibleCpuQuotaCores = Math.min(facts.visibleCpuQuotaCores ?? Infinity, cores);
        }
      } catch { complete = false; }
      try {
        const memory = read(posix.join(directory, "memory.max")).trim();
        if (memory !== "max") facts.visibleMemoryLimitBytes = Math.min(
          facts.visibleMemoryLimitBytes ?? Infinity, positiveInteger(memory, 0));
      } catch { complete = false; }
      if (directory === selected.mount) { reachedRoot = true; break; }
      directory = posix.dirname(directory);
    }
    facts.cgroupV2 = complete && reachedRoot ? "observed" : "partial";
  } catch {}
  return facts;
}
