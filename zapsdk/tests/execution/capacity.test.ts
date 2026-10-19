import { describe, expect, it } from "bun:test";
import { observeLocalExecutionCapacity } from "../../execution/capacity.js";

function fixture(own = "/", mounts = "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw") {
  const files: Record<string, string> = {
    "/proc/self/cgroup": `0::${own}\n`, "/proc/self/mountinfo": mounts,
    "/sys/fs/cgroup/cpu.max": "max 100000", "/sys/fs/cgroup/memory.max": "max",
  };
  const reads: string[] = [];
  const observe = () => observeLocalExecutionCapacity({ platform: "linux", parallelism: () => 10,
    readText: path => { reads.push(path); if (!(path in files)) throw new Error("unreadable"); return files[path]; } });
  return { files, reads, observe };
}

describe("local execution capacity observations", () => {
  it("distinguishes visible one-core quota from ten available logical CPUs", () => {
    const { files, observe } = fixture();
    files["/sys/fs/cgroup/cpu.max"] = "100000 100000";
    files["/sys/fs/cgroup/memory.max"] = "2147483648";
    expect(observe()).toEqual({ source: "local-process", availableParallelism: 10, cgroupV2: "observed",
      visibleCpuQuotaCores: 1, visibleMemoryLimitBytes: 2147483648 });
  });

  it("retains the tightest visible ancestor quotas, including fractional CPU", () => {
    const { files, reads, observe } = fixture("/batch/job");
    Object.assign(files, {
      "/sys/fs/cgroup/batch/job/cpu.max": "200000 100000", "/sys/fs/cgroup/batch/job/memory.max": "max",
      "/sys/fs/cgroup/batch/cpu.max": "50000 100000", "/sys/fs/cgroup/batch/memory.max": "1073741824",
    });
    expect(observe()).toMatchObject({ cgroupV2: "observed", visibleCpuQuotaCores: 0.5, visibleMemoryLimitBytes: 1073741824 });
    expect(reads).not.toContain("/sys/fs/cpu.max");
  });

  it("maps a cgroup mount root and decodes its escaped mount path", () => {
    const { files, reads, observe } = fixture("/tenant/job", "1 0 0:1 /tenant /sys/cgroup\\040space/ rw - cgroup2 cgroup rw");
    Object.assign(files, {
      "/sys/cgroup space/job/cpu.max": "100000 100000", "/sys/cgroup space/job/memory.max": "0",
      "/sys/cgroup space/cpu.max": "max 100000", "/sys/cgroup space/memory.max": "max",
    });
    expect(observe()).toMatchObject({ cgroupV2: "observed", visibleCpuQuotaCores: 1, visibleMemoryLimitBytes: 0 });
    expect(reads).not.toContain("/sys/cpu.max");
  });

  it("does not invent an unlimited quota when proc data, v2 or the mount mapping is unavailable", () => {
    for (const own of ["1:cpu:/job", "0::relative", "0::/../escape", "0::/other/job"]) {
      const { files, observe } = fixture("/job", "1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw");
      files["/proc/self/cgroup"] = own;
      expect(observe()).toEqual({ source: "local-process", availableParallelism: 10, cgroupV2: "unavailable" });
    }
    const { files, observe } = fixture(); delete files["/proc/self/cgroup"];
    expect(observe().cgroupV2).toBe("unavailable");
  });

  it("reports partial observations and preserves a known limit if an ancestor is unreadable", () => {
    const { files, observe } = fixture("/job");
    files["/sys/fs/cgroup/job/cpu.max"] = "100000 100000";
    files["/sys/fs/cgroup/job/memory.max"] = "1024";
    delete files["/sys/fs/cgroup/cpu.max"];
    expect(observe()).toMatchObject({ cgroupV2: "partial", visibleCpuQuotaCores: 1, visibleMemoryLimitBytes: 1024 });
  });

  it("rejects malformed, zero, negative and unsafe CPU values", () => {
    for (const value of ["0 100000", "-1 100000", "max", "1 0", "1 1 extra", "9007199254740993 100000"]) {
      const { files, observe } = fixture(); files["/sys/fs/cgroup/cpu.max"] = value;
      expect(observe()).toEqual({ source: "local-process", availableParallelism: 10, cgroupV2: "partial" });
    }
  });

  it("bounds depth and observation text without walking outside the visible mount", () => {
    const { files, observe } = fixture(); files["/proc/self/mountinfo"] = "x".repeat(65_537);
    expect(observe().cgroupV2).toBe("unavailable");
    let reads = 0;
    const deep = observeLocalExecutionCapacity({ platform: "linux", parallelism: () => 4, readText: path => {
      reads++;
      if (path === "/proc/self/cgroup") return "0::/" + Array(100).fill("nested").join("/");
      if (path === "/proc/self/mountinfo") return "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw";
      return path.endsWith("cpu.max") ? "max 100000" : "max";
    } });
    expect(deep.cgroupV2).toBe("partial"); expect(reads).toBe(130);
  });

  it("does not read Linux files on other platforms or guess a failed CPU count", () => {
    const snapshot = observeLocalExecutionCapacity({ platform: "darwin", parallelism: () => { throw new Error("unknown"); },
      readText: () => { throw new Error("must not be read"); } });
    expect(snapshot).toEqual({ source: "local-process", availableParallelism: null, cgroupV2: "not-applicable" });
  });
});
