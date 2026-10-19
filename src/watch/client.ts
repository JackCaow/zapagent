import { animate } from "motion";
import type { AnimationPlaybackControls } from "motion";
import type { WatchNode, WatchEdge, WatchSession, WatchOutcome, WatchTimelineItem, WatchMutation, WatchSnapshot, WatchFrame } from "./protocol.js";
import { layout, visibleNodes, tone, edgePath } from "./view-model.js";
import { updateTimelineRow } from "./timeline.js";
import type { Point } from "./view-model.js";

const $ = (id: string) => document.getElementById(id)!;
const sessionSelect = $("session") as HTMLSelectElement;
const nodes = new Map<string, WatchNode>(), edges = new Map<string, WatchEdge>();
const sessions = new Map<string, WatchSession>(), outcomes = new Map<string, WatchOutcome>();
let timeline: WatchTimelineItem[] = [], selected = "", thread = "", epoch = "", seq = 0;
let stopping = false, live = false, lastSeen = 0, serverNow = Date.now(), serverAnchor = performance.now();
let attempt = 0, renderQueued = false, follow = true, zoom = 1, autoFit = true;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let motionOff = false;
try { motionOff = localStorage.getItem("zap.watch.reduced-motion") === "true"; } catch {}
const animations = new Set<AnimationPlaybackControls>();
const pulses = new Map<string, AnimationPlaybackControls>();
const cards = new Map<string, HTMLButtonElement>(), rows = new Map<string, HTMLButtonElement>();
const paths = new Map<string, SVGPathElement>(), events = new Map<number, HTMLButtonElement>();
let positions = new Map<string, Point>(), layoutAnimation: AnimationPlaybackControls | undefined;
let targetPositions = new Map<string, Point>();
let graphSize = { width: 300, height: 300 };
const tokenKey = "zap.watch.token";
let token = location.hash.startsWith("#token=") ? location.hash.slice(7) : "";
try { if (token) sessionStorage.setItem(tokenKey, token); else token = sessionStorage.getItem(tokenKey) || ""; } catch {}
history.replaceState(null, "", location.pathname);
 const labels: Record<string, string> ={started:'开始执行',root:'主 Agent',provider:'模型请求',agent:'子 Agent',external:'外部 Agent',general:'General',explore:'Explore',plan:'Plan',running:'运行中',idle:'空闲',thinking:'思考中',writing:'输出中',tool:'执行工具',compacting:'压缩上下文',scheduled:'已排队',starting:'启动中',waiting_capacity:'等待容量',waiting_dependency:'等待依赖',waiting_approval:'等待审批',waiting_input:'等待输入',cancelling:'取消中',validating:'验证中',ready_to_merge:'待合并',merging:'合并中',completed:'已完成',finished:'执行结束',limited:'达到运行限制',incomplete:'未完成',blocked:'受阻',failed:'失败',cancelled:'已取消',exited:'进程已退出',arguments_streaming:'参数生成中',submitted:'已提交',authorized:'已授权',settling:'结果结算中',returned:'结果已返回',requesting:'发送请求',waiting_output:'等待模型输出',streaming:'流式输出',retrying:'退避重试',sealing:'运行收尾',cleanup:'清理中',unverified:'未独立验收',not_requested:'未请求',legacy_unknown:'旧协议 / 未知',requested:'已请求',approved:'已通过',denied:'已拒绝',unknown:'未知'};

const word = (value: string) => labels[value] || value;
const clip = (value: string) => value.length > 22 ? value.slice(0, 10) + "…" + value.slice(-7) : value;
const kindLabel = (n: WatchNode) => n.kind === "run" ? n.scope.parentRunId ? "SUB AGENT" : "AGENT" : n.kind === "request" ? "MODEL REQUEST" : "TOOL CALL";
const canAnimate = () => !motionOff && !reduced.matches && !document.hidden;
function play(element: Element, values: Record<string, number[]>, duration = .28) {
  if (!canAnimate()) return;
  const control = animate(element, values, { duration, ease: "easeOut" });
  animations.add(control);
  void control.finished.then(() => animations.delete(control));
}
function elapsed(n: WatchNode) {
  const time = n.elapsedMs + (n.terminal || n.observationClosed ? 0 : Math.max(0, serverNow + (live ? performance.now() - serverAnchor : 0) - n.updatedAt));
  const seconds = Math.max(0, Math.floor(time / 1000));
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + seconds % 60 + "s";
}
function connection(text: string, connected = false) {
  if (live && !connected) { serverNow += performance.now() - serverAnchor; serverAnchor = performance.now(); }
  live = connected;
  $("connection").textContent = text;
  $("connection").classList.toggle("live", connected);
  document.body.classList.toggle("connected", connected);
  syncActivity();
}
function request(path: string, signal: AbortSignal) {
  return fetch(path, { headers: { Authorization: "Bearer " + token }, cache: "no-store", signal });
}
function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function select(id: string) { selected = id; render(); }
const fields = new Map<string, { key: HTMLElement; value: HTMLElement }>();
function inspect() {
  const n = nodes.get(selected), values = new Map<string, string>();
  $("detail-title").textContent = n ? word(n.label) : "选择一个节点";
  $("detail-id").textContent = n?.scope.runId ?? "";
  $("detail-kind").textContent = n ? kindLabel(n) : "节点详情";
  const field = (key: string, value: string | number) => values.set(key, String(value));
  if (n) {
    field("生命周期", word(n.status));
    if (n.activity) field("活动阶段", word(n.activity));
    field("已观测耗时", elapsed(n));
    field("来源", n.source === "external_report" ? "外部 CLI 报告" : n.source === "executor" ? "ToolExecutor" : "Runtime");
    field("覆盖", n.coverage === "full" ? "当前运行" : n.coverage === "opaque" ? "协议不透明" : "部分");
    if (n.observationClosed) field("观测", "未闭合 · 保留最后状态");
    if (n.step !== undefined) field("Step", n.step);
    if (n.toolCallId) field("调用 ID", n.toolCallId);
    if (n.scope.parentRunId) field("父 Agent", n.scope.parentRunId);
    if (n.attempt !== undefined) field("请求尝试", n.attempt + " / " + (n.maxAttempts ?? "?"));
    if (n.retryDelayMs !== undefined) field("重试退避", n.retryDelayMs + "ms");
    if (n.approval) field("审批", word(n.approval.status));
    if (n.wasExecuted !== undefined) field("进入执行边界", n.wasExecuted ? "是" : "未观测到");
    if (n.executionSpans) field("执行尝试", n.executionSpans.length);
    if (n.success !== undefined) field("最终工具结果", n.success ? "成功" : "失败");
    if (n.unknownEvents) field("未解析事件", n.unknownEvents);
    if (n.argumentChars !== undefined) field("参数字符", n.argumentChars);
    if (n.inputTokens !== undefined) field("已报告输入 Token", n.inputTokens);
    if (n.outputTokens !== undefined) field("已报告输出 Token", n.outputTokens);
    if (n.usageIncomplete) field("用量", "报告不完整");
    if (n.textChars !== undefined) field("输出字符", n.textChars);
  }
  for (const [key, pair] of fields) if (!values.has(key)) { pair.key.remove(); pair.value.remove(); fields.delete(key); }
  for (const [key, value] of values) {
    let pair = fields.get(key);
    if (!pair) { pair = { key: element("dt", "", key), value: element("dd", "") }; fields.set(key, pair); $("details").append(pair.key, pair.value); }
    if (pair.value.textContent !== value) pair.value.textContent = value;
  }
  $("detail-note").textContent = !n ? "点击状态图中的 Agent 或工具，查看生命周期、执行尝试与运行来源。"
    : n.source === "external_report" ? "外部 CLI 报告的活动，不代表 Zap 直接观察到其内部执行。"
    : n.status === "waiting_approval" ? "等待终端审批；授权之前不会执行。此网页只读。"
    : n.status === "ready_to_merge" ? "产物已准备，但合并尚未完成，不能视为任务已完成。"
    : "活动阶段、执行结果与任务验收分别展示；没有事件不代表运行卡死。";
}
function drawPositions() {
  for (const [id, p] of positions) {
    const card = cards.get(id); if (card) card.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }
  for (const [id, path] of paths) {
    const edge = edges.get(id); if (!edge) continue;
    const a = positions.get(edge.from), b = positions.get(edge.to);
    if (a && b) path.setAttribute("d", edgePath(a, b, edge.kind === "depends_on"));
  }
}
function setZoom(value: number) {
  zoom = Math.max(.4, Math.min(1.5, value));
  // CSS zoom keeps the scroll extent aligned with the scaled graph, including on Safari.
  $("stage").style.zoom = String(zoom);
  $("zoom").textContent = Math.round(zoom * 100) + "%";
}
function fit(readable = false) {
  const scale = Math.min(1, ($( "canvas").clientWidth || 900) / graphSize.width);
  setZoom(readable ? Math.max(.75, scale) : Math.min(scale, $("canvas").clientHeight / graphSize.height));
}
function syncActivity() {
  const enabled = live && !stopping && canAnimate();
  const wanted = new Set<string>();
  for (const [id, card] of cards) {
    const n = nodes.get(id);
    if (enabled && n && tone(n) === "active") {
      wanted.add(id);
      if (!pulses.has(id)) pulses.set(id, animate(card.querySelector(".signal")!, { opacity: [.35, 1, .35] }, { duration: 1.8, repeat: Infinity, ease: "easeInOut" }));
    }
  }
  for (const [id, path] of paths) {
    const n = nodes.get(edges.get(id)?.to ?? "");
    const running = enabled && !!n && tone(n) === "active" && edges.get(id)?.kind !== "depends_on";
    path.classList.toggle("live", running);
    if (running) {
      wanted.add(id);
      if (!pulses.has(id)) pulses.set(id, animate(path, { strokeDashoffset: [0, -26] }, { duration: 1.6, repeat: Infinity, ease: "linear" }));
    }
  }
  for (const [id, control] of pulses) if (!wanted.has(id)) { control.cancel(); pulses.delete(id); }
}
function updateMotion() {
  const off = motionOff || reduced.matches;
  document.body.classList.toggle("no-motion", off);
  $("motion").textContent = reduced.matches ? "系统已减少动效" : motionOff ? "开启动效" : "关闭动效";
  $("motion").setAttribute("aria-pressed", String(off));
  ($( "motion") as HTMLButtonElement).disabled = reduced.matches;
  if (!canAnimate()) { layoutAnimation?.complete(); for (const control of animations) control.complete(); animations.clear(); }
  syncActivity();
}
function render() {
  const all = [...nodes.values()].filter(n => !thread || n.scope.threadId === thread);
  const shown = visibleNodes(all, [...edges.values()], selected);
  const ids = new Set(shown.map(n => n.id));
  if (!all.some(n => n.id === selected)) selected = "";
  if (!selected && shown.length) selected = shown.find(n => n.kind === "run" && !n.terminal)?.id ?? shown[0].id;
  $("sequence").textContent = "SEQ " + seq.toLocaleString();
  const active = (n: WatchNode) => !n.terminal && !n.observationClosed;
  const stats = { "metric-agents": all.filter(n => n.kind === "run" && active(n)).length, "metric-tools": all.filter(n => n.kind === "tool" && active(n)).length, "metric-waiting": all.filter(n => active(n) && tone(n) === "waiting").length, "metric-total": all.length };
  for (const [id, count] of Object.entries(stats)) {
    const el = $(id), next = String(count);
    if (el.textContent !== next) { el.textContent = next; play(el, { opacity: [.4, 1], y: [4, 0] }); }
  }
  $("counts").textContent = shown.length < all.length ? `展示 ${shown.length} / ${all.length}` : "本会话累计观测";
  const options = new Map(Array.from(sessionSelect.options).map(o => [o.value, o]));
  for (const [id, o] of options) if (!sessions.has(id)) o.remove();
  for (const s of sessions.values()) {
    let option = options.get(s.threadId);
    if (!option) { option = document.createElement("option"); option.value = s.threadId; sessionSelect.append(option); }
    option.textContent = clip(s.threadId) + " · " + word(s.status);
  }
  sessionSelect.value = thread;
  const canvas = $("canvas"), stage = $("stage"), next = layout(shown, [...edges.values()]);
  graphSize = next;
  stage.style.width = next.width + "px"; stage.style.height = next.height + "px";
  $("wires").setAttribute("width", String(next.width)); $("wires").setAttribute("height", String(next.height));
  $("empty").hidden = shown.length > 0;
  for (const [id, card] of cards) if (!ids.has(id)) { card.remove(); cards.delete(id); rows.get(id)?.remove(); rows.delete(id); positions.delete(id); }
  for (const n of shown) {
    let card = cards.get(n.id);
    if (!card) {
      card = element("button", "node"); card.type = "button"; card.dataset.key = n.id;
      const head = element("div", "node-head"); head.append(element("span", "signal"), element("span", "kind"));
      const status = element("div", "status"); status.append(element("span", "text"), element("span", "elapsed"));
      card.append(head, element("div", "name"), status);
      card.addEventListener("click", () => select(n.id)); stage.append(card); cards.set(n.id, card);
      positions.set(n.id, next.positions.get(n.id)!);
      play(card, { opacity: [0, 1] }, .4);
    }
    const state = tone(n);
    if (card.dataset.tone && card.dataset.tone !== state) play(card.querySelector(".text")!, { opacity: [.2, 1] });
    card.dataset.tone = state; card.classList.toggle("selected", n.id === selected);
    card.setAttribute("aria-pressed", String(n.id === selected));
    card.querySelector(".kind")!.textContent = kindLabel(n);
    card.querySelector(".name")!.textContent = word(n.label);
    const status = word(n.status) + (n.observationClosed ? " · 观测未闭合" : n.activity && !n.terminal ? " / " + word(n.activity) : "");
    card.querySelector(".text")!.textContent = status;
    card.querySelector(".elapsed")!.textContent = elapsed(n);
    card.title = word(n.label) + " · " + status + " · " + (n.toolCallId || n.scope.runId);
    let row = rows.get(n.id);
    if (!row) { row = element("button", "tree-node"); row.type = "button"; row.append(element("span", "tree-name"), element("span", "tree-status")); row.addEventListener("click", () => select(n.id)); rows.set(n.id, row); $("tree").append(row); }
    row.querySelector(".tree-name")!.textContent = word(n.label) + " · " + clip(n.toolCallId || n.scope.runId);
    row.querySelector(".tree-status")!.textContent = status; row.dataset.tone = state;
    row.classList.toggle("selected", n.id === selected); row.setAttribute("aria-pressed", String(n.id === selected));
  }
  for (const [id, path] of paths) { const e = edges.get(id); if (!e || !ids.has(e.from) || !ids.has(e.to)) { path.remove(); paths.delete(id); } }
  for (const e of edges.values()) {
    if (!ids.has(e.from) || !ids.has(e.to) || paths.has(e.id)) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("class", "edge" + (e.kind === "depends_on" ? " dependency" : ""));
    paths.set(e.id, path); $("wires").append(path);
  }
  const changed = next.positions.size !== targetPositions.size || [...next.positions].some(([id, p]) => targetPositions.get(id)?.x !== p.x || targetPositions.get(id)?.y !== p.y);
  if (changed) {
    targetPositions = next.positions;
    layoutAnimation?.stop();
    const from = new Map(positions);
    if (canAnimate()) layoutAnimation = animate(0, 1, { type: "spring", duration: .45, bounce: .08, onUpdate: progress => {
      for (const [id, p] of next.positions) { const a = from.get(id) ?? p; positions.set(id, { x: a.x + (p.x - a.x) * progress, y: a.y + (p.y - a.y) * progress }); }
      drawPositions();
    } });
    else positions = next.positions;
  }
  drawPositions(); if (autoFit && canvas.clientWidth) fit(true);
  const recent = timeline.filter(t => !thread || !t.nodeId || nodes.get(t.nodeId)?.scope.threadId === thread).slice(-30).reverse();
  const eventIds = new Set(recent.map(t => t.id));
  for (const [id, row] of events) if (!eventIds.has(id)) { row.remove(); events.delete(id); }
  if (recent.length) $("timeline").querySelector(".timeline-empty")?.remove();
  for (let i = 0; i < recent.length; i++) {
    const item = recent[i], node = nodes.get(item.nodeId ?? "");
    let row = events.get(item.id);
    if (!row) {
      row = element("button", "event"); row.type = "button";
      row.append(element("time", "", new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })), element("span", "event-text"), element("span", "badge", item.kind));
      events.set(item.id, row);
      if (i < 3) play(row, { opacity: [.25, 1] });
    }
    updateTimelineRow(row, item, id => { if (nodes.has(id)) select(id); });
    row.querySelector(".event-text")!.textContent = (node ? word(node.label) + " · " : "") + word(item.status);
    row.dataset.tone = item.status === "failed" ? "error" : "neutral";
    row.disabled = !node;
    // Move only when necessary, keeping keyboard focus on the same DOM element.
    if ($( "timeline").children[i] !== row) $("timeline").insertBefore(row, $("timeline").children[i] ?? null);
  }
  if (!recent.length && !$("timeline").querySelector(".timeline-empty")) $("timeline").append(element("p", "timeline-empty", "运行时事件将在这里出现"));
  const out = [...outcomes.values()].reverse().find(o => all.some(n => n.scope.runId === o.attemptId));
  const outcomeText = out ? `执行：${word(out.execution)}　 ·　 验收：${word(out.acceptance)}　 ·　 工作流：${word(out.workflow)}` : "";
  if ($( "outcome").textContent !== outcomeText) $("outcome").textContent = outcomeText;
  inspect(); syncActivity();
}
function mutations(changes: WatchMutation[]) {
  for (const c of changes) {
    switch (c.op) {
      case "node.upsert": nodes.set(c.node.id, c.node); break;
      case "node.remove": nodes.delete(c.id); break;
      case "edge.upsert": edges.set(c.edge.id, c.edge); break;
      case "edge.remove": edges.delete(c.id); break;
      case "session.upsert": sessions.set(c.session.threadId, c.session); if (!thread || (follow && c.session.status === "running")) thread = c.session.threadId; break;
      case "session.remove": sessions.delete(c.id); if (thread === c.id) { thread = [...sessions.keys()][0] || ""; selected = ""; } break;
      case "outcome.remove": outcomes.delete(c.id); break;
      case "outcome.set": outcomes.set(c.outcome.attemptId, c.outcome); if (outcomes.size > 3) outcomes.delete(outcomes.keys().next().value!); break;
      case "timeline.append": timeline.push(c.item); if (timeline.length > 1000) timeline.shift(); break;
      case "diagnostic.set": $("coverage").textContent = `观测范围有限：${c.code} (${c.count})`; break;
      case "process.set": stopping = c.state === "stopping"; if (stopping) connection("观测已停止 · 只读保留"); break;
      default: throw Error("Unknown watch operation");
    }
  }
}
async function snapshot(signal: AbortSignal) {
  const response = await request("/api/watch/v1/snapshot", signal);
  if (response.status === 401) throw Error("AUTH");
  if (!response.ok) throw Error("SNAPSHOT");
  const s = await response.json() as WatchSnapshot;
  if (s.schema !== "zap.watch" || s.schemaVersion !== 1) throw Error("VERSION");
  nodes.clear(); edges.clear(); sessions.clear(); outcomes.clear();
  for (const n of s.nodes) nodes.set(n.id, n);
  for (const e of s.edges) edges.set(e.id, e);
  for (const session of s.sessions) sessions.set(session.threadId, session);
  for (const out of s.outcomes) outcomes.set(out.attemptId, out);
  timeline = s.recentTimeline; epoch = s.instanceId; seq = s.throughSeq; stopping = s.processState === "stopping";
  if (!sessions.has(thread)) { thread = [...sessions.keys()][0] || ""; selected = ""; }
  $("coverage").textContent = s.coverage.truncated ? "历史或观测范围有限：" + s.coverage.reasons.join(", ") : "";
  schedule();
}
async function stream(signal: AbortSignal) {
  const response = await request("/api/watch/v1/events?instanceId=" + encodeURIComponent(epoch) + "&after=" + seq, signal);
  if (response.status === 409) { await snapshot(signal); return; }
  if (response.status === 401) throw Error("AUTH");
  if (!response.ok || !response.body) throw Error("STREAM");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 1048576) throw Error("BUFFER");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const line = block.split("\n").find(x => x.startsWith("data: ")); if (!line) continue;
        const data = JSON.parse(line.slice(6));
        lastSeen = performance.now();
        connection(stopping ? "观测已停止 · 只读保留" : "实时连接", !stopping);
        if (block.includes("event: heartbeat")) { serverNow = data.serverNow; serverAnchor = performance.now(); continue; }
        const frame = data as WatchFrame;
        if (frame.schema !== "zap.watch" || frame.schemaVersion !== 1 || frame.instanceId !== epoch) throw Error("VERSION");
        if (frame.seq <= seq) continue;
        if (frame.seq !== seq + 1) throw Error("GAP");
        mutations(frame.changes); seq = frame.seq; serverNow = frame.observedAt; serverAnchor = performance.now(); attempt = 0; schedule();
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (stopping) { connection("进程已结束"); return true; }
  throw Error("DISCONNECTED");
}
async function connect() {
  if (!token) {
    connection("缺少访问凭据");
    $("empty").querySelector("h3")!.textContent = "从终端打开 Watch";
    $("empty").querySelector("p")!.textContent = "请使用 zap --watch 输出的完整地址，地址中包含本次运行的访问凭据。";
    return;
  }
  let needSnapshot = true;
  while (!stopping) {
    const controller = new AbortController(), openedAt = performance.now();
    const watchdog = setInterval(() => { if (performance.now() - Math.max(lastSeen, openedAt) > 20000) controller.abort(); }, 2000);
    try {
      if (needSnapshot) { await snapshot(controller.signal); needSnapshot = false; }
      if (await stream(controller.signal)) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN";
      if (message === "AUTH") { connection("访问凭据已失效，请重新打开终端地址"); break; }
      connection("连接中断 · 正在重连");
      if (["VERSION", "GAP", "BUFFER"].includes(message)) needSnapshot = true;
      attempt++;
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, 500 * 2 ** Math.min(attempt - 1, 4)) * (.85 + Math.random() * .3)));
    } finally { clearInterval(watchdog); }
  }
  if (stopping) connection("观测已停止 · 只读保留");
}
sessionSelect.addEventListener("change", () => { thread = sessionSelect.value; follow = false; selected = ""; autoFit = true; schedule(); });
$("view").addEventListener("click", () => {
  document.body.classList.toggle("list");
  $("view").textContent = document.body.classList.contains("list") ? "状态图视图" : "列表视图"; schedule();
});
$("motion").addEventListener("click", () => { motionOff = !motionOff; try { localStorage.setItem("zap.watch.reduced-motion", String(motionOff)); } catch {} updateMotion(); });
reduced.addEventListener("change", updateMotion);
document.addEventListener("visibilitychange", updateMotion);
$("zoom-in").addEventListener("click", () => { autoFit = false; setZoom(zoom + .1); });
$("zoom-out").addEventListener("click", () => { autoFit = false; setZoom(zoom - .1); });
$("fit").addEventListener("click", () => { autoFit = false; fit(); $("canvas").scrollTo({ left: 0, top: 0 }); });
new ResizeObserver(() => { if (autoFit) fit(true); }).observe($("canvas"));
setInterval(() => {
  if (lastSeen) {
    const age = Math.max(0, Math.floor((performance.now() - lastSeen) / 1000));
    $("freshness").textContent = "距上次信号 " + age + "s";
    if (age >= 10 && !stopping && live) connection("连接不新鲜 · 保留最后状态");
  }
  for (const [id, card] of cards) { const n = nodes.get(id); if (n) card.querySelector(".elapsed")!.textContent = elapsed(n); }
  inspect();
}, 1000);
updateMotion(); void connect();
