import type { ToolDefinition } from "../tools/types.js";
import type { ToolEffects } from "../tools/effects.js";
import type { ToolId, ToolSource } from "../tools/manifest.js";

export interface ResolvedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  order?: number;
  sourceStep?: number;
}

export interface AgentIdentity {
  id?: string;
  kind?: "root" | "explore" | "plan" | "general" | string;
  runId?: string;
}

export interface WorkspaceIdentity {
  id?: string;
  root: string;
  mode?: "root" | "shared-readonly" | "isolated-write";
  sandbox?: "enforced" | "none";
  /** Host-owned standalone Git directory of a writing Agent's private clone.
   * Never derived from tool arguments, repository files or linked worktrees. */
  privateGitDirectory?: string;
  /** Optional Host-recorded identity of the privately created Git directory. */
  privateGitIdentity?: { device: string; inode: string };
  /** Extra relative paths selected by the Host, never by tool arguments. */
  protectedWorkspacePaths?: readonly string[];
}

export interface CapabilityGrant {
  callId: string;
  expiresAt: number;
  filesystem?: {
    read: string[];
    write: string[];
  };
  network?: {
    destinations: string[];
    methods: string[];
  };
  process?: {
    spawn: boolean;
  };
  external?: Array<{
    system: string;
    operations: string[];
    resource?: string;
  }>;
  workspace?: ToolEffects["workspace"];
}

export interface ApprovalRequest {
  call: ResolvedToolCall;
  effects: ToolEffects;
  proposedGrant: CapabilityGrant;
  /** Host policy opt-in: start this grant lifetime after approval completes.
   * Omitted custom policies retain their absolute proposedGrant expiry. */
  grantTtlMs?: number;
}

export interface PolicyRequest {
  call: ResolvedToolCall;
  toolId: ToolId;
  source: ToolSource;
  definition: ToolDefinition;
  effects: ToolEffects;
  actor?: AgentIdentity;
  workspace: WorkspaceIdentity;
  interactive: boolean;
}

export type PolicyDecision =
  | { decision: "allow"; grant: CapabilityGrant; reason: string }
  | { decision: "ask"; request: ApprovalRequest; reason: string }
  | { decision: "deny"; reason: string };

export interface ToolPolicyEngine {
  evaluate(request: Readonly<PolicyRequest>): PolicyDecision | Promise<PolicyDecision>;
}
