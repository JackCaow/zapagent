import { describe, expect, it } from "vitest";
import { applyTaskEvent, flushAgentOutput, newTurnView, reconcileTaskState } from "./agent";
import type { AgentSession } from "./types";

const task: AgentSession = {
  id: "turn-1",
  computer_id: "cloud-smoke",
  session_id: "session-1",
  state: "running",
};
const encoded = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));

describe("agent stream projection", () => {
  it("buffers incomplete JSONL before displaying streamed assistant text", () => {
    let view = newTurnView(task, "写一份报告");
    view = applyTaskEvent(view, { type: "exec.output", data: encoded('{"type":"assistant","delta":"你好') });
    expect(view.assistant).toBe("");
    view = applyTaskEvent(view, { type: "exec.output", data: encoded('，世界"}\n') });
    expect(view.assistant).toBe("你好，世界");
  });

  it("projects tool lifecycle and waits for cloud completion after the Agent result", () => {
    let view = newTurnView(task);
    view = applyTaskEvent(view, { type: "exec.output", data: encoded('{"type":"tool_use","id":"call-1","name":"Bash","input":"pwd"}\n') });
    view = applyTaskEvent(view, { type: "exec.output", data: encoded('{"type":"tool_result","tool_use_id":"call-1","ok":true,"content":"/workspace"}\n{"type":"result","ok":true,"text":"完成"}\n') });
    view = flushAgentOutput(view);
    expect(view.tools).toEqual([{ id: "call-1", name: "Bash", summary: "/workspace", status: "succeeded" }]);
    expect(view.result).toBe("完成");
    expect(view.state).toBe("running");
    expect(view.artifactDelivery).toBe("pending");
    view = reconcileTaskState(view, "succeeded");
    expect(view.state).toBe("succeeded");
  });

  it("keeps a live turn connected after daemon exec.result until cloud completion", () => {
    let view = newTurnView(task, "你好");
    view = applyTaskEvent(view, { type: "task.created", cursor: 1 });
    view = applyTaskEvent(view, { type: "exec.scheduled", cursor: 2 });
    view = applyTaskEvent(view, { type: "exec.started", cursor: 3 });
    view = applyTaskEvent(view, { type: "exec.result", ok: true });

    expect(view.state).toBe("running");
    expect(view.artifactDelivery).toBe("pending");
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "正在整理交付结果", state: "running" });

    view = reconcileTaskState(view, "succeeded");
    expect(view.timeline.filter((item) => item.kind === "lifecycle" && item.state === "running")).toHaveLength(0);
    expect(view.timeline).toContainEqual(expect.objectContaining({ kind: "lifecycle", label: "运行配置已加载", state: "succeeded" }));
    expect(view.timeline).toContainEqual(expect.objectContaining({ kind: "lifecycle", label: "Agent 已完成处理", state: "succeeded" }));
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "任务已完成", state: "succeeded" });
  });

  it("keeps only the current lifecycle stage running", () => {
    let view = newTurnView(task, "你好");
    view = applyTaskEvent(view, { type: "task.created", cursor: 1 });
    expect(runningLifecycleLabels(view)).toEqual(["任务已提交"]);

    view = applyTaskEvent(view, { type: "task.started", cursor: 2 });
    expect(runningLifecycleLabels(view)).toEqual([]);
    view = applyTaskEvent(view, { type: "exec.scheduled", cursor: 3 });
    expect(runningLifecycleLabels(view)).toEqual(["正在加载运行配置"]);
    view = applyTaskEvent(view, { type: "exec.started", cursor: 4 });
    expect(runningLifecycleLabels(view)).toEqual(["Agent 开始处理"]);

    view = applyTaskEvent(view, { type: "exec.output", data: encoded('{"type":"tool_use","id":"call-1","name":"Bash","input":"pwd"}\n') });
    expect(runningLifecycleLabels(view)).toEqual([]);
    expect(view.timeline.filter((item) => item.kind === "tool" && item.status === "running")).toHaveLength(1);
  });

  it("uses an authoritative terminal session state to settle buffered UI state", () => {
    let view = newTurnView(task, "你好");
    view = applyTaskEvent(view, { type: "exec.scheduled", cursor: 1 });
    view = applyTaskEvent(view, { type: "exec.started", cursor: 2 });
    view = reconcileTaskState(view, "succeeded");

    expect(view.state).toBe("succeeded");
    expect(runningLifecycleLabels(view)).toEqual([]);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "任务已完成", state: "succeeded" });
  });

  it("marks only the active lifecycle stage failed when a task terminates", () => {
    let view = newTurnView(task, "你好");
    view = applyTaskEvent(view, { type: "task.created", cursor: 1 });
    view = applyTaskEvent(view, { type: "exec.scheduled", cursor: 2 });
    view = applyTaskEvent(view, { type: "exec.started", cursor: 3 });
    view = applyTaskEvent(view, { type: "exec.result", ok: false, cursor: 4 });

    const lifecycle = view.timeline.filter((item) => item.kind === "lifecycle");
    expect(lifecycle.filter((item) => item.state === "running")).toHaveLength(0);
    expect(lifecycle).toContainEqual(expect.objectContaining({ label: "任务已提交", state: "succeeded" }));
    expect(lifecycle).toContainEqual(expect.objectContaining({ label: "Agent 处理未完成", state: "failed" }));
  });

  it("keeps one terminal card when output already reported completion", () => {
    let view = newTurnView(task, "你好");
    view = applyTaskEvent(view, { type: "exec.output", data: encoded('{"type":"result","ok":true,"text":"完成"}\n') });
    view = applyTaskEvent(view, { type: "exec.result", ok: true, cursor: 8 });
    view = reconcileTaskState(view, "succeeded");

    expect(view.timeline.filter((item) => item.kind === "lifecycle" && item.label === "任务已完成")).toHaveLength(1);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "任务已完成", detail: "所有步骤已结束" });
  });

  it("marks a failed daemon exec.result as terminal", () => {
    let view = newTurnView(task, "你好");
    view = applyTaskEvent(view, { type: "exec.result", ok: false });

    expect(view.state).toBe("failed");
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "任务未完成", state: "failed" });
  });

  it("renders an explicit offline state instead of an endless allocation spinner", () => {
    const view = newTurnView({ ...task, state: "failed", failure_code: "computer_offline" }, "运行任务");

    expect(view.phase).toBe("运行环境离线");
    expect(runningLifecycleLabels(view)).toEqual([]);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "运行环境离线", state: "failed" });
  });

  it("renders a dispatch timeout from the authoritative Session state", () => {
    let view = newTurnView({ ...task, state: "pending" }, "运行任务");
    view = reconcileTaskState(view, { ...task, state: "failed", failure_code: "dispatch_timeout" });

    expect(view.phase).toBe("等待超时");
    expect(runningLifecycleLabels(view)).toEqual([]);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "等待运行环境超时", state: "failed" });
  });

  it("renders an explicit capacity queue state and deadline", () => {
    const view = newTurnView({
      ...task,
      state: "pending",
      queue_reason: "capacity_wait",
      queue_deadline: "2026-08-08T08:05:00Z",
    }, "运行任务");

    expect(view.phase).toBe("正在排队");
    expect(view.phaseDetail).toContain("当前运行池繁忙");
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "等待可用容量", state: "running" });

    const reconciled = reconcileTaskState(view, {
      ...task,
      state: "pending",
      queue_reason: "capacity_wait",
      queue_deadline: "2026-08-08T08:05:00Z",
    });
    expect(reconciled.phase).toBe("正在排队");
    expect(reconciled.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "等待可用容量", state: "running" });
  });

  it("renders a capacity timeout as an actionable terminal state", () => {
    let view = newTurnView({ ...task, state: "pending", queue_reason: "capacity_wait" }, "运行任务");
    view = reconcileTaskState(view, { ...task, state: "failed", failure_code: "capacity_timeout" });

    expect(view.phase).toBe("容量等待超时");
    expect(runningLifecycleLabels(view)).toEqual([]);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "等待可用容量超时", state: "failed" });
  });

  it("keeps the Agent loop in source order while a tool changes state", () => {
    let view = newTurnView(task);
    const records = [
      { type: "system", subtype: "init", model: "DeepSeek V4 Flash" },
      { type: "context", step: 1, messageCount: 4 },
      { type: "tool_use", id: "call-1", name: "Bash", args: { command: "pwd" } },
      { type: "tool_result", id: "call-1", name: "Bash", ok: true, preview: "/workspace" },
      { type: "assistant", delta: "工作目录已确认。" },
      { type: "result", ok: true, text: "工作目录已确认。" },
    ];
    view = applyTaskEvent(view, { type: "exec.output", data: encoded(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`) });

    expect(view.timeline.map((item) => item.kind)).toEqual(["lifecycle", "lifecycle", "context", "tool", "assistant", "lifecycle"]);
    expect(view.timeline.find((item) => item.kind === "tool")).toMatchObject({ name: "Bash", status: "succeeded", preview: "/workspace" });
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "正在整理交付结果", state: "running" });

    view = applyTaskEvent(view, { type: "artifact.collect_completed", cursor: 9, data: encoded('{"count":2}') });
    expect(view.artifactDelivery).toBe("available");
    expect(view.artifactCount).toBe(2);
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "交付文件已就绪", detail: "2 个文件可下载" });

    view = reconcileTaskState(view, "succeeded");
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "任务已完成" });
  });

  it("preserves an artifact delivery failure as a visible partial-success warning", () => {
    let view = newTurnView(task, "生成报告");
    view = applyTaskEvent(view, { type: "exec.result", ok: true, cursor: 7 });
    view = applyTaskEvent(view, { type: "artifact.collect_failed", error: "artifact_collection_failed", cursor: 8 });
    view = reconcileTaskState(view, "succeeded");

    expect(view.state).toBe("succeeded");
    expect(view.artifactDelivery).toBe("failed");
    expect(view.timeline).toContainEqual(expect.objectContaining({ kind: "lifecycle", label: "产物交付不完整", state: "failed" }));
    expect(view.timeline.at(-1)).toMatchObject({ kind: "lifecycle", label: "任务已完成", state: "succeeded" });
  });
});

function runningLifecycleLabels(view: ReturnType<typeof newTurnView>) {
  return view.timeline.filter((item) => item.kind === "lifecycle" && item.state === "running").map((item) => item.kind === "lifecycle" ? item.label : "");
}
