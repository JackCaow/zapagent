import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ArrowUp, Check, ChevronDown, CircleStop, Cloud, Download, FileArchive,
  FolderOpen, LoaderCircle, LogOut, Menu, MessageSquarePlus, MoreHorizontal, PanelRight,
  RefreshCw, ServerCog, Sparkles, Terminal, X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, APIError, gitOperation, workspaceOperation } from "./api";
import { applyTaskEvent, conversationsFromSessions, friendlyComputer, flushAgentOutput, newTurnView, reconcileTaskState, terminalStates, titleFromPrompt } from "./agent";
import { subscribeToAgentStream } from "./agent-stream";
import { Badge, BrandLockup, BrandMark, Button, IconButton, StatusDot } from "./design-system";
import { isCompleteConversationSnapshot } from "./conversation-cache";
import { MessageArtifacts, OutcomeArtifacts } from "./artifact-delivery";
import { queryKeys } from "./query-keys";
import { computerStatusLabel, computerStatusTone } from "./computer-status";
import type { AgentSession, BrowserSession, Conversation, TaskEvent, TurnView, WorkspaceEntry, WorkspaceResult } from "./types";
import { useWorkspaceNavigation } from "./workspace-navigation";
import { AdminApplication } from "./admin-app";
const Markdown = lazy(() => import("./markdown"));

export function WorkspaceApplication({ session, onSignOut }: { session: BrowserSession; onSignOut: () => Promise<void> }) {
  const navigation = useWorkspaceNavigation();
  if (navigation.route.kind === "admin-platform") {
    return <AdminApplication session={session} onBack={() => navigation.navigate({ kind: "new" })} onSignOut={onSignOut} />;
  }
  return <AgentWorkspaceApplication session={session} onSignOut={onSignOut} navigation={navigation} />;
}

function AgentWorkspaceApplication({ session, onSignOut, navigation }: {
  session: BrowserSession;
  onSignOut: () => Promise<void>;
  navigation: ReturnType<typeof useWorkspaceNavigation>;
}) {
  const queryClient = useQueryClient();
  const computersQuery = useQuery({ queryKey: queryKeys.computers, queryFn: api.computers, refetchInterval: 15_000 });
  const tasksQuery = useQuery({ queryKey: queryKeys.tasks, queryFn: api.sessions, refetchInterval: 20_000 });
  const sessions = tasksQuery.data?.sessions ?? [];
  const conversations = useMemo(() => conversationsFromSessions(sessions), [sessions]);
  const { route, navigate } = navigation;
  const [mobileNav, setMobileNav] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const canManagePlatform = session.role === "owner" || session.role === "admin";

  useEffect(() => {
    if (route.kind !== "home" || tasksQuery.isPending) return;
    navigate(conversations[0] ? { kind: "session", sessionID: conversations[0].id } : { kind: "new" }, true);
  }, [conversations, navigate, route.kind, tasksQuery.isPending]);
  const selectedID = route.kind === "session" ? route.sessionID : undefined;
  const selected = selectedID ? conversations.find((conversation) => conversation.id === selectedID) : undefined;
  const routePending = route.kind === "home" || (route.kind === "session" && tasksQuery.isPending);
  const routeMissing = route.kind === "not-found" || (route.kind === "session" && !tasksQuery.isPending && !selected);
  const defaultComputer = selected?.computerId ?? computersQuery.data?.computers.find((computer) => computer.observed_state === "ready" || computer.observed_state === "busy" || computer.state === "online")?.id ?? computersQuery.data?.computers[0]?.id;
  const computerRuntime = computersQuery.data?.computers.find((computer) => computer.id === defaultComputer);

  useEffect(() => { document.title = selected ? `${selected.title} · zapVM` : routeMissing ? "任务不存在 · zapVM" : "zapVM Agent Computer"; }, [routeMissing, selected]);
  function newConversation() { navigate({ kind: "new" }); setMobileNav(false); }
  function selectConversation(id: string) { navigate({ kind: "session", sessionID: id }); setMobileNav(false); }
  function managePlatform() { navigate({ kind: "admin-platform" }); setMobileNav(false); setOutcomeOpen(false); }
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`} aria-label="会话列表">
      <div className="sidebar-top"><a className="brand" aria-label="zapVM Agent Computer" href="/" onClick={(event) => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate({ kind: "home" }); }}><BrandLockup /></a><IconButton className="mobile-only" onClick={() => setMobileNav(false)} aria-label="关闭侧栏"><X /></IconButton></div>
      <Button onClick={newConversation} tone="secondary" fullWidth className="new-chat" leadingIcon={<MessageSquarePlus className="size-4" />}>新任务</Button>
      {canManagePlatform && <Button onClick={managePlatform} tone="quiet" fullWidth className="admin-nav" leadingIcon={<ServerCog className="size-4" />}>Workspace 管理</Button>}
      <nav className="conversation-list" aria-label="历史会话">
        <div className="section-label">最近任务</div>
        {tasksQuery.isPending && <div className="muted-row"><LoaderCircle className="size-3 animate-spin" />加载会话…</div>}
        {tasksQuery.isError && <div className="sidebar-state"><span>任务列表暂时不可用</span><button onClick={() => void tasksQuery.refetch()}>重新加载</button></div>}
        {!tasksQuery.isPending && !tasksQuery.isError && !conversations.length && <div className="sidebar-state">还没有任务</div>}
        {conversations.map((conversation) => { const latest = conversation.turns.at(-1); return <button key={conversation.id} aria-current={conversation.id === selectedID ? "page" : undefined} className={`conversation-link ${conversation.id === selectedID ? "selected" : ""}`} onClick={() => selectConversation(conversation.id)}>
          <span className="conversation-title">{conversation.title}</span><span className="conversation-meta"><StatusDot tone={taskStateTone(latest?.state)} pulse={!latest || !terminalStates.has(latest.state)} />{taskStateLabel(latest?.state)} · {friendlyComputer(conversation.computerId)}</span>
        </button>; })}
      </nav>
      <div className="sidebar-bottom"><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="account-button"><span className="avatar">{initials(session.display_name ?? session.user_display_name ?? "Z")}</span><span><strong>{session.display_name ?? session.user_display_name ?? "Workspace"}</strong><small>{session.runtime_profile?.display_name ?? session.runtime_profile?.model ?? "Agent runtime"}</small></span><ChevronDown className="size-4" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="account-menu" side="top" align="start"><DropdownMenu.Label>当前 Workspace</DropdownMenu.Label><DropdownMenu.Separator />{canManagePlatform && <DropdownMenu.Item onSelect={managePlatform}><ServerCog className="size-4" />Workspace 管理</DropdownMenu.Item>}<DropdownMenu.Item onSelect={() => void onSignOut()}><LogOut className="size-4" />退出登录</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root></div>
    </aside>
    {mobileNav && <button aria-label="关闭侧栏遮罩" className="sidebar-scrim" onClick={() => setMobileNav(false)} />}
    <main className="conversation-area">
      <header className="topbar"><IconButton className="mobile-only" onClick={() => setMobileNav(true)} aria-label="打开侧栏"><Menu /></IconButton><div className="topbar-title"><p className="eyebrow" title={computerRuntime?.failure_code}><StatusDot tone={computerStatusTone(computerRuntime)} pulse={computerRuntime?.observed_state === "busy"} />{selected ? friendlyComputer(selected.computerId) : friendlyComputer(defaultComputer)} · {computerStatusLabel(computerRuntime)}</p><h2>{routeMissing ? "任务不存在" : selected?.title ?? "新任务"}</h2></div><div className="topbar-actions"><Badge><Cloud className="size-3" />{session.runtime_profile?.model ?? "远端 Agent"}</Badge><IconButton onClick={() => setOutcomeOpen((open) => !open)} className={outcomeOpen ? "active" : ""} aria-expanded={outcomeOpen} aria-label={outcomeOpen ? "关闭产物面板" : "打开产物面板"}><PanelRight /></IconButton></div></header>
      {routePending ? <WorkspaceRouteSkeleton /> : routeMissing ? <MissingSession onNew={newConversation} /> : <ConversationView conversation={selected} computerID={defaultComputer} onTaskCreated={(task, conversationID) => { queryClient.setQueryData<{ sessions: AgentSession[] }>(queryKeys.tasks, (current) => ({ ...(current ?? { sessions: [] }), sessions: upsertSession(current?.sessions ?? [], task) })); navigate({ kind: "session", sessionID: conversationID }, route.kind !== "session"); }} />}
    </main>
    <OutcomePanel open={outcomeOpen} task={selected?.turns.at(-1)} computerID={selected?.computerId ?? defaultComputer} onClose={() => setOutcomeOpen(false)} />
  </div>;
}

function ConversationView({ conversation, computerID, onTaskCreated }: { conversation?: Conversation; computerID?: string; onTaskCreated: (task: AgentSession, conversationID: string) => void }) {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<TurnView[]>([]);
  const [activeTask, setActiveTask] = useState<AgentSession | undefined>();
  const [error, setError] = useState("");
  const [loadingTranscript, setLoadingTranscript] = useState(Boolean(conversation));
  const [draft, setDraft] = useState("");
  const streamCursor = useRef(0);
  const pendingEvents = useRef<TaskEvent[]>([]);
  const flushTimer = useRef<number | undefined>(undefined);
  const pendingSubmit = useRef<{ signature: string; id: string; sessionID: string } | undefined>(undefined);
  const optimisticConversationID = useRef<string | undefined>(undefined);
  const transcriptCache = useRef(new Map<string, ConversationSnapshot>());
  const drafts = useRef(new Map<string, string>());
  const snapshot = useRef<ConversationSnapshot>({ fingerprint: "", turns: [], error: "", cursor: 0, scrollTop: 0, cachedAt: 0 });
  const feed = useRef<HTMLElement>(null);
  const followLiveEdge = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const conversationKey = conversation?.id ?? "new";
  const fingerprint = conversationFingerprint(conversation);

  useEffect(() => { setDraft(drafts.current.get(conversationKey) ?? ""); }, [conversationKey]);
  useEffect(() => {
    snapshot.current = { fingerprint, turns, activeTask, error, cursor: streamCursor.current, scrollTop: feed.current?.scrollTop ?? 0, cachedAt: Date.now() };
  }, [activeTask, error, fingerprint, turns]);

  useEffect(() => {
    if (!conversation) { streamCursor.current = 0; setTurns([]); setActiveTask(undefined); setLoadingTranscript(false); return; }
    // A draft becomes a real conversation after the create request succeeds.
    // The child already owns the optimistic turn, so this is not restoration.
    if (optimisticConversationID.current === conversation.id) {
      optimisticConversationID.current = undefined;
      snapshot.current = { ...snapshot.current, fingerprint };
      setLoadingTranscript(false);
      return () => { rememberConversation(transcriptCache.current, conversation.id, { ...snapshot.current, scrollTop: feed.current?.scrollTop ?? snapshot.current.scrollTop }); };
    }
    let cancelled = false;
    const cached = transcriptCache.current.get(conversation.id);
    if (cached) {
      const latest = conversation.turns.at(-1);
      const cachedActive = cached.activeTask;
      setTurns(cached.turns.map((turn) => turn.id === latest?.id ? { ...turn, state: latest.state } : turn));
      setActiveTask(cachedActive && latest && cachedActive.id === latest.id ? { ...cachedActive, state: latest.state } : cachedActive);
      setError(cached.error);
      streamCursor.current = cached.cursor;
      setLoadingTranscript(false);
      window.requestAnimationFrame(() => { if (feed.current) feed.current.scrollTop = cached.scrollTop; });
      snapshot.current = cached;
      if (isCompleteConversationSnapshot(cached.fingerprint, cached.turns.map((turn) => turn.id), fingerprint, conversation.turns.map((turn) => turn.id))) {
        return () => { rememberConversation(transcriptCache.current, conversation.id, { ...snapshot.current, scrollTop: feed.current?.scrollTop ?? snapshot.current.scrollTop }); };
      }
    } else {
      streamCursor.current = 0;
      snapshot.current = { fingerprint, turns: [], error: "", cursor: 0, scrollTop: 0, cachedAt: Date.now() };
      setLoadingTranscript(true);
      setTurns([]);
      setActiveTask(undefined);
      setError("");
    }
    followLiveEdge.current = true;
    setShowLatest(false);
    void restoreConversationTurns(conversation.turns).then((results) => {
      if (cancelled) return;
      const views: TurnView[] = [];
      let latestSession: AgentSession | undefined;
      let restoreError: unknown;
      for (const result of results) {
        if (result.status === "fulfilled") { views.push(result.value.view); latestSession = result.value.session; }
        else if (!restoreError) restoreError = result.reason;
      }
      setTurns(views);
      setActiveTask(latestSession ?? conversation.turns.at(-1));
      streamCursor.current = views.at(-1)?.cursor ?? 0;
      setError(restoreError ? `部分记录加载失败：${messageFor(restoreError)}` : "");
      setLoadingTranscript(false);
    });
    return () => { cancelled = true; rememberConversation(transcriptCache.current, conversation.id, { ...snapshot.current, scrollTop: feed.current?.scrollTop ?? snapshot.current.scrollTop }); };
  }, [conversation?.id]);

  useLayoutEffect(() => {
    const target = feed.current;
    if (!target || !followLiveEdge.current) return;
    target.scrollTop = target.scrollHeight;
  }, [turns, loadingTranscript]);

  function updateLiveEdge(target: HTMLElement) {
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
    followLiveEdge.current = distance < 80;
    setShowLatest(!followLiveEdge.current);
  }

  function jumpToLatest() {
    const target = feed.current;
    if (!target) return;
    followLiveEdge.current = true;
    target.scrollTop = target.scrollHeight;
    setShowLatest(false);
  }

  const applyPending = () => {
    flushTimer.current = undefined;
    const batch = pendingEvents.current.splice(0);
    if (!batch.length) return;
    setTurns((current) => current.map((turn, index) => {
      if (index !== current.length - 1) return turn;
      let next = turn;
      for (const event of batch) next = applyTaskEvent(next, event);
      return next;
    }));
    const terminalState = terminalStateFromEvents(batch);
    if (terminalState) setActiveTask((current) => current ? { ...current, state: terminalState } : current);
  };

  useEffect(() => {
    if (!activeTask || terminalStates.has(activeTask.state)) return;
    const close = subscribeToAgentStream(activeTask.id, {
      cursor: () => streamCursor.current,
      onTaskEvent: (item, cursor) => {
        streamCursor.current = Math.max(streamCursor.current, cursor);
        pendingEvents.current.push(item);
        if (!flushTimer.current) flushTimer.current = window.setTimeout(applyPending, 32);
      },
      onSession: (task) => {
        if (flushTimer.current) window.clearTimeout(flushTimer.current);
        flushTimer.current = undefined;
        const batch = pendingEvents.current.splice(0);
        setActiveTask(task);
        setTurns((current) => current.map((turn) => {
          if (turn.id !== task.id) return turn;
          let next = turn;
          for (const item of batch) next = applyTaskEvent(next, item);
          return reconcileTaskState(next, task);
        }));
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
        queryClient.invalidateQueries({ queryKey: ["artifacts", task.id] });
      },
    });
    return () => { close(); if (flushTimer.current) window.clearTimeout(flushTimer.current); };
  }, [activeTask?.id, activeTask?.state, queryClient]);

  type SubmitTask = { prompt: string; continueSession: boolean; request: { signature: string; id: string; sessionID: string } };
  const submit = useMutation({
    mutationFn: async ({ prompt, continueSession, request }: SubmitTask) => {
      if (!computerID) throw new Error("没有可用的运行环境，请稍后重试。");
      return api.createTask({ id: request.id, computer_id: computerID, session_id: request.sessionID, title: continueSession ? undefined : titleFromPrompt(prompt), prompt, continue: continueSession });
    },
    onMutate: ({ prompt, continueSession, request }: SubmitTask) => {
      if (!computerID) return;
      setError("");
      const provisional: AgentSession = { id: request.id, computer_id: computerID, session_id: request.sessionID, title: continueSession ? undefined : titleFromPrompt(prompt), state: "pending", created_at: new Date().toISOString() };
      setTurns((current) => [...current.filter((turn) => turn.id !== request.id), newTurnView(provisional, prompt)]);
      setLoadingTranscript(false);
    },
    onSuccess: (task, variables) => {
      const conversationID = variables.continueSession && conversation ? conversation.id : task.session_id;
      optimisticConversationID.current = conversationID;
      pendingSubmit.current = undefined;
      setTurns((current) => { const next = newTurnView(task, variables.prompt); return current.some((turn) => turn.id === task.id || turn.id === variables.request.id) ? current.map((turn) => turn.id === task.id || turn.id === variables.request.id ? next : turn) : [...current, next]; });
      setActiveTask(task); streamCursor.current = 0; onTaskCreated(task, conversationID);
    },
    onError: (reason, variables) => { setTurns((current) => current.filter((turn) => turn.id !== variables.request.id)); if (!(reason instanceof APIError) || !reason.retryable) pendingSubmit.current = undefined; setError(`任务未发送：${messageFor(reason)}`); },
  });
  async function cancel() { if (!activeTask || terminalStates.has(activeTask.state)) return; try { await api.cancelTask(activeTask.id); } catch (reason) { setError(messageFor(reason)); } }
  async function retry() { if (!activeTask) return; try { const task = await api.retryTask(activeTask.id, `turn-${crypto.randomUUID()}`); setTurns((current) => [...current, newTurnView(task, turns.at(-1)?.prompt ?? "")]); setActiveTask(task); onTaskCreated(task, task.session_id); } catch (reason) { setError(messageFor(reason)); } }

  return <div className="conversation-layout"><section ref={feed} onScroll={(event) => updateLiveEdge(event.currentTarget)} className="feed" aria-live="polite">
    {loadingTranscript && <ConversationSkeleton />}
    {!loadingTranscript && !turns.length && <Welcome computerID={computerID} onSuggestion={(prompt) => { drafts.current.set(conversationKey, prompt); setDraft(prompt); }} />}
    {turns.map((turn, index) => <Turn key={turn.id} turn={turn} active={index === turns.length - 1} cancelable={activeTask?.id === turn.id && !terminalStates.has(activeTask.state)} onCancel={() => void cancel()} onRetry={() => void retry()} />)}
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError("")} aria-label="关闭错误"><X className="size-3" /></button></div>}
  </section><div className="composer-dock">{showLatest && <button className="jump-latest" onClick={jumpToLatest}>回到最新进度</button>}<Composer value={draft} onValueChange={(value) => { drafts.current.set(conversationKey, value); setDraft(value); }} pending={submit.isPending || Boolean(activeTask && !terminalStates.has(activeTask.state))} onSubmit={async (prompt) => { const continueSession = Boolean(conversation); const signature = `${conversation?.id ?? "new"}:${prompt}`; if (!pendingSubmit.current || pendingSubmit.current.signature !== signature) pendingSubmit.current = { signature, id: `turn-${crypto.randomUUID()}`, sessionID: continueSession && conversation ? conversation.id : `session-${crypto.randomUUID()}` }; try { await submit.mutateAsync({ prompt, continueSession, request: pendingSubmit.current }); return true; } catch { return false; } }} /></div>
  </div>;
}

type ConversationSnapshot = { fingerprint: string; turns: TurnView[]; activeTask?: AgentSession; error: string; cursor: number; scrollTop: number; cachedAt: number };

function terminalStateFromEvents(events: TaskEvent[]): AgentSession["state"] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "task.succeeded") return "succeeded";
    if (event.type === "task.failed") return "failed";
    if (event.type === "task.canceled") return "canceled";
    if (event.type === "task.interrupted") return "interrupted";
  }
  return undefined;
}

function conversationFingerprint(conversation?: Conversation) {
  return conversation?.turns.map((turn) => `${turn.id}:${turn.state}:${turn.updated_at ?? ""}`).join("|") ?? "new";
}

function rememberConversation(cache: Map<string, ConversationSnapshot>, id: string, value: ConversationSnapshot) {
  cache.delete(id);
  cache.set(id, { ...value, turns: [...value.turns], cachedAt: Date.now() });
  while (cache.size > 12) cache.delete(cache.keys().next().value!);
}

async function restoreTurn(task: AgentSession) {
  let after = 0;
  let pages = 0;
  let session = task;
  let view = newTurnView(task);
  do {
    const page = await api.transcript(task.id, after);
    session = page.session;
    view.prompt = page.prompt ?? view.prompt;
    for (const event of page.events ?? []) view = applyTaskEvent(view, event);
    const next = Number(page.next_cursor) || 0;
    if (next > 0 && next <= after) throw new Error("会话游标没有继续前进");
    after = next;
    pages += 1;
    if (pages > 100) throw new Error("会话记录分页过多");
  } while (after > 0);
  view = reconcileTaskState(view, session);
  return { view: flushAgentOutput(view), session };
}

async function restoreConversationTurns(tasks: AgentSession[]) {
  type Restored = Awaited<ReturnType<typeof restoreTurn>>;
  const results: PromiseSettledResult<Restored>[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      try { results[index] = { status: "fulfilled", value: await restoreTurn(tasks[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()));
  return results;
}

function ConversationSkeleton() {
  return <div className="conversation-skeleton" role="status" aria-label="正在加载对话记录"><div className="skeleton-user" /><div className="skeleton-agent"><span /><span /><span /></div><small>正在加载对话记录…</small></div>;
}

function WorkspaceRouteSkeleton() {
  return <div className="conversation-layout"><section className="feed"><ConversationSkeleton /></section><div className="composer-dock"><div className="composer route-placeholder" aria-hidden="true" /></div></div>;
}

function MissingSession({ onNew }: { onNew: () => void }) {
  return <div className="conversation-layout"><section className="feed"><div className="missing-session" role="status"><BrandMark /><h1>找不到这个任务</h1><p>链接可能已失效，或当前账号没有访问该 Session 的权限。</p><Button tone="primary" onClick={onNew} leadingIcon={<MessageSquarePlus className="size-4" />}>新建任务</Button></div></section></div>;
}

function Welcome({ computerID, onSuggestion }: { computerID?: string; onSuggestion: (prompt: string) => void }) { const prompts = ["整理本周项目进度并生成 Markdown 报告", "分析这个仓库并提出可执行的优化方案", "创建一份可下载的演示文稿"]; return <section className="welcome"><div className="welcome-orbit"><BrandMark /><Sparkles className="welcome-spark" /></div><p className="welcome-kicker">YOUR AGENT COMPUTER</p><h1>今天想完成什么？</h1><p>描述目标，Agent 会在 <strong>{friendlyComputer(computerID)}</strong> 中完成检索、编写、运行与交付。</p><div className="suggestions">{prompts.map((prompt, index) => <button key={prompt} type="button" onClick={() => onSuggestion(prompt)}><span>{String(index + 1).padStart(2, "0")}</span>{prompt}</button>)}</div></section>; }

function Turn({ turn, active, cancelable, onCancel, onRetry }: { turn: TurnView; active: boolean; cancelable: boolean; onCancel: () => void; onRetry: () => void }) {
  const completed = terminalStates.has(turn.state);
  return <article className="turn"><div className="user-message"><p>{turn.prompt}</p></div>
    <div className="agent-message"><div className="agent-content">
      <LoopTimeline items={turn.timeline} active={active && !completed} terminal={completed} />
      {completed && turn.state === "succeeded" && <MessageArtifacts taskID={turn.id} />}
      {active && cancelable && <button className="text-action danger" onClick={onCancel}><CircleStop className="size-4" />停止生成</button>}
      {active && (turn.state === "failed" || turn.state === "canceled" || turn.state === "interrupted") && <button className="text-action" onClick={onRetry}><RefreshCw className="size-4" />重试本次任务</button>}
    </div></div>
  </article>;
}

function LoopTimeline({ items, active, terminal }: { items: TurnView["timeline"]; active: boolean; terminal: boolean }) {
  return <div className="loop-timeline" aria-label="Agent 执行过程">{items.map((item) => {
    if (item.kind === "assistant") return <div className="loop-answer" key={item.id}><MarkdownBlock className="markdown" animating={active} content={item.content} /></div>;
    if (item.kind === "tool") { const status = terminal && item.status === "running" ? "succeeded" : item.status; return <details className={`loop-tool ${status}`} key={item.id} open={status === "running"}><summary><span className="loop-marker">{status === "running" ? <LoaderCircle className="size-4 animate-spin" /> : status === "failed" ? <X className="size-4" /> : <Check className="size-4" />}</span><span><strong>{item.name}</strong><small>{status === "running" ? "正在执行" : status === "failed" ? "执行失败" : "已完成"}</small></span><ChevronDown className="loop-chevron size-4" /></summary><div className="loop-tool-detail">{item.args && <><span>输入</span><pre>{item.args}</pre></>}{item.preview && <><span>{status === "failed" ? "错误" : "输出"}</span><pre>{item.preview}</pre></>}</div></details>; }
    if (item.kind === "lifecycle") { const state = terminal && item.state === "running" ? "succeeded" : item.state; return <div className={`loop-lifecycle ${state}`} key={item.id}><span className="loop-marker">{state === "running" ? <LoaderCircle className="size-4 animate-spin" /> : state === "failed" ? <X className="size-4" /> : <Check className="size-4" />}</span><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span></div>; }
    if (item.kind === "context") return null;
    if (item.kind === "observation") return <div className="loop-note" key={item.id}>{item.detail}</div>;
    return <div className="assistant-error" key={item.id}>{item.detail}</div>;
  })}</div>;
}

function MarkdownBlock({ content, animating, className }: { content: string; animating: boolean; className?: string }) {
  return <Suspense fallback={<div className="markdown">{content}</div>}><Markdown content={content} animating={animating} className={className} /></Suspense>;
}

function Composer({ value, onValueChange, pending, onSubmit }: { value: string; onValueChange: (value: string) => void; pending: boolean; onSubmit: (prompt: string) => Promise<boolean> }) { const textarea = useRef<HTMLTextAreaElement>(null); async function submit(event: FormEvent) { event.preventDefault(); const prompt = value.trim(); if (!prompt || pending) return; onValueChange(""); if (!await onSubmit(prompt)) onValueChange(prompt); }
  useLayoutEffect(() => { const target = textarea.current; if (!target) return; target.style.height = "0px"; target.style.height = `${Math.min(target.scrollHeight, 220)}px`; }, [value]);
  return <form className={`composer ${pending ? "pending" : ""}`} aria-busy={pending} onSubmit={submit}><textarea ref={textarea} value={value} onChange={(event) => onValueChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={pending ? "Agent 正在处理当前任务…" : "给 Agent 发送任务…"} rows={1} disabled={pending} /><div className="composer-footer"><span><Terminal className="size-3" />{pending ? "当前任务执行中" : "Enter 发送 · Shift+Enter 换行"}</span><button className="send-button" disabled={!value.trim() || pending} aria-label="发送任务">{pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-5" />}</button></div></form>; }

function OutcomePanel({ open, task, computerID, onClose }: { open: boolean; task?: AgentSession; computerID?: string; onClose: () => void }) {
  return <aside className={`outcome-panel ${open ? "open" : ""}`} aria-label="交付产物" aria-hidden={!open}>{open && <><header><div><p className="eyebrow">OUTCOME</p><h2>交付与产物</h2></div><IconButton onClick={onClose} aria-label="关闭产物面板"><X /></IconButton></header><Tabs.Root defaultValue="artifacts" className="outcome-tabs"><Tabs.List aria-label="交付信息"><Tabs.Trigger value="artifacts"><FileArchive className="size-4" />产物</Tabs.Trigger><Tabs.Trigger value="changes"><FolderOpen className="size-4" />文件与 Diff</Tabs.Trigger><Tabs.Trigger value="git"><Cloud className="size-4" />Git</Tabs.Trigger></Tabs.List><Tabs.Content value="artifacts" className="outcome-content"><OutcomeArtifacts task={task} /></Tabs.Content><Tabs.Content value="changes" className="outcome-content"><WorkspacePanel computerID={computerID} /></Tabs.Content><Tabs.Content value="git" className="outcome-content"><GitPanel task={task} computerID={computerID} /></Tabs.Content></Tabs.Root></>}</aside>;
}

function WorkspacePanel({ computerID }: { computerID?: string }) {
  const [path, setPath] = useState(""); const [listing, setListing] = useState<WorkspaceResult>(); const [preview, setPreview] = useState<WorkspaceResult>(); const [status, setStatus] = useState(""); const [pending, setPending] = useState(false);
  const load = async (kind: "list" | "read" | "diff", target = path) => { if (!computerID) return; setPending(true); setStatus(kind === "diff" ? "正在生成 Git diff…" : "正在读取 Workspace…"); try { const result = await workspaceOperation(computerID, kind, target); if (kind === "list") { setListing(result); setPath(result.path ?? target); setPreview(undefined); setStatus(result.truncated ? "仅显示前 1000 项" : `${result.entries?.length ?? 0} 项`); } else { setPreview(result); setStatus(kind === "diff" ? "Diff 已更新" : "文件已读取"); } } catch (reason) { setStatus(messageFor(reason)); } finally { setPending(false); } };
  useEffect(() => { if (computerID) void load("list", ""); }, [computerID]);
  const download = () => { if (!preview?.data) return; const blob = new Blob([base64Bytes(preview.data)], { type: preview.content_type ?? "application/octet-stream" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = (preview.path ?? "workspace-file").split("/").at(-1) ?? "workspace-file"; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); };
  if (!computerID) return <EmptyOutcome label="选择在线运行环境后可查看 Workspace。" />;
  return <div className="workspace-panel"><div className="workspace-toolbar"><IconButton onClick={() => void load("list", parentPath(path))} disabled={pending || !path} aria-label="返回上级"><ArrowLeft className="size-4" /></IconButton><IconButton onClick={() => void load("list")} disabled={pending} aria-label="刷新文件"><RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} /></IconButton><Button tone="quiet" size="sm" onClick={() => void load("diff")} disabled={pending}>查看 Diff</Button></div><p className="workspace-path">/{path}</p>{status && <p className="workspace-status">{status}</p>}<div className="workspace-list">{listing?.entries?.map((entry) => <WorkspaceEntryRow entry={entry} key={entry.path} onOpen={() => entry.type === "directory" ? void load("list", entry.path) : void load("read", entry.path)} />)}</div>{preview && <div className="file-preview"><div><strong>{preview.path ?? "Workspace"}</strong><Button tone="quiet" size="sm" onClick={download} disabled={!preview.data} leadingIcon={<Download className="size-3" />}>下载</Button></div><pre>{isTextContent(preview.content_type) ? decodeBase64(preview.data) : "二进制文件，请下载查看。"}</pre></div>}</div>;
}

function WorkspaceEntryRow({ entry, onOpen }: { entry: WorkspaceEntry; onOpen: () => void }) { return <button className="workspace-entry" onClick={onOpen}><FolderOpen className={`size-4 ${entry.type === "directory" ? "text-lime-300" : "text-slate-400"}`} /><span>{entry.name}</span><small>{entry.type === "file" ? formatBytes(entry.size) : "文件夹"}</small></button>; }

function GitPanel({ task, computerID }: { task?: AgentSession; computerID?: string }) { const providers = useQuery({ queryKey: ["git-providers"], queryFn: api.gitProviders, staleTime: 60_000 }); const [providerID, setProviderID] = useState(""); const [result, setResult] = useState(""); const [pending, setPending] = useState(false); useEffect(() => { if (!providerID && providers.data?.providers?.[0]) setProviderID(providers.data.providers[0].id); }, [providerID, providers.data]); const submit = async () => { if (!task || task.state !== "succeeded" || !computerID || !providerID) return; setPending(true); setResult("正在创建独立分支与 Pull Request…"); try { const operation = await gitOperation(computerID, task.id, providerID); const link = operation.result?.pull_request_url; setResult(link ? `PR #${operation.result?.pull_request_number ?? ""} 已创建：${link}` : `交付已完成：${operation.branch ?? "新分支"}`); } catch (reason) { setResult(messageFor(reason)); } finally { setPending(false); } }; if (!task) return <EmptyOutcome label="选择已完成任务后可创建 Pull Request。" />; return <div className="git-panel"><p>将当前任务的变更推送到独立分支，并创建可审阅的 Pull Request。</p>{providers.isPending && <div className="center-state"><LoaderCircle className="size-4 animate-spin" />读取 Git 仓库…</div>}{providers.data?.providers?.length ? <><label className="select-label">目标仓库<select value={providerID} onChange={(event) => setProviderID(event.target.value)}>{providers.data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.display_name ?? provider.id}</option>)}</select></label><Button tone="primary" fullWidth onClick={() => void submit()} disabled={pending || task.state !== "succeeded"} leadingIcon={pending && <LoaderCircle className="size-4 animate-spin" />}>{pending ? "正在交付" : "创建 Pull Request"}</Button></> : <EmptyOutcome label="当前 Workspace 没有配置 Git 仓库。" />}{result && <p className="git-result">{result}</p>}</div>; }
function EmptyOutcome({ label }: { label: string }) { return <div className="empty-outcome"><MoreHorizontal className="size-5" />{label}</div>; }
function upsertSession(sessions: AgentSession[], task: AgentSession) { const index = sessions.findIndex((session) => session.id === task.id); if (index < 0) return [...sessions, task]; const next = [...sessions]; next[index] = task; return next; }
function taskStateTone(state?: AgentSession["state"]): "active" | "success" | "danger" { if (state === "succeeded") return "success"; if (state === "failed" || state === "canceled" || state === "interrupted") return "danger"; return "active"; }
function taskStateLabel(state?: AgentSession["state"]) { if (state === "succeeded") return "已完成"; if (state === "failed") return "失败"; if (state === "canceled") return "已停止"; if (state === "interrupted") return "已中断"; return "进行中"; }
function initials(value: string) { return value.trim().slice(0, 2).toUpperCase() || "Z"; }
function formatBytes(value?: number) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }
function parentPath(value: string) { const parts = value.split("/").filter(Boolean); parts.pop(); return parts.join("/"); }
function base64Bytes(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function decodeBase64(value?: string) { if (!value) return ""; try { return new TextDecoder().decode(base64Bytes(value)); } catch { return "[无法解码的文件内容]"; } }
function isTextContent(contentType?: string) { const value = (contentType ?? "").toLowerCase(); return value.startsWith("text/") || value.includes("json") || value.includes("javascript") || value.includes("xml") || value.includes("yaml"); }
function messageFor(reason: unknown) { if (reason instanceof APIError) { if (reason.code === "computer_offline") return "运行环境当前离线，请等待节点恢复后重试。"; if (reason.code === "capacity_timeout") return "运行池当前没有可用容量，请稍后重试。"; if (reason.code === "dispatch_timeout") return "等待运行环境超时，请稍后重试。"; return reason.message; } if (reason instanceof Error) return reason.message; return "发生未知错误，请稍后重试。"; }
