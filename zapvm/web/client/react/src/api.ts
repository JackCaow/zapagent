import type {
  AgentSession,
  AgentSessionsResponse,
  ArtifactDownload,
  ArtifactListResponse,
  AuthOptions,
  BrowserSession,
  Computer,
  ComputerLifecycleResult,
  TaskEvent,
  TranscriptResponse,
  GitProvider,
  WorkspaceMember, HostPool, PlatformNode, ModelProfile, AgentProfile, ComputerProfile, CredentialDescriptor, WorkspaceQuota, WorkspaceUsage,
  WorkspaceOperation,
  WorkspaceResult,
} from "./types";

let csrfToken = "";

export class APIError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, status: number, code?: string, retryable = false) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function setCSRFToken(token?: string) {
  csrfToken = token ?? "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken && !["GET", "HEAD"].includes(init?.method?.toUpperCase() ?? "GET")) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", headers });
  } catch (reason) {
    if (reason instanceof DOMException && (reason.name === "AbortError" || reason.name === "TimeoutError")) {
      throw new APIError("服务响应超时，可重新读取。", 504, "request_timeout", true);
    }
    throw reason;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body = text ? safeJSON(text) : undefined;
  if (!response.ok) {
    const envelope = body as { error?: { message?: string; code?: string; retryable?: boolean }; message?: string; code?: string; retryable?: boolean } | undefined;
    const descriptor = envelope?.error ?? envelope;
    throw new APIError(descriptor?.message ?? descriptor?.code ?? `请求失败（${response.status}）`, response.status, descriptor?.code, descriptor?.retryable === true);
  }
  return (body ?? text) as T;
}

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export const api = {
  session: () => request<BrowserSession>("/api/session"),
  authOptions: () => request<AuthOptions>("/auth/options"),
  login: (projectToken: string) => request<BrowserSession>("/auth/login", { method: "POST", body: JSON.stringify({ access_token: projectToken }) }),
  redeemInvite: (inviteToken: string) => request<BrowserSession>("/auth/invite", { method: "POST", body: JSON.stringify({ invite_token: inviteToken }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  computers: () => request<{ computers: Computer[] }>("/api/agent/computers"),
  adminComputers: () => request<{ computers: Computer[] }>("/api/admin/computers"),
  computerLifecycle: (computerID: string, action: "wake" | "release") => request<ComputerLifecycleResult>(`/api/admin/computers/${encodeURIComponent(computerID)}/lifecycle`, { method: "POST", body: JSON.stringify({ action }) }),
  platformMe: () => request<WorkspaceMember>("/api/admin/platform/me"),
  members: () => request<{ members: WorkspaceMember[] }>("/api/admin/platform/members"),
  putMember: (member: WorkspaceMember) => request<WorkspaceMember>("/api/admin/platform/members", { method: "PUT", body: JSON.stringify(member) }),
  deleteMember: (id: string) => request<void>(`/api/admin/platform/members/${encodeURIComponent(id)}`, { method: "DELETE" }),
  hostPools: () => request<{ host_pools: HostPool[] }>("/api/admin/platform/host-pools"),
  putHostPool: (pool: HostPool) => request<HostPool>("/api/admin/platform/host-pools", { method: "PUT", body: JSON.stringify(pool) }),
  deleteHostPool: (id: string) => request<void>(`/api/admin/platform/host-pools/${encodeURIComponent(id)}`, { method: "DELETE" }),
  platformNodes: () => request<{ nodes: PlatformNode[] }>("/api/admin/platform/nodes"),
  drainNode: (id: string, generation: string, draining: boolean) => request<PlatformNode>(`/api/admin/platform/nodes/${encodeURIComponent(id)}/drain`, { method: "POST", body: JSON.stringify({ generation, draining }) }),
  models: () => request<{ models: ModelProfile[] }>("/api/admin/platform/models"),
  putModel: (profile: ModelProfile) => request<ModelProfile>("/api/admin/platform/models", { method: "PUT", body: JSON.stringify(profile) }),
  deleteModel: (id: string) => request<void>(`/api/admin/platform/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  agents: () => request<{ agents: AgentProfile[] }>("/api/admin/platform/agents"),
  putAgent: (profile: AgentProfile) => request<AgentProfile>("/api/admin/platform/agents", { method: "PUT", body: JSON.stringify(profile) }),
  deleteAgent: (id: string) => request<void>(`/api/admin/platform/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  computerProfiles: () => request<{ computers: ComputerProfile[] }>("/api/admin/platform/computers"),
  createComputer: (profile: ComputerProfile) => request<ComputerProfile>("/api/admin/platform/computers", { method: "POST", body: JSON.stringify(profile) }),
  deleteComputer: (id: string) => request<void>(`/api/admin/platform/computers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  credentials: () => request<{ credentials: CredentialDescriptor[] }>("/api/admin/platform/credentials"),
  putCredential: (id: string, value: string) => {
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    return request<CredentialDescriptor>(`/api/admin/platform/credentials/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ value: encoded }) });
  },
  deleteCredential: (id: string) => request<CredentialDescriptor>(`/api/admin/platform/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),
  quota: () => request<WorkspaceQuota>("/api/admin/platform/quota"),
  putQuota: (quota: WorkspaceQuota) => request<WorkspaceQuota>("/api/admin/platform/quota", { method: "PUT", body: JSON.stringify(quota) }),
  usage: () => request<WorkspaceUsage>("/api/admin/platform/usage"),
  sessions: () => request<AgentSessionsResponse>("/api/agent/sessions?after=0&limit=1000"),
  task: (id: string) => request<AgentSession>(`/api/agent/sessions/${encodeURIComponent(id)}`),
  transcript: (id: string, after = 0) => request<TranscriptResponse>(`/api/agent/sessions/${encodeURIComponent(id)}/transcript?after=${after}&limit=1000`),
  createTask: (payload: { id: string; computer_id: string; session_id: string; title?: string; prompt: string; continue?: boolean }) =>
    request<AgentSession>("/api/agent/sessions", { method: "POST", body: JSON.stringify(payload) }),
  cancelTask: (id: string) => request<void>(`/api/agent/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  retryTask: (id: string, retryID: string) => request<AgentSession>(`/api/agent/sessions/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ id: retryID }) }),
  artifacts: (id: string) => request<ArtifactListResponse>(`/api/agent/sessions/${encodeURIComponent(id)}/artifacts?after=0&limit=1000`, { signal: AbortSignal.timeout(10_000) }),
  artifactDownload: (artifactID: string) => request<ArtifactDownload>(`/api/agent/artifacts/${encodeURIComponent(artifactID)}/download`),
  gitProviders: () => request<{ providers: GitProvider[] }>("/api/agent/git/providers"),
};

async function waitForOperation(get: () => Promise<WorkspaceOperation>, terminal = 60): Promise<WorkspaceOperation> {
  for (let attempt = 0; attempt < terminal; attempt += 1) {
    const operation = await get();
    if (operation.state === "succeeded" || operation.state === "failed") return operation;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new APIError("运行环境响应超时，请稍后刷新查看结果。", 504, "operation_pending");
}

export async function workspaceOperation(computerID: string, kind: "list" | "read" | "diff", path = ""): Promise<WorkspaceResult> {
  const id = `workspace-${crypto.randomUUID()}`;
  const base = `/api/agent/computers/${encodeURIComponent(computerID)}/workspace/operations`;
  const created = await request<WorkspaceOperation>(base, { method: "POST", body: JSON.stringify({ id, kind, path }) });
  const operation = created.state === "succeeded" || created.state === "failed" ? created : await waitForOperation(() => request<WorkspaceOperation>(`${base}/${encodeURIComponent(id)}`));
  void request<void>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
  if (operation.state === "failed") throw new APIError(`文件操作失败：${operation.failure_code ?? "workspace_failed"}`, 422, operation.failure_code);
  return operation.result ?? {};
}

export async function gitOperation(computerID: string, taskID: string, providerID: string): Promise<WorkspaceOperation> {
  const material = new TextEncoder().encode(`${taskID}:${computerID}:${providerID}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  const id = `git-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
  const base = `/api/agent/computers/${encodeURIComponent(computerID)}/git/operations`;
  const created = await request<WorkspaceOperation>(base, { method: "POST", body: JSON.stringify({ id, task_id: taskID, provider_id: providerID }) });
  const operation = created.state === "succeeded" || created.state === "failed" ? created : await waitForOperation(() => request<WorkspaceOperation>(`${base}/${encodeURIComponent(id)}`), 240);
  if (operation.state === "failed") throw new APIError(`PR 交付失败：${operation.failure_code ?? "git_delivery_failed"}`, 422, operation.failure_code);
  return operation;
}

export function decodeEventData(event: TaskEvent): string {
  if (typeof event.data === "string" && event.data) {
    try {
      const bytes = Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return event.data;
    }
  }
  if (typeof event.error === "string") return event.error;
  return "";
}
