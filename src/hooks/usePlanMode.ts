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
  effectiveMode?: () => PermissionMode
  getPlanRun?: () => string | undefined
  grantTask?: () => void
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
  const { configRef, setConfig, effectiveMode, grantTask, getPlanRun } = opts
  const { pending, request } = usePendingInteraction<string, PlanChoice>()
  const prevModeBeforePlanRef = useRef<{ mode: PermissionMode; run?: string } | null>(null)

  const planCallbacks = useMemo<PlanModeCallbacks>(() => ({
    enter: () => {
      // Snapshot only on real transition. If the model calls enter_plan_mode
      // twice, the second call is a no-op and must not clobber the original
      // mode with "plan".
      if (configRef.current.permissionMode !== "plan") {
        prevModeBeforePlanRef.current = { mode: configRef.current.permissionMode, run: getPlanRun?.() }
      }
      const next = { ...configRef.current, permissionMode: "plan" as const }
      configRef.current = next
      setConfig(next)
      saveAppConfig(configPath, next)
    },
    isActive: () => (effectiveMode?.() ?? configRef.current.permissionMode) === "plan",
    requestExit: async (plan, signal) => {
      const run = getPlanRun?.()
      const choice = await request(plan, { kind: "reject", reason: "Plan interaction cancelled" }, signal)
      if (signal?.aborted || run !== getPlanRun?.()) return { approved: false, reason: "Plan interaction cancelled" }
      if (choice.kind === "approve") {
        grantTask?.()
        const previous = prevModeBeforePlanRef.current
        const restored = previous && previous.run === run ? previous.mode : "default"
        prevModeBeforePlanRef.current = null
        const next = { ...configRef.current, permissionMode: restored }
        configRef.current = next
        setConfig(next)
        saveAppConfig(configPath, next)
        return { approved: true }
      }
      // Rejection/cancellation keeps plan mode and its original snapshot so
      // a later, live approval still restores the user's previous mode.
      return { approved: false, reason: choice.reason }
    },
  }), [configRef, setConfig, request, effectiveMode, grantTask, getPlanRun])

  // Keep identity stable across renders; App effects depend on this value.
  const pendingPlan = useMemo(
    () => pending ? { plan: pending.value, resolve: pending.resolve } : null,
    [pending],
  )

  return { planCallbacks, pendingPlan }
}
