import { useMemo, useRef, useState } from "react"
import { saveAppConfig, type AppConfig, type PermissionMode } from "../config.js"
import { configPath } from "../session.js"
import type { PlanModeCallbacks } from "../../zapsdk/index.js"
import type { PlanChoice } from "../ui/dialog-plan-approval.js"

interface PendingPlan {
  plan: string
  resolve: (choice: PlanChoice) => void
}

export interface UsePlanModeOptions {
  configRef: React.MutableRefObject<AppConfig>
  setConfig: (next: AppConfig) => void
}

export interface UsePlanModeResult {
  /** Pass to `buildAgentObjects(... planCallbacks ...)`. Stable reference. */
  planCallbacks: PlanModeCallbacks
  /** Non-null when the model has called exit_plan_mode and the user hasn't
   *  responded yet — the App renders <PlanApprovalBar /> against this. */
  pendingPlan: PendingPlan | null
}

/**
 * Plan-mode state machine.
 *
 * The current mode (config.permissionMode === "plan") is the source of truth;
 * plan-mode tool callbacks read/flip it via configRef.
 *
 * Pre-plan mode snapshot: when entering plan we record where the user was so
 * exit-approve can restore that mode rather than flattening every plan →
 * implement transition to "default". Common case: user is in
 * bypassPermissions, the model calls enter_plan_mode mid-run, user approves
 * the plan — they expect to keep skipping approvals during implementation,
 * not be dropped back into prompt-on-every-edit.
 */
export function usePlanMode(opts: UsePlanModeOptions): UsePlanModeResult {
  const { configRef, setConfig } = opts
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null)
  const prevModeBeforePlanRef = useRef<PermissionMode | null>(null)

  const planCallbacks = useMemo<PlanModeCallbacks>(() => ({
    enter: () => {
      // Snapshot only on real transition. If the model calls enter_plan_mode
      // twice, the second call is a no-op and must not clobber the original
      // mode with "plan".
      if (configRef.current.permissionMode !== "plan") {
        prevModeBeforePlanRef.current = configRef.current.permissionMode
      }
      const next = { ...configRef.current, permissionMode: "plan" as const }
      setConfig(next)
      saveAppConfig(configPath, next)
    },
    isActive: () => configRef.current.permissionMode === "plan",
    requestExit: (plan: string) =>
      new Promise((resolveExit) => {
        setPendingPlan({
          plan,
          resolve: (choice) => {
            setPendingPlan(null)
            if (choice.kind === "approve") {
              // Restore the mode the user had before entering plan. Only
              // fall back to "default" defensively — under normal flow the
              // ref is always set by the enter callback above.
              const restored = prevModeBeforePlanRef.current ?? "default"
              prevModeBeforePlanRef.current = null
              const next = { ...configRef.current, permissionMode: restored }
              setConfig(next)
              saveAppConfig(configPath, next)
              resolveExit({ approved: true })
            } else {
              // Reject keeps mode = plan so the model can revise. Do NOT
              // clear the snapshot here — the next approve still needs to
              // restore the original mode.
              resolveExit({ approved: false, reason: choice.reason })
            }
          },
        })
      }),
  // configRef + setConfig are refs/stable callbacks — empty deps is correct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  return { planCallbacks, pendingPlan }
}
