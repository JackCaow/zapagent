import { useCallback, useEffect, useRef, useState } from "react"
import type { AppConfig } from "../config.js"
import type { LogType, ToolCallInfo, UserImageRef, LogEntry } from "../ui/types.js"
import type { ApprovalChoice } from "../ui/dialog-approval.js"
import { appLogger, permissionManager } from "../singletons.js"
import { ApprovalQueue } from "../approval-queue.js"
import { getCurrentSessionId } from "../session.js"
import { approvalFacts } from "../approval-facts.js"
import { evaluateApprovalPolicy } from "../permission-policy.js"
import { buildToolGrantRules, type ToolGrantRequest } from "../tool-grants.js"
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
  resolve: (choice: ApprovalChoice) => void
  grant: (request: ToolGrantRequest, availableTools: string[]) => string | void
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
      mode: string,
      why: string,
      signal?: AbortSignal,
      allowScope = true,
      context?: Readonly<ApprovalContext>,
      id = "",
    ): Promise<ApprovalResponse> => {
      const sessionId = getCurrentSessionId()
      if (signal?.aborted) return false
      try {
        // Match the `permission_decision` log line emitted in onApproval's
        // synchronous decision tiers so log consumers see a uniform format.
        appLogger.info(
          `permission_decision tool=${name} mode=${mode} decision=ask (${why})`,
        )
      } catch {}
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
          grant: (request, availableTools) => {
            const expired = validate()
            if (expired) return expired
            if (!scopeAllowed || (approvalFacts(name, ar, context).sandboxEscape)) return "This approval only supports its displayed choices"
            try {
              const rules = buildToolGrantRules(request, availableTools)
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
            try { appLogger.info(`permission_user tool=${name} choice=${choice}`) } catch {}
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
            settle(choice !== "deny" ? true : { approved: false, source: "approval", reason: "user declined approval" })
          },
        })
      })
    },
    [addLog, configRef],
  )

  const onApproval = useCallback(
    (toolName: string, args: Record<string, unknown>, signal?: AbortSignal, context?: Readonly<ApprovalContext>): Promise<ApprovalResponse> => {
      queue.cancelStale()
      return queue.enqueue(async (signal, id) => {
        if (signal?.aborted) return Promise.resolve(false)
        permissionManager.setSessionId(getCurrentSessionId())
        const mode = configRef.current.permissionMode
        const decision = evaluateApprovalPolicy(permissionManager, toolName, args, { mode, cwd: process.cwd(), context })
        try { appLogger.info(`permission_decision tool=${toolName} mode=${mode} decision=${decision.decision} (${decision.reason})`) } catch {}
        if (decision.decision === "allow") return Promise.resolve(true)
        if (decision.decision === "deny") {
          addLog("system", `Permission: denied ${getToolAlias(toolName)} — ${decision.reason}`)
          return Promise.resolve({ approved: false, source: "policy", reason: decision.reason })
        }
        if (decision.source === "dangerous") addLog("system", `Approval required for ${decision.reason}`)
        return promptApproval(toolName, args, mode, decision.reason, signal, decision.allowScope, context, id)
      }, signal)
    },
    [addLog, configRef, promptApproval, queue],
  )

  return { onApproval, pendingApproval }
}
