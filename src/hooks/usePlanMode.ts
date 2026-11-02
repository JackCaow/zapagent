import { useMemo, useRef } from "react"
import { saveAppConfig, type AppConfig, type PermissionMode } from "../config.js"
import { configPath } from "../session.js"
import type { PlanModeCallbacks } from "../../zapsdk/index.js"
import type { PlanChoice } from "../ui/dialog-plan-approval.js"

import { usePendingInteraction } from "./usePendingInteraction.js"

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
  const { pending, request } = usePendingInteraction<string, PlanChoice>()
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
    requestExit: async (plan, signal) => {
      const choice = await request(plan, { kind: "reject", reason: "Plan interaction cancelled" }, signal)
      if (signal?.aborted) return { approved: false, reason: "Plan interaction cancelled" }
      if (choice.kind === "approve") {
        const restored = prevModeBeforePlanRef.current ?? "default"
        prevModeBeforePlanRef.current = null
        const next = { ...configRef.current, permissionMode: restored }
        setConfig(next)
        saveAppConfig(configPath, next)
        return { approved: true }
      }
      // Rejection/cancellation keeps plan mode and its original snapshot so
      // a later, live approval still restores the user's previous mode.
      return { approved: false, reason: choice.reason }
    },
  }), [configRef, setConfig, request])

  const pendingPlan = pending ? { plan: pending.value, resolve: pending.resolve } : null

  return { planCallbacks, pendingPlan }
}
