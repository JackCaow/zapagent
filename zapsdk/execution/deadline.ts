/** Earliest known host deadline in epoch milliseconds. Unknown values add no bound. */
export function earliestDeadlineAt(...deadlines: Array<number | undefined>): number | undefined {
  const known = deadlines.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return known.length ? Math.min(...known) : undefined;
}

/** Check at admission boundaries as timers may be delayed by sleep or a busy event loop. */
export function hasDeadlineExpired(deadlineAtMs: number | undefined): boolean {
  return deadlineAtMs !== undefined && Number.isFinite(deadlineAtMs) && deadlineAtMs <= Date.now();
}
