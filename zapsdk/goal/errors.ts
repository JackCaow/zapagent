import { OutcomeProtocolError } from "../runtime/outcome.js";

export class GoalPhaseError extends OutcomeProtocolError {
  constructor(code: string) {
    const detail = code === "GOAL_NPM_EXISTING_MODULES_DIFFER" ? ": Existing node_modules differs from the sealed installation; refusing to replace it" : "";
    super(code, `Goal phase stopped: ${code}${detail}`);
  }
}
/** Classify trusted runtime errors without persisting prompts or tool arguments. */
export function goalPhaseFailureCode(message: string): string {
  if (/Goal (?:provider|tool|spawn|npm installation) admission denied: (?:budget_exhausted|role_limit|deadline|usage_unknown|price_unknown)/.test(message)) return "GOAL_BUDGET_LIMITED";
  if (message.startsWith("Existing node_modules differs")) return "GOAL_NPM_EXISTING_MODULES_DIFFER";
  if (message.startsWith("Goal npm offline install failed")) return "GOAL_NPM_INSTALL_FAILED";
  if (message.startsWith("Goal npm installation disappeared")) return "GOAL_NPM_INSTALL_MISSING";
  const code = /\bGOAL_[A-Z_]+\b/.exec(message)?.[0];
  return code ?? "GOAL_PHASE_FAILED";
}
