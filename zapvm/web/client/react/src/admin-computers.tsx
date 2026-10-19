import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, CloudCog, Cpu, LoaderCircle, Play, Power, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, APIError } from "./api";
import { computerStatusLabel, computerStatusTone } from "./computer-status";
import { Badge, Button, StatusDot } from "./design-system";
import { queryKeys } from "./query-keys";
import type { Computer } from "./types";

export function AdminComputers({ embedded = false }: { embedded?: boolean }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const computersQuery = useQuery({
    queryKey: queryKeys.adminComputers,
    queryFn: api.adminComputers,
    refetchInterval: (query) => query.state.data?.computers.some(isTransitioning) ? 1_000 : 5_000,
  });
  const lifecycle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "wake" | "release" }) => api.computerLifecycle(id, action),
    onSuccess: (result, variables) => {
      setNotice(result.accepted
        ? `${variables.id} 已提交${variables.action === "wake" ? "唤醒" : "释放"}操作。`
        : `${variables.id} 已处于目标状态。`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminComputers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.computers });
    },
  });
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const computers = computersQuery.data?.computers ?? [];
  const summary = useMemo(() => ({
    total: computers.length,
    running: computers.filter((computer) => computer.observed_state === "ready" || computer.observed_state === "busy").length,
    busy: computers.filter((computer) => computer.observed_state === "busy").length,
    attention: computers.filter((computer) => computer.observed_state === "degraded" || computer.state === "offline").length,
  }), [computers]);

  return <section className={`admin-computers${embedded ? " is-embedded" : ""}`} aria-label="Computer 运行状态">
    {!embedded && <header className="admin-page-heading">
      <div><p className="eyebrow"><ShieldCheck className="size-3" />WORKSPACE ADMIN</p><h1>Computer 管理</h1><p>查看运行状态、调度归属，并安全地唤醒或释放 Agent Computer。</p></div>
      <Button tone="secondary" size="sm" leadingIcon={<RefreshCw className={`size-4 ${computersQuery.isFetching ? "animate-spin" : ""}`} />} onClick={() => void computersQuery.refetch()} disabled={computersQuery.isFetching}>刷新状态</Button>
    </header>}
	{embedded && <div className="platform-section-heading"><div><h2>运行状态与生命周期</h2><p>运行态来自 Control，唤醒与释放操作不会修改 Computer 规格。</p></div><Button tone="secondary" size="sm" leadingIcon={<RefreshCw className={`size-4 ${computersQuery.isFetching ? "animate-spin" : ""}`} />} onClick={() => void computersQuery.refetch()} disabled={computersQuery.isFetching}>刷新状态</Button></div>}

    <div className="admin-summary" aria-label="Computer 概览">
      <SummaryCard icon={<Cpu />} label="全部 Computer" value={summary.total} />
      <SummaryCard icon={<Power />} label="已启动" value={summary.running} tone="success" />
      <SummaryCard icon={<Activity />} label="执行任务中" value={summary.busy} tone="active" />
      <SummaryCard icon={<AlertTriangle />} label="需要处理" value={summary.attention} tone={summary.attention ? "danger" : "neutral"} />
    </div>

    <div className="admin-policy-note"><CloudCog /><span><strong>声明式配置保持不变</strong><small>Computer 的新增、删除和资源规格仍由 Control 配置管理；这里负责安全的运行时生命周期操作。</small></span></div>
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    {lifecycle.isError && <div className="admin-error" role="alert"><AlertTriangle />{lifecycleError(lifecycle.error)}</div>}

    {computersQuery.isPending && <div className="admin-loading"><LoaderCircle className="animate-spin" />正在读取 Host Pool…</div>}
    {computersQuery.isError && <div className="admin-empty"><AlertTriangle /><h2>无法读取 Computer</h2><p>{lifecycleError(computersQuery.error)}</p><Button onClick={() => void computersQuery.refetch()}>重新加载</Button></div>}
    {!computersQuery.isPending && !computersQuery.isError && !computers.length && <div className="admin-empty"><Server /><h2>尚未配置 Computer</h2><p>请先在 Control 配置中声明 Workspace Computer。</p></div>}
    {!!computers.length && <div className="computer-admin-list">
      <div className="computer-admin-header" aria-hidden="true"><span>Computer</span><span>运行状态</span><span>调度节点</span><span>最近活动</span><span>操作</span></div>
      {computers.map((computer) => <ComputerRow key={computer.id} computer={computer} pending={lifecycle.isPending && lifecycle.variables?.id === computer.id} onAction={(action) => lifecycle.mutate({ id: computer.id, action })} />)}
    </div>}
  </section>;
}

export function AdminAccessDenied({ onBack }: { onBack: () => void }) {
  return <section className="admin-computers"><div className="admin-empty" role="alert">
    <ShieldCheck /><h1>需要 Workspace 管理权限</h1>
    <p>当前登录身份可以使用 Agent，但不能查看或操作运行环境。</p>
    <Button tone="secondary" onClick={onBack}>返回任务</Button>
  </div></section>;
}

function SummaryCard({ icon, label, value, tone = "neutral" }: { icon: ReactNode; label: string; value: number; tone?: "neutral" | "success" | "active" | "danger" }) {
  return <article className={`admin-summary-card is-${tone}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></article>;
}

function ComputerRow({ computer, pending, onAction }: { computer: Computer; pending: boolean; onAction: (action: "wake" | "release") => void }) {
  const transitioning = isTransitioning(computer);
  const running = computer.observed_state === "ready" || computer.observed_state === "busy";
  const busy = computer.observed_state === "busy";
  return <article className="computer-admin-row">
    <div className="computer-identity"><span className="computer-glyph"><Cpu /></span><span><strong>{computer.id}</strong><small>epoch {computer.placement_epoch ?? 0}</small></span></div>
    <div className="computer-runtime"><Badge tone={computerStatusTone(computer) === "danger" ? "danger" : running ? "success" : "neutral"}><StatusDot tone={computerStatusTone(computer)} pulse={busy || transitioning} />{computerStatusLabel(computer)}</Badge>{computer.failure_code && <small title={computer.failure_code}>{friendlyFailure(computer.failure_code)}</small>}</div>
    <div className="computer-node"><Server /><span>{computer.assigned_node_id || "按需调度"}</span></div>
    <time dateTime={computer.last_activity_at}>{formatActivity(computer.last_activity_at)}</time>
    <div className="computer-actions">
      <Button size="sm" tone="secondary" leadingIcon={pending && !running ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />} disabled={pending || transitioning || running} onClick={() => onAction("wake")}>唤醒</Button>
      <Button size="sm" tone="quiet" leadingIcon={pending && running ? <LoaderCircle className="size-4 animate-spin" /> : <Power className="size-4" />} disabled={pending || transitioning || busy || !computer.assigned_node_id} onClick={() => onAction("release")}>释放</Button>
    </div>
  </article>;
}

function isTransitioning(computer: Computer) {
  return computer.failure_code === "computer_stopping" || (computer.observed_state === "unavailable" && Boolean(computer.assigned_node_id));
}

function formatActivity(value?: string) {
  if (!value) return "暂无活动";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function friendlyFailure(code: string) {
  const labels: Record<string, string> = {
    computer_stopping: "正在释放实例",
    node_offline: "运行节点离线",
    node_degraded: "运行节点异常",
    computer_idle_stopped: "空闲实例已回收",
    computer_start_timeout: "启动超时",
    computer_stop_timeout: "释放超时",
  };
  return labels[code] ?? code;
}

function lifecycleError(reason: unknown) {
  if (reason instanceof APIError) {
    if (reason.status === 403) return "当前账号没有 Workspace 管理权限。";
    if (reason.status === 409) return "Computer 正在执行任务或切换状态，暂时不能释放。";
    if (reason.status === 503) return "Host Pool 当前没有可用运行节点，请检查 Node 状态。";
    return reason.message;
  }
  return reason instanceof Error ? reason.message : "操作失败，请稍后重试。";
}
