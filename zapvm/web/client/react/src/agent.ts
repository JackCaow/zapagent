import { decodeEventData } from "./api";
import type { AgentSession, Conversation, TaskEvent, TimelineItem, ToolItem, TurnView } from "./types";

// `interrupted` is terminal in the task journal too.  Treating it as active
// would keep a dead EventSource (and the composer) in the loading state.
export const terminalStates = new Set(["succeeded", "failed", "canceled", "interrupted"]);

export const newTurnView = (session: AgentSession, prompt = ""): TurnView => {
  const queue = queuePresentation(session.queue_reason, session.queue_deadline);
  const pending = session.state === "pending" || session.state === "queued";
  const view: TurnView = {
    id: session.id,
    prompt,
    state: session.state,
    phase: session.state === "succeeded" ? "已完成" : pending ? queue.phase : "准备中",
    phaseDetail: session.state === "succeeded" ? "任务已完成" : queue.detail,
    assistant: "",
    tools: [],
    timeline: [{
      id: "task-submitted",
      kind: "lifecycle",
      label: session.state === "succeeded" ? "任务已完成" : pending ? queue.label : "任务已提交",
      detail: session.state === "succeeded" ? "已恢复历史执行记录" : queue.detail,
      state: session.state === "failed" || session.state === "canceled" ? "failed" : session.state === "succeeded" ? "succeeded" : "running",
    }],
    technical: [],
    cursor: 0,
    rawBuffer: "",
  };
  if (terminalStates.has(session.state)) settleTerminalState(view, session.state, undefined, undefined, session.failure_code);
  return view;
};

export function conversationsFromSessions(sessions: AgentSession[]): Conversation[] {
  const groups = new Map<string, Conversation>();
  for (const session of sessions) {
    const id = session.session_id || session.id;
    const existing = groups.get(id);
    const title = session.title?.trim() || "新任务";
    if (existing) {
      existing.turns.push(session);
      if (session.title) existing.title = title;
      if (!existing.updatedAt || (session.updated_at ?? "") > existing.updatedAt) existing.updatedAt = session.updated_at;
    } else {
      groups.set(id, { id, computerId: session.computer_id, title, turns: [session], updatedAt: session.updated_at ?? session.created_at });
    }
  }
  return [...groups.values()]
    .map((conversation) => ({ ...conversation, turns: [...conversation.turns].sort(byCreatedAt) }))
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

function byCreatedAt(left: AgentSession, right: AgentSession) {
  return (left.created_at ?? "").localeCompare(right.created_at ?? "");
}

export function friendlyComputer(id?: string) {
  if (!id) return "运行环境";
  if (id === "resident-zapvm") return "我的电脑";
  if (id === "cloud-smoke") return "Cloud 环境";
  if (id.startsWith("zap-")) return `远端环境 ${id.slice(-6)}`;
  return id.replaceAll("-", " ");
}

export function titleFromPrompt(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 34) : "新任务";
}

export function applyTaskEvent(previous: TurnView, event: TaskEvent): TurnView {
  const next: TurnView = {
    ...previous,
    tools: [...previous.tools],
    timeline: [...previous.timeline],
    technical: [...previous.technical],
    cursor: Math.max(previous.cursor, Number(event.cursor) || 0),
  };
  const type = String(event.type ?? "");
  if (type === "task.created") {
    setPhase(next, "准备中", "任务已接收，正在分配运行环境");
    updateLifecycle(next, "task-submitted", "任务已提交", "正在分配运行环境", "running");
  }
  if (type === "task.started") {
    updateLifecycle(next, "task-submitted", "任务已提交", "已进入运行队列", "succeeded");
    setPhase(next, "准备中", "已连接运行环境");
    appendLifecycle(next, event, "运行环境已连接", "Agent 已取得执行权限", "succeeded");
  }
  if (type === "exec.scheduled") {
    updateLifecycle(next, "task-submitted", "任务已提交", "已进入运行队列", "succeeded");
    setPhase(next, "准备中", "正在加载运行配置");
    updateLifecycle(next, "runtime-config", "正在加载运行配置", undefined, "running");
  }
  if (type === "exec.started") {
    updateLifecycle(next, "runtime-config", "运行配置已加载", undefined, "succeeded");
    setPhase(next, "思考中", "正在理解任务并检查上下文");
    updateLifecycle(next, "agent-processing", "Agent 开始处理", "正在理解任务并检查上下文", "running");
  }
  if (type === "exec.result") {
    if (event.ok === true) beginArtifactDelivery(next);
    else settleTerminalState(next, "failed", event);
  }
  if (type === "task.cancel_requested") setPhase(next, "正在停止", "等待当前工具安全退出");
  if (type === "task.canceled") {
    settleTerminalState(next, "canceled", event);
  }
  if (type === "task.interrupted") {
    settleTerminalState(next, "interrupted", event);
  }
  if (type === "task.failed") {
    settleTerminalState(next, "failed", event);
  }
  if (type === "task.succeeded") {
    settleTerminalState(next, "succeeded", event);
  }
  if (type === "artifact.collect_completed") {
    const count = artifactCount(event);
    next.artifactCount = count;
    next.artifactDelivery = count > 0 ? "available" : "empty";
    updateLifecycle(
      next,
      "artifact-delivery",
      count > 0 ? "交付文件已就绪" : "交付检查已完成",
      count > 0 ? `${count} 个文件可下载` : "本次任务未发布下载文件",
      "succeeded",
    );
    setPhase(next, "正在完成", count > 0 ? "交付文件已就绪" : "未生成下载文件");
  }
  if (type === "artifact.collect_failed") {
    next.artifactDelivery = "failed";
    updateLifecycle(next, "artifact-delivery", "产物交付不完整", "文件收集或上传失败，可重试任务", "failed");
    setPhase(next, "正在完成", "产物交付不完整");
  }

  if (type === "artifact.collect_completed" || type === "artifact.collect_failed") return next;

  const output = decodeEventData(event);
  if (type === "exec.output" || type === "exec.output.stdout") return applyOutput(next, output);
  if (output && type) appendTechnical(next, output);
  return next;
}

function applyOutput(next: TurnView, output: string): TurnView {
  const joined = `${next.rawBuffer}${output}`;
  const lines = joined.split("\n");
  next.rawBuffer = lines.pop() ?? "";
  for (const line of lines) consumeAgentLine(next, line);
  return next;
}

export function flushAgentOutput(next: TurnView): TurnView {
  if (next.rawBuffer.trim()) consumeAgentLine(next, next.rawBuffer);
  return { ...next, rawBuffer: "" };
}

export function reconcileTaskState(previous: TurnView, session: AgentSession | AgentSession["state"]): TurnView {
  const next: TurnView = { ...previous, tools: [...previous.tools], timeline: [...previous.timeline], technical: [...previous.technical] };
  const state = typeof session === "string" ? session : session.state;
  const failureCode = typeof session === "string" ? undefined : session.failure_code;
  if (terminalStates.has(state)) settleTerminalState(next, state, undefined, undefined, failureCode);
  else {
    next.state = state;
    if (typeof session !== "string" && state === "pending") {
      const queue = queuePresentation(session.queue_reason, session.queue_deadline);
      setPhase(next, queue.phase, queue.detail);
      updateLifecycle(next, "task-submitted", queue.label, queue.detail, "running");
    }
  }
  return next;
}

function queuePresentation(reason?: AgentSession["queue_reason"], deadline?: string) {
  const suffix = deadline ? ` · 最晚 ${new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  switch (reason) {
  case "node_offline":
    return { phase: "等待运行环境", label: "运行环境暂时离线", detail: `等待节点恢复${suffix}` };
  case "capacity_wait":
    return { phase: "正在排队", label: "等待可用容量", detail: `当前运行池繁忙${suffix}` };
  case "computer_starting":
    return { phase: "正在启动", label: "正在启动 Agent Computer", detail: `正在恢复并启动运行环境${suffix}` };
  default:
    return { phase: "准备中", label: "任务已提交", detail: `正在分配运行环境${suffix}` };
  }
}

function consumeAgentLine(next: TurnView, line: string) {
  const raw = line.trim();
  if (!raw) return;
  let record: Record<string, unknown> | undefined;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    appendTechnical(next, raw);
    return;
  }
  const kind = String(record.type ?? record.kind ?? "");
  if (kind === "system") {
    if (record.subtype === "init") {
      const model = typeof record.model === "string" ? record.model : "Agent runtime";
      updateLifecycle(next, "agent-processing", "Agent 已启动", model, "succeeded");
    }
    return;
  }
  if (kind === "context") {
    const step = typeof record.step === "number" ? `第 ${record.step} 轮` : "上下文已更新";
    const messageCount = typeof record.messageCount === "number" ? ` · ${record.messageCount} 条上下文` : "";
    appendTimeline(next, { id: nextTimelineID(next, "context"), kind: "context", detail: `${step}${messageCount}` });
    return;
  }
  if (kind === "assistant") {
    const content = textFromRecord(record);
    if (content) {
      settleLifecycleIfPresent(next, "agent-processing", "Agent 已开始处理", "正在生成回答");
      next.assistant += content;
      appendAssistant(next, content);
      setPhase(next, "生成回答", "正在整理可交付的结果");
    }
    return;
  }
  if (kind === "tool_use" || kind === "tool_call") {
    settleLifecycleIfPresent(next, "agent-processing", "Agent 已开始处理", "正在执行工具");
    const name = String(record.name ?? record.tool_name ?? record.tool ?? "工具调用");
    const id = String(record.id ?? record.tool_use_id ?? `${name}-${next.tools.length}`);
    const summary = textFromRecord(record) || formatInput(record.args ?? record.input);
    upsertTool(next, { id, name, summary, status: "running" });
    appendTimeline(next, { id: `tool:${id}`, kind: "tool", name, args: summary, status: "running" });
    setPhase(next, "正在执行", `正在使用 ${name}`);
    return;
  }
  if (kind === "tool" || kind === "tool_result") {
    const id = String(record.tool_use_id ?? record.id ?? "");
    const failed = record.ok === false || Boolean(record.error);
    const summary = textFromRecord(record) || formatInput(record.preview ?? record.content ?? record.output);
    const matching = next.tools.find((tool) => tool.id === id) ?? next.tools.at(-1);
    const tool = matching ? { ...matching, summary: summary || matching.summary, status: failed ? "failed" as const : "succeeded" as const } : { id: id || `tool-${next.tools.length}`, name: String(record.name ?? "工具调用"), summary, status: failed ? "failed" as const : "succeeded" as const };
    upsertTool(next, tool);
    updateToolTimeline(next, tool);
    return;
  }
  if (kind === "result") {
    const result = textFromRecord(record);
    if (result) {
      next.result = result;
      if (!next.assistant.trim() || !next.assistant.includes(result)) appendAssistant(next, result);
    }
    if (record.ok === false) {
      settleTerminalState(next, "failed", undefined, textFromRecord(record) || "运行返回失败");
    } else {
      beginArtifactDelivery(next);
    }
    return;
  }
  if (kind === "error") {
    next.error = textFromRecord(record) || "任务执行出现异常";
    appendTimeline(next, { id: nextTimelineID(next, "error"), kind: "error", detail: next.error });
    settleTerminalState(next, "failed", undefined, "任务执行出现异常");
    return;
  }
  if (kind === "observation") {
    const detail = textFromRecord(record) || formatInput(record.detail);
    if (detail) appendTimeline(next, { id: nextTimelineID(next, "observation"), kind: "observation", detail });
    return;
  }
  appendTechnical(next, raw);
}

function beginArtifactDelivery(next: TurnView) {
  settleLifecycleIfPresent(next, "agent-processing", "Agent 已完成处理", "已生成最终答复");
  next.state = "running";
  next.artifactDelivery = "pending";
  setPhase(next, "正在交付", "正在收集并上传生成文件");
  updateLifecycle(next, "artifact-delivery", "正在整理交付结果", "正在收集并上传生成文件", "running");
}

function artifactCount(event: TaskEvent) {
  const output = decodeEventData(event);
  try {
    const count = Number((JSON.parse(output) as { count?: unknown }).count);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function textFromRecord(record: Record<string, unknown>) {
  for (const key of ["delta", "text", "content", "message", "output", "detail", "error"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function formatInput(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function upsertTool(next: TurnView, item: ToolItem) {
  const index = next.tools.findIndex((tool) => tool.id === item.id);
  if (index < 0) next.tools.push(item);
  else next.tools[index] = item;
}

function appendAssistant(next: TurnView, content: string) {
  const previous = next.timeline.at(-1);
  if (previous?.kind === "assistant") {
    previous.content += content;
    return;
  }
  appendTimeline(next, { id: nextTimelineID(next, "assistant"), kind: "assistant", content });
}

function updateToolTimeline(next: TurnView, tool: ToolItem) {
  const index = next.timeline.findIndex((item) => item.kind === "tool" && item.id === `tool:${tool.id}`);
  const item: TimelineItem = { id: `tool:${tool.id}`, kind: "tool", name: tool.name, preview: tool.summary, status: tool.status };
  if (index >= 0) next.timeline[index] = { ...(next.timeline[index] as Extract<TimelineItem, { kind: "tool" }>), ...item };
  else appendTimeline(next, item);
}

function appendLifecycle(next: TurnView, event: TaskEvent | undefined, label: string, detail: string | undefined, state: "running" | "succeeded" | "failed") {
  appendTimeline(next, { id: event ? `event:${event.cursor ?? next.timeline.length}:${event.type}` : nextTimelineID(next, "lifecycle"), kind: "lifecycle", label, detail, state });
}

function settleTerminalState(next: TurnView, state: AgentSession["state"], event?: TaskEvent, detailOverride?: string, failureCode?: string) {
  const succeeded = state === "succeeded";
  settleOpenTimeline(next, succeeded);
  next.state = state;
  const infrastructureFailure = failureCode === "computer_offline"
    ? { phase: "运行环境离线", phaseDetail: "当前运行节点未连接", label: "运行环境离线", detail: "当前运行节点未连接，请稍后重试", itemState: "failed" as const }
    : failureCode === "capacity_timeout"
      ? { phase: "容量等待超时", phaseDetail: "运行池暂时没有可用容量", label: "等待可用容量超时", detail: "任务在排队时限内未获得计算容量，请稍后重试", itemState: "failed" as const }
      : failureCode === "dispatch_timeout"
      ? { phase: "等待超时", phaseDetail: "没有可用的运行环境", label: "等待运行环境超时", detail: "任务在排队时限内未获得运行环境，请重试", itemState: "failed" as const }
      : undefined;
  const presentation = infrastructureFailure ?? (state === "succeeded"
    ? { phase: "已完成", phaseDetail: "任务已完成", label: "任务已完成", detail: detailOverride ?? "所有步骤已结束", itemState: "succeeded" as const }
    : state === "canceled"
      ? { phase: "已停止", phaseDetail: "可以修改目标后重新运行", label: "任务已停止", detail: detailOverride ?? "可以修改目标后重新运行", itemState: "failed" as const }
      : state === "interrupted"
        ? { phase: "执行中断", phaseDetail: "连接中断，可以稍后重试", label: "执行连接中断", detail: detailOverride ?? "可以稍后重试", itemState: "failed" as const }
        : { phase: "未完成", phaseDetail: "任务执行失败", label: "任务未完成", detail: detailOverride ?? "任务执行失败", itemState: "failed" as const });
  setPhase(next, presentation.phase, presentation.phaseDetail);

  const terminalLabels = new Set(["任务已完成", "任务未完成", "任务已停止", "执行连接中断", "运行环境离线", "等待运行环境超时", "等待可用容量超时"]);
  const index = next.timeline.findIndex((item) => item.kind === "lifecycle" && terminalLabels.has(item.label));
  const terminal: TimelineItem = { id: index >= 0 ? next.timeline[index].id : event ? `event:${event.cursor ?? next.timeline.length}:${event.type}` : nextTimelineID(next, "lifecycle"), kind: "lifecycle", label: presentation.label, detail: presentation.detail, state: presentation.itemState };
  if (index >= 0) next.timeline.splice(index, 1);
  appendTimeline(next, terminal);
}

function settleOpenTimeline(next: TurnView, succeeded: boolean) {
  let finalRunningLifecycle = -1;
  for (let index = next.timeline.length - 1; index >= 0; index -= 1) {
    const item = next.timeline[index];
    if (item.kind === "lifecycle" && item.state === "running") { finalRunningLifecycle = index; break; }
  }
  next.timeline = next.timeline.map((item, index) => {
    if (item.kind === "tool" && item.status === "running") return { ...item, status: succeeded ? "succeeded" : "failed" };
    if (item.kind !== "lifecycle" || item.state !== "running") return item;
    const failedHere = !succeeded && index === finalRunningLifecycle;
    if (item.label === "任务已提交") return failedHere ? { ...item, label: "任务提交未完成", detail: "未能进入运行队列", state: "failed" } : { ...item, detail: "已进入运行队列", state: "succeeded" };
    if (item.label === "正在加载运行配置") return failedHere ? { ...item, label: "运行配置加载失败", detail: "未能启动 Agent", state: "failed" } : { ...item, label: "运行配置已加载", detail: undefined, state: "succeeded" };
    if (item.label === "Agent 开始处理") return { ...item, label: failedHere ? "Agent 处理未完成" : "Agent 已完成处理", detail: failedHere ? "在此步骤中断" : "处理已结束", state: failedHere ? "failed" : "succeeded" };
    if (item.label === "正在整理交付结果") return failedHere ? { ...item, label: "产物交付未完成", detail: "文件收集或上传中断", state: "failed" } : { ...item, label: "交付检查已完成", detail: "任务已结束", state: "succeeded" };
    return { ...item, detail: failedHere ? "在此步骤中断" : item.detail, state: failedHere ? "failed" : "succeeded" };
  });
  next.tools = next.tools.map((tool) => tool.status === "running" ? { ...tool, status: succeeded ? "succeeded" : "failed" } : tool);
}

function settleLifecycleIfPresent(next: TurnView, id: string, label: string, detail?: string) {
  const index = next.timeline.findIndex((item) => item.kind === "lifecycle" && item.id === id);
  if (index >= 0 && next.timeline[index].kind === "lifecycle" && next.timeline[index].state === "running") updateLifecycle(next, id, label, detail, "succeeded");
}

function updateLifecycle(next: TurnView, id: string, label: string, detail: string | undefined, state: "running" | "succeeded" | "failed") {
  const index = next.timeline.findIndex((item) => item.kind === "lifecycle" && item.id === id);
  const item: TimelineItem = { id, kind: "lifecycle", label, detail, state };
  if (index >= 0) next.timeline[index] = item;
  else appendTimeline(next, item);
}

function appendTimeline(next: TurnView, item: TimelineItem) {
  next.timeline = [...next.timeline, item];
}

function nextTimelineID(next: TurnView, prefix: string) {
  return `${prefix}:${next.cursor}:${next.timeline.length}`;
}

function setPhase(next: TurnView, phase: string, phaseDetail: string) {
  next.phase = phase;
  next.phaseDetail = phaseDetail;
}

function appendTechnical(next: TurnView, line: string) {
  const value = line.trim();
  if (!value) return;
  next.technical = [...next.technical, value].slice(-30);
}
