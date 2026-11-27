import { useCallback, useEffect, useRef, useState } from "react"
import type { AppConfig } from "../config.js"
import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"
import type { ApprovalChoice } from "../ui/dialog-approval.js"
import { appLogger, permissionManager } from "../singletons.js"
import { ApprovalQueue } from "../approval-queue.js"
import { getCurrentSessionId } from "../session.js"
import { REQUEST_CAPABILITIES_TOOL } from "../capabilities.js"
import type { WorkspaceAccess } from "../workspace-access.js"
import { evaluateApprovalPolicy } from "../permission-policy.js"
import { buildToolGrantRules, type ToolGrantRequest } from "../tool-grants.js"
import type { PermissionRule } from "../permissions.js"
import { buildEditPreview, isEditTool } from "../ui/edit-preview.js"
import { getToolAlias } from "../ui/transcript-format.js"
import type { ApprovalCallback, ApprovalContext, ApprovalResponse } from "../../zapsdk/tools/executor.js"

type AddLog = (
  type: LogType,
  text: string,
  tool?: ToolCallInfo,
  images?: UserImageRef[],
  agentPath?: string[],
  extra?: Partial<LogEntry>,
) => void

interface PendingApproval {
  id: string
  context?: Readonly<ApprovalContext>
  name: string
  args: Record<string, unknown>
  allowScope: boolean
  projectAccess: boolean
  /** One-time approvals of the same consent earlier this session. */
  repeats: number
  resolve: (choice: ApprovalChoice) => void
  grant: (request: ToolGrantRequest, availableTools: string[], reviewedRules?: readonly PermissionRule[]) => string | void
}

export interface UsePermissionApprovalOptions {
  /** Read live configuration when deciding and settling an approval. */
  configRef: React.MutableRefObject<AppConfig>
  access: WorkspaceAccess
  allowProjectCommands: () => void
  effectiveMode?: (actorRun?: string) => AppConfig["permissionMode"]
  addLog: AddLog
}

export interface UsePermissionApprovalResult {
  /** Pass the factual decision source to the shared executor. */
  onApproval: ApprovalCallback
  /** Current pending approval, or null when no prompt is active. App renders
   *  <ApprovalBar /> when this is non-null. */
  pendingApproval: PendingApproval | null
}

/** Applies explicit restrictions before routine project authorization. */
export function usePermissionApproval(
  opts: UsePermissionApprovalOptions,
): UsePermissionApprovalResult {
  const { configRef, addLog, effectiveMode, access, allowProjectCommands } = opts
  const sessionId = getCurrentSessionId()
  permissionManager.setSessionId(sessionId)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const queueRef = useRef<ApprovalQueue | null>(null)
  if (!queueRef.current) queueRef.current = new ApprovalQueue(getCurrentSessionId)
  const queue = queueRef.current
  useEffect(() => { queue.cancelStale() }, [queue, sessionId])
  useEffect(() => () => queue.cancelAll(), [queue])

  const evaluate = useCallback((name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>) => {
    const run = context?.actor?.runId
    const mode = effectiveMode?.(run) ?? configRef.current.permissionMode
    const decision = evaluateApprovalPolicy(permissionManager, name, args, {
      mode,
      cwd: process.cwd(),
      context,
      hostCommands: configRef.current.allowUnsandboxedCommands === false ? "disabled"
        : name === "bash" && access.canRunHostCommands(getCurrentSessionId(), run) ? "trusted" : "untrusted",
    })
    return { mode, decision }
  }, [access, configRef, effectiveMode])

  const promptApproval = useCallback(
    async (
      name: string,
      ar: Record<string, unknown>,
      signal: AbortSignal | undefined,
      allowScope: boolean,
      projectAccess: boolean,
      context?: Readonly<ApprovalContext>,
      id = "",
    ): Promise<ApprovalResponse> => {
      const sessionId = getCurrentSessionId()
      if (signal?.aborted) return false
      // For edit/create tools, push a scrollback "approval" log carrying the
      // proposed diff *before* showing the live ApprovalBar. The entry is
      // finalized at addLog time (no replaceLog) so it commits to Static
      // immediately and its tall diff body never participates in the
      // dynamic-frame diff path. The approve/deny outcome lands as a
      // separate follow-up system log below.
      if (isEditTool(name)) {
        const preview = await buildEditPreview(name, ar)
        if (signal?.aborted) return false
        addLog("approval", "proposed", {
          name,
          arguments: ar,
          meta: preview
            ? {
                diff: preview.diff,
                filetype: preview.filetype,
                oldBytes: preview.oldBytes,
                newBytes: preview.newBytes,
                isNewFile: preview.isNewFile,
                skipped: preview.skipped,
              }
            : undefined,
        })
      }
      return new Promise<ApprovalResponse>((resolveBool) => {
        const clear = () => setPendingApproval(current => current?.id === id ? null : current)
        let settled = false
        let abortListener: (() => void) | undefined
        const settle = (value: ApprovalResponse) => {
          if (settled) return
          settled = true
          if (signal && abortListener) signal.removeEventListener("abort", abortListener)
          resolveBool(value)
        }
        abortListener = () => {
          clear()
          settle(false)
        }
        if (signal) {
          signal.addEventListener("abort", abortListener, { once: true })
          if (signal.aborted) {
            abortListener()
            return
          }
        }
        let scopeAllowed = allowScope
        const validate = (): string | undefined => {
          if (settled || signal?.aborted) return "Approval expired"
          if (getCurrentSessionId() !== sessionId) {
            clear()
            settle({ approved: false, source: "approval", reason: "approval session changed" })
            return "Approval session changed"
          }
          const { decision: current } = evaluate(name, ar, context)
          if (current.decision === "ask" && (!current.allowScope || (projectAccess && current.source !== "project"))) scopeAllowed = false
          if (current.decision === "deny") {
            clear()
            settle({ approved: false, source: "policy", reason: current.reason })
            return current.reason
          }
          return undefined
        }
        setPendingApproval({
          id,
          context,
          name,
          args: ar,
          allowScope,
          projectAccess,
          repeats: projectAccess || name === REQUEST_CAPABILITIES_TOOL ? 0 : permissionManager.priorOnceApprovals(name, ar, context),
          grant: (request, availableTools, reviewedRules) => {
            const expired = validate()
            if (expired) return expired
            if (!scopeAllowed || projectAccess) return "This approval only supports its displayed choices"
            try {
              const rules = buildToolGrantRules(request, availableTools, context?.workspaceRoot ?? process.cwd(), reviewedRules)
              if (!permissionManager.grantCoversCall(rules, name, ar, context)) return "The selected authorization must cover this waiting call"
              permissionManager.addToolRules(rules, request.lifetime)
              addLog("system", `Permission: ${request.lifetime} allow saved: ${rules.map(rule => rule.pattern).join(", ")}; manage in /permissions`)
              clear()
              settle(true)
            } catch (error) { return String(error) }
          },
          resolve: (choice) => {
            if (validate()) return
            clear()
            // A stale or synthetic scope choice cannot extend a one-time prompt.
            if ((!scopeAllowed || (projectAccess && choice === "always")) && choice !== "deny") choice = "once"
            try { appLogger.info("permission_user", { tool: name, choice }) } catch {}
            if (projectAccess && choice === "forever") {
              try { allowProjectCommands(); addLog("system", "Project access saved. Manage it in /permissions.") }
              catch (error) {
                addLog("error", `Could not save project access: ${String(error)}`)
                settle(false)
                return
              }
            } else if (choice === "always") {
              try {
                permissionManager.addSessionRule(name, ar, context)
                addLog("system", `Permission: session allow added for ${getToolAlias(name)}`)
              } catch (error) { addLog("error", `Could not save session tool authorization: ${String(error)}. Approved this command only.`) }
            } else if (choice === "forever") {
              try {
                permissionManager.addProjectRule(name, ar, context)
                addLog("system", `Permission: project allow added for ${getToolAlias(name)} (saved to user project grants)`)
              } catch (error) { addLog("error", `Could not save project tool authorization: ${String(error)}. Approved this command only.`) }
            } else if (choice === "deny") {
              addLog("system", `Permission: user denied ${getToolAlias(name)}`)
            }
            if (choice === "deny") permissionManager.recordDenial(name, ar, context)
            else if (choice === "once") permissionManager.recordOnceApproval(name, ar, context)
            settle(choice !== "deny" ? true : { approved: false, source: "approval", reason: "user declined approval; do not retry the same request this turn" })
          },
        })
      })
    },
    [addLog, allowProjectCommands, evaluate],
  )

  /** Policy decision without a human. Unsettled ones are logged only when
   * the queue reaches them, so a precheck never logs twice. */
  const decide = useCallback(
    (toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>, logAsk = true) => {
      permissionManager.setSessionId(getCurrentSessionId())
      const { mode, decision } = evaluate(toolName, args, context)
      if (decision.decision === "ask" && !logAsk) return decision
      try { appLogger.info("permission_decision", { tool: toolName, mode, decision: decision.decision, category: decision.category, tier: decision.tier, source: decision.source, reason: decision.reason }) } catch {}
      if (decision.decision === "deny") addLog("system", `Permission: denied ${getToolAlias(toolName)} — ${decision.reason}`)
      return decision
    },
    [addLog, evaluate],
  )

  const queued = useCallback(
    (toolName: string, args: Record<string, unknown>, signal?: AbortSignal, context?: Readonly<ApprovalContext>): Promise<ApprovalResponse> => {
      queue.cancelStale()
      return queue.enqueue(async (signal, id) => {
        if (signal?.aborted) return Promise.resolve(false)
        // Re-decided when the prompt's turn comes: an earlier answer may cover it.
        const decision = decide(toolName, args, context)
        if (decision.decision === "allow") return Promise.resolve(true)
        if (decision.decision === "deny") return Promise.resolve({ approved: false, source: "policy", reason: decision.reason })
        if (decision.source === "dangerous") addLog("system", `Approval required for ${decision.reason}`)
        return promptApproval(toolName, args, signal, decision.allowScope, decision.source === "project" && decision.allowScope, context, id)
      }, signal)
    },
    [addLog, decide, promptApproval, queue],
  )

  // Calls the policy settles never wait behind an open prompt.
  const onApproval: ApprovalCallback = useCallback(Object.assign(
    (toolName: string, args: Record<string, unknown>, signal?: AbortSignal, context?: Readonly<ApprovalContext>) => queued(toolName, args, signal, context),
    { precheck: (toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>): ApprovalResponse | undefined => {
      const decision = decide(toolName, args, context, false)
      return decision.decision === "allow" ? true
        : decision.decision === "deny" ? { approved: false, source: "policy", reason: decision.reason } : undefined
    } },
  ), [decide, queued])

  return { onApproval, pendingApproval }
}
