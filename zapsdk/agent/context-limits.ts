/** Allowance for estimator drift and provider-internal special tokens. Hosts
 * and LoopAgent share this value so displayed and enforced prompt budgets use
 * the same safety boundary. */
export const CONTEXT_INPUT_SAFETY_MARGIN_TOKENS = 1000;
