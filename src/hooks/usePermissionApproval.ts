import { useCallback, useEffect, useRef, useState } from "react"
import type { AppConfig } from "../config.js"
import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"
import type { ApprovalChoice } from "../ui/dialog-approval.js"
import { appLogger, permissionManager } from "../singletons.js"
import { ApprovalQueue } from "../approval-queue.js"
import { getCurrentSessionId } from "../session.js"
import { approvalFacts } from "../approval-facts.js"
import { REQUEST_CAPABILITIES_TOOL } from "../capabilities.js"
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
  /** One-time approvals of the same consent earlier this session. */
  repeats: number
  resolve: (choice: ApprovalChoice) => void
  grant: (request: ToolGrantRequest, availableTools: string[], reviewedRules?: readonly PermissionRule[]) => string | void
}

export interface UsePermissionApprovalOptions {
  /** Live config ref — read inside the callback so a mode flip during a run
   *  (e.g. user toggles plan mode) takes effect on the very next approval. */
  configRef: React.MutableRefObject<AppConfig>
  addLog: AddLog
}

export interface UsePermissionApprovalResult {
  /** Pass the factual decision source to the shared executor. */
  onApproval: ApprovalCallback
  /** Current pending approval, or null when no prompt is active. App renders
   *  <ApprovalBar /> when this is non-null. */
  pendingApproval: PendingApproval | null
}

/** Plan mode and explicit denials win first. Dangerous commands always need
 * one-time consent. Sandbox escape uses its own session/project capability;
 * ordinary command rules never grant it, and explicit asks still prompt. */
export function usePermissionApproval(
  opts: UsePermissionApprovalOptions,
): UsePermissionApprovalResult {
  const { configRef, addLog } = opts
  const sessionId = getCurrentSessionId()
  permissionManager.setSessionId(sessionId)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const queueRef = useRef<ApprovalQueue | null>(null)
  if (!queueRef.current) queueRef.current = new ApprovalQueue(getCurrentSessionId)
  const queue = queueRef.current
  useEffect(() => { queue.cancelStale() }, [queue, sessionId])
  useEffect(() => () => queue.cancelAll(), [queue])

  const promptApproval = useCallback(
    async (
      name: string,
      ar: Record<string, unknown>,
      signal?: AbortSignal,
      allowScope = true,
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
          const current = evaluateApprovalPolicy(permissionManager, name, ar, { mode: configRef.current.permissionMode, cwd: process.cwd(), context })
          if (current.decision === "ask" && !current.allowScope) scopeAllowed = false
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
          // Outside-sandbox prompts never count: their option 2 is a far broader grant.
          repeats: approvalFacts(name, ar, context).sandboxEscape || name === REQUEST_CAPABILITIES_TOOL ? 0 : permissionManager.priorOnceApprovals(name, ar, context),
          grant: (request, availableTools, reviewedRules) => {
            const expired = validate()
            if (expired) return expired
            if (!scopeAllowed || (approvalFacts(name, ar, context).sandboxEscape)) return "This approval only supports its displayed choices"
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
            if (!scopeAllowed && choice !== "deny") choice = "once"
            try { appLogger.info("permission_user", { tool: name, choice }) } catch {}
            const escape = approvalFacts(name, ar, context).sandboxEscape
            if (escape) {
              if (choice === "always" || choice === "forever") {
                const scope = choice === "always" ? "session" : "project"
                try {
                  permissionManager.grantSandboxEscape(scope)
                  addLog("system", `Permission: outside-sandbox commands allowed for this ${scope}; manage in /permissions`)
                } catch (error) {
                  addLog("error", `Could not save ${scope} sandbox authorization: ${String(error)}. Approved this command only.`)
                }
              } else {
                addLog("system", choice === "deny" ? "Sandbox escape declined; command was not authorized." : "Approved this command to run outside the OS sandbox.")
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
            else if (choice === "once" && !escape) permissionManager.recordOnceApproval(name, ar, context)
            settle(choice !== "deny" ? true : { approved: false, source: "approval", reason: "user declined approval; do not retry the same request this turn" })
          },
        })
      })
    },
    [addLog, configRef],
  )

  /** Policy decision without a human. Unsettled ones are logged only when
   * the queue reaches them, so a precheck never logs twice. */
  const decide = useCallback(
    (toolName: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>, logAsk = true) => {
      permissionManager.setSessionId(getCurrentSessionId())
      const mode = configRef.current.permissionMode
      const decision = evaluateApprovalPolicy(permissionManager, toolName, args, { mode, cwd: process.cwd(), context })
      if (decision.decision === "ask" && !logAsk) return decision
      try { appLogger.info("permission_decision", { tool: toolName, mode, decision: decision.decision, category: decision.category, tier: decision.tier, source: decision.source, reason: decision.reason }) } catch {}
      if (decision.decision === "deny") addLog("system", `Permission: denied ${getToolAlias(toolName)} — ${decision.reason}`)
      return decision
    },
    [addLog, configRef],
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
        return promptApproval(toolName, args, signal, decision.allowScope, context, id)
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
