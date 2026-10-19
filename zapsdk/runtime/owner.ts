import type { RuntimeOwnerState } from "./state-types.js";

export function validRuntimeOwner(value: unknown): value is RuntimeOwnerState {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<RuntimeOwnerState>;
  return typeof owner.instanceId === "string"
    && owner.instanceId.length > 0
    && Number.isSafeInteger(owner.pid)
    && (owner.pid ?? 0) > 0
    && typeof owner.startedAt === "number"
    && Number.isFinite(owner.startedAt);
}

export function isRuntimeOwnerAlive(owner: RuntimeOwnerState): boolean {
  if (!validRuntimeOwner(owner)) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
