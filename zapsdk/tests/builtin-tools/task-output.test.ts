import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { taskStatusTool } from "../../builtin-tools/task.js"
import { readFileTool } from "../../builtin-tools/filesystem.js"
import { TaskStore } from "../../tasks/store.js"
import { ToolRegistry } from "../../tools/registry.js"
import { ToolExecutor } from "../../tools/executor.js"
import { buildHeadlessApproval } from "../../../src/headless/approval.js"

const unixTest = process.platform === "win32" ? test.skip : test

describe("owned background output pages", () => {
  let root: string
  let cwd: string
  let store: TaskStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "zap-task-pages-"))
    cwd = join(root, "workspace"); mkdirSync(cwd)
    store = new TaskStore({ outputDir: join(root, "private-output") })
  })
  afterEach(async () => {
    await store.settle(store.list().map(t => t.taskId), 100)
    rmSync(root, { recursive: true, force: true })
  })
  async function fixture(content: string | Buffer) {
    const task = store.spawnShell({ command: "exit 0", cwd })
    await taskStatusTool({ store }).handler({ task_id: task.taskId })
    expect(store.get(task.taskId)?.exitedAt).toBeDefined()
    writeFileSync(task.outputFile, content)
    return task
  }
  function executor() {
    const registry = new ToolRegistry()
    registry.register(taskStatusTool({ store }))
    registry.register(readFileTool({ defaultCwd: cwd }))
    return new ToolExecutor(registry, { cwd,
      onApproval: buildHeadlessApproval({ cwd, permissionMode: "default" }).onApproval })
  }
  test("recovers an early diagnostic through task ID while ordinary log-path reads stay denied", async () => {
    const task = await fixture("EARLY FAILURE\n" + "later output\n".repeat(3000) + "END\n")
    const exec = executor()
    expect((await exec.execute("read_file", { path: task.outputFile })).failure?.code).toBe("POLICY_DENIED")
    const tail = await exec.execute("task_status", { task_id: task.taskId, include_output: true, tail_bytes: 256 })
    expect(JSON.parse(tail.output).tasks[0].outputTail).not.toContain("EARLY FAILURE")
    const page = await exec.execute("task_status", { task_id: task.taskId, output_offset: 0, tail_bytes: 256 })
    expect(page.success).toBe(true)
    expect(JSON.parse(page.output).tasks[0].outputPage).toMatchObject({ offset: 0, next_offset: 256 })
    expect(JSON.parse(page.output).tasks[0].outputPage.content).toContain("EARLY FAILURE")
    expect(page.runtime?.taskObservation?.tasks).toEqual([{ taskId: task.taskId, status: "exited" }])
  })
  test("reassembles Unicode output without lost or repeated characters across byte pages", async () => {
    const content = "a雪🚀".repeat(5000) + "END"
    const task = await fixture(content)
    let offset: number | null = 0
    let restored = ""
    while (offset !== null) {
      const page: NonNullable<ReturnType<TaskStore["readOutputPage"]>> = store.readOutputPage(task.taskId, offset, 257)!
      expect(page.offset).toBe(offset)
      expect(page.byte_length).toBeLessThanOrEqual(260)
      expect(page.byte_length).toBe(Buffer.byteLength(page.content))
      expect(page.content).not.toContain("�")
      restored += page.content
      if (page.next_offset !== null) expect(page.next_offset).toBeGreaterThan(offset)
      offset = page.next_offset
    }
    expect(restored).toBe(content)
  })
  test("uses bounded ranges for large sparse logs and clamps reads beyond EOF", async () => {
    const task = await fixture("HEAD")
    const size = 32 * 1024 * 1024
    truncateSync(task.outputFile, size)
    expect(store.readOutputPage(task.taskId, size - 300, 256)).toMatchObject({
      offset: size - 300, byte_length: 256, next_offset: size - 44, total_bytes: size,
    })
    expect(store.tailOutput(task.taskId, 256)?.length).toBe(256)
    expect(store.readOutputPage(task.taskId, size + 100, 256)).toMatchObject({ offset: size, byte_length: 0, next_offset: null, content: "" })
    expect(store.readOutputPage(task.taskId, 0, Number.MAX_SAFE_INTEGER)?.byte_length).toBeLessThanOrEqual(16 * 1024 + 3)
  })
  test("rejects other stores, path-shaped IDs and unscoped page requests", async () => {
    const task = await fixture("OWNED")
    const other = new TaskStore({ outputDir: join(root, "other") })
    expect(other.readOutputPage(task.taskId, 0)).toBeUndefined()
    const tool = taskStatusTool({ store })
    for (const task_id of ["missing", task.outputFile, "../private-output/" + task.taskId]) {
      expect((await tool.handler({ task_id, output_offset: 0 })).success).toBe(false)
    }
    expect((await tool.handler({ output_offset: 0 })).success).toBe(false)
    for (const offset of [-1, 1.5, Infinity]) expect(() => store.readOutputPage(task.taskId, offset)).toThrow()
  })
  test("rejects replaced output files instead of reading an arbitrary replacement", async () => {
    const task = await fixture("OWNED")
    renameSync(task.outputFile, task.outputFile + ".original")
    writeFileSync(task.outputFile, "FOREIGN")
    const result = await taskStatusTool({ store }).handler({ task_id: task.taskId, output_offset: 0 })
    expect(result.success).toBe(false)
    expect(result.error).toContain("identity changed")
    expect(result.output).not.toContain("FOREIGN")
  })
  unixTest("rejects a symlink substituted for an owned output", async () => {
    const task = await fixture("OWNED")
    const foreign = join(root, "foreign"); writeFileSync(foreign, "FOREIGN")
    unlinkSync(task.outputFile); symlinkSync(foreign, task.outputFile)
    const result = await taskStatusTool({ store }).handler({ task_id: task.taskId, output_offset: 0 })
    expect(result.success).toBe(false)
    expect(result.output).not.toContain("FOREIGN")
  })
  unixTest("holds an incomplete live UTF-8 character and reads it when its remaining bytes arrive", async () => {
    const task = store.spawnShell({ command: "sleep 30", cwd })
    const bytes = Buffer.from("🚀")
    writeFileSync(task.outputFile, bytes.subarray(0, 3))
    const result = await taskStatusTool({ store }).handler({ task_id: task.taskId, output_offset: 0 })
    expect(JSON.parse(result.output).tasks[0]).toMatchObject({ status: "running", outputPage: { content: "", next_offset: 0 } })
    appendFileSync(task.outputFile, bytes.subarray(3))
    expect(store.readOutputPage(task.taskId, 0)).toMatchObject({ content: "🚀", next_offset: null, byte_length: 4 })
    expect(store.get(task.taskId)?.exitedAt).toBeUndefined()
  })
})
