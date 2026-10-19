import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import {
  appendMemoryReadStalenessNote,
  isMemoryReadPath,
  isPathInsideDirectory,
  type MemoryReadPostProcessDeps,
} from "../../src/agent/memoryReadPostProcess.js"

describe("memory read post-process", () => {
  it("appends staleness notes for global personal memory reads", async () => {
    const globalMemoryDir = "/tmp/zap-global-memory"
    const deps = fakeDeps({
      projectMemoryDir: "/tmp/zap-project-memory",
      globalMemoryDir,
      note: "\n\n[stale global memory note]",
    })

    const result = await appendMemoryReadStalenessNote(
      "read_file",
      { path: join(globalMemoryDir, "reply_style.md") },
      { success: true, output: "body\n" },
      deps,
    )

    expect(result.output).toContain("body")
    expect(result.output).toContain("stale global memory note")
  })

  it("keeps project memory reads covered by the existing AutoMemory path check", async () => {
    const projectMemoryDir = "/tmp/zap-project-memory"
    const deps = fakeDeps({
      projectMemoryDir,
      globalMemoryDir: "/tmp/zap-global-memory",
      note: "\n\n[stale project memory note]",
    })

    const result = await appendMemoryReadStalenessNote(
      "read_file",
      { path: join(projectMemoryDir, "project_rules.md") },
      { success: true, output: "rules\n" },
      deps,
    )

    expect(result.output).toContain("stale project memory note")
  })

  it("does not append notes for unrelated reads or failed tool results", async () => {
    const deps = fakeDeps({
      projectMemoryDir: "/tmp/zap-project-memory",
      globalMemoryDir: "/tmp/zap-global-memory",
      note: "\n\n[stale]",
    })
    const outside = await appendMemoryReadStalenessNote(
      "read_file",
      { path: "/tmp/other/file.md" },
      { success: true, output: "body\n" },
      deps,
    )
    const failed = await appendMemoryReadStalenessNote(
      "read_file",
      { path: "/tmp/zap-global-memory/reply_style.md" },
      { success: false, output: "", error: "missing" },
      deps,
    )
    const nonRead = await appendMemoryReadStalenessNote(
      "list_tree",
      { path: "/tmp/zap-global-memory" },
      { success: true, output: "reply_style.md\n" },
      deps,
    )

    expect(outside.output).toBe("body\n")
    expect(failed.output).toBe("")
    expect(nonRead.output).toBe("reply_style.md\n")
  })

  it("keeps successful memory reads when staleness diagnostics fail", async () => {
    const deps: MemoryReadPostProcessDeps = {
      globalMemoryDir: "/tmp/zap-global-memory",
      autoMemory: {
        isMemoryPath(filePath) {
          return isPathInsideDirectory("/tmp/zap-project-memory", filePath)
        },
        async stalenessNote() {
          throw new Error("stat failed")
        },
      },
    }

    const result = await appendMemoryReadStalenessNote(
      "read_file",
      { path: "/tmp/zap-global-memory/reply_style.md" },
      { success: true, output: "body\n" },
      deps,
    )

    expect(result).toEqual({ success: true, output: "body\n" })
  })

  it("does not treat sibling directories as global memory", () => {
    const deps = fakeDeps({
      projectMemoryDir: "/tmp/project-memory",
      globalMemoryDir: "/tmp/memory",
      note: "",
    })

    expect(isMemoryReadPath("/tmp/memory/reply_style.md", deps)).toBe(true)
    expect(isMemoryReadPath("/tmp/memory-other/reply_style.md", deps)).toBe(false)
    expect(isPathInsideDirectory("/tmp/memory", "/tmp/memory-other/reply_style.md")).toBe(false)
  })
})

function fakeDeps(options: {
  projectMemoryDir: string
  globalMemoryDir: string
  note: string
}): MemoryReadPostProcessDeps {
  return {
    globalMemoryDir: options.globalMemoryDir,
    autoMemory: {
      isMemoryPath(filePath) {
        return isPathInsideDirectory(options.projectMemoryDir, filePath)
      },
      async stalenessNote() {
        return options.note
      },
    },
  }
}
