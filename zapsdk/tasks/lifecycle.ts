/** Facts about managed tasks, never authority to preserve or detach them. */
export type BackgroundTaskLifecycle = "run" | "host-session" | "unknown";

export interface BackgroundTaskOwner {
  /** Opaque identity of the actual in-process registry owned by Runtime. */
  storeId: string;
  lifecycle: Exclude<BackgroundTaskLifecycle, "unknown">;
}

export function backgroundTaskLifecycle(owner: BackgroundTaskOwner | undefined, storeId: string): BackgroundTaskLifecycle {
  if (!owner || !storeId || owner.storeId !== storeId) return "unknown";
  return owner.lifecycle === "run" || owner.lifecycle === "host-session" ? owner.lifecycle : "unknown";
}

export function describeBackgroundTaskLifecycle(lifecycle: BackgroundTaskLifecycle): string {
  switch (lifecycle) {
    case "run": return "Managed background tasks are stopped before this run publishes its terminal outcome. They do not remain available after the run.";
    case "host-session": return "Managed background tasks remain owned by the active host session after this run. This does not provide an independent service owner after the host exits.";
    default: return "Managed background task lifetime is unknown. Starting one does not establish that it will remain available after this run or host exits.";
  }
}
