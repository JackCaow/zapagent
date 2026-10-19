export type SessionState =
  | "idle"
  | "queued"
  | "pending"
  | "leased"
  | "running"
  | "canceling"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export interface RuntimeProfile {
  id: string;
  display_name?: string;
  model?: string;
}

export interface BrowserSession {
  authenticated: boolean;
  project_id?: string;
  user_id?: string;
  display_name?: string;
  user_display_name?: string;
  auth_method?: "token" | "invite" | "oidc";
  role?: "owner" | "admin" | "operator" | "member" | "viewer";
  csrf_token?: string;
  expires_at?: string;
  runtime_profile?: RuntimeProfile;
}

export interface ComputerLifecycleResult {
  action: "wake" | "release";
  accepted: boolean;
  operation_id?: string;
}

export interface AuthOptions {
  oidc?: {
    display_name: string;
    start_url: string;
  };
}

export interface Computer {
  id: string;
  state?: string;
  desired_state?: "running" | "stopped";
  observed_state?: "unavailable" | "ready" | "busy" | "degraded";
  assigned_node_id?: string;
  placement_epoch?: number;
  last_activity_at?: string;
  failure_code?: string;
}

export type WorkspaceRole = "owner" | "admin" | "operator" | "member" | "viewer";
export interface WorkspaceMember { user_id: string; display_name?: string; email?: string; role: WorkspaceRole; status: "active" | "suspended"; created_at?: string; updated_at?: string }
export interface HostPool { id: string; display_name: string; region?: string; enabled: boolean; max_computers: number; labels?: Record<string,string>; node_ids?: string[] }
export interface PlatformNode { id: string; generation: string; state: "online"|"offline"|"draining"; capacity: number; in_flight: number; region?: string; daemon_state?: string; last_heartbeat?: string; node_version?: string; daemon_version?: string }
export interface ModelProfile { id: string; display_name: string; provider_url: string; provider_model: string; credential_id: string; enabled: boolean }
export interface AgentProfile { id: string; display_name: string; runtime_ref: string; model_id: string; enabled: boolean; configuration?: Record<string,unknown> }
export interface ComputerProfile { id: string; display_name: string; pool_id: string; agent_id: string; vcpu: number; memory_bytes: number; browser_enabled: boolean; created_by?: string }
export interface CredentialDescriptor { id: string; version: number; state: string; created_at?: string; updated_at?: string }
export interface WorkspaceQuota { max_computers: number; max_concurrent_tasks: number; monthly_task_seconds: number; artifact_bytes: number; updated_at?: string }
export interface WorkspaceUsage { period_start: string; task_count: number; task_seconds: number; artifact_bytes: number; running_tasks: number; computer_count: number }

export interface AgentSession {
  id: string;
  computer_id: string;
  session_id: string;
  title?: string;
  retry_of?: string;
  state: SessionState;
  attempt?: number;
  created_at?: string;
  updated_at?: string;
  result_sha256?: string;
  failure_code?: string;
  queue_reason?: "dispatch_wait" | "capacity_wait" | "node_offline" | "computer_starting";
  queue_deadline?: string;
}

export interface AgentSessionsResponse {
  sessions: AgentSession[];
  next_cursor?: number;
}

export interface TaskEvent {
  cursor?: number;
  type?: string;
  data?: string;
  stream?: string;
  error?: string;
  [key: string]: unknown;
}

export interface TranscriptResponse {
  session: AgentSession;
  prompt?: string;
  events: TaskEvent[];
  next_cursor?: number;
}

export interface Artifact {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  content_type?: string;
  created_at?: string;
  state?: "available" | "pending" | "expired" | "failed";
  sha256?: string;
  expires_at?: string;
}

export interface ArtifactListResponse {
  artifacts: Artifact[];
}

export interface ArtifactDownload {
  url: string;
  filename?: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "directory" | "file" | string;
  size?: number;
}

export interface WorkspaceResult {
  path?: string;
  entries?: WorkspaceEntry[];
  truncated?: boolean;
  data?: string;
  content_type?: string;
  size?: number;
  sha256?: string;
}

export interface WorkspaceOperation {
  id: string;
  state: "pending" | "leased" | "succeeded" | "failed";
  failure_code?: string;
  branch?: string;
  result?: WorkspaceResult & {
    commit_sha?: string;
    pull_request_number?: number;
    pull_request_url?: string;
  };
}

export interface GitProvider {
  id: string;
  display_name?: string;
}

export interface ToolItem {
  id: string;
  name: string;
  summary?: string;
  status: "running" | "succeeded" | "failed";
}

export type TimelineItem =
  | { id: string; kind: "lifecycle"; label: string; detail?: string; state: "running" | "succeeded" | "failed" }
  | { id: string; kind: "assistant"; content: string }
  | { id: string; kind: "tool"; name: string; args?: string; preview?: string; status: "running" | "succeeded" | "failed" }
  | { id: string; kind: "context"; detail: string }
  | { id: string; kind: "observation"; detail: string }
  | { id: string; kind: "error"; detail: string };

export interface TurnView {
  id: string;
  prompt: string;
  state: SessionState;
  phase: string;
  phaseDetail: string;
  assistant: string;
  result?: string;
  error?: string;
  tools: ToolItem[];
  timeline: TimelineItem[];
  technical: string[];
  artifactDelivery?: "pending" | "available" | "empty" | "failed";
  artifactCount?: number;
  cursor: number;
  rawBuffer: string;
}

export interface Conversation {
  id: string;
  computerId: string;
  title: string;
  turns: AgentSession[];
  updatedAt?: string;
}
