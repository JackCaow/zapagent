import type { TokenUsage } from "../../zapsdk/core/types.js"
import { persistRunUsage } from "./usagePersistence.js"
import { appendUsage } from "../session.js"

/** Keep maintenance in the usage journal without calibrating main-context UI. */
export function recordMaintenanceUsage(usage: TokenUsage, persist = appendUsage): void {
  persistRunUsage({ ...usage, purpose: "maintenance" }, { getLocalEstimate: () => 0, appendUsage: persist })
}
