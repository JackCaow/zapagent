export type AuthSyncEventType = "authenticated" | "signed-out";

export interface AuthSyncEvent {
  version: 1;
  id: string;
  type: AuthSyncEventType;
  timestamp: number;
}

const channelName = "zapvm.auth-session.v1";
const storageKey = "zapvm:auth-session:event";
let channel: BroadcastChannel | undefined;

export function createAuthSyncEvent(type: AuthSyncEventType): AuthSyncEvent {
  return { version: 1, id: crypto.randomUUID(), type, timestamp: Date.now() };
}

export function parseAuthSyncEvent(value: unknown): AuthSyncEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AuthSyncEvent>;
  if (candidate.version !== 1 || typeof candidate.id !== "string" || !candidate.id ||
      (candidate.type !== "authenticated" && candidate.type !== "signed-out") ||
      typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp)) return undefined;
  return candidate as AuthSyncEvent;
}

export function publishAuthSync(type: AuthSyncEventType) {
  const event = createAuthSyncEvent(type);
  if (typeof BroadcastChannel !== "undefined") {
    authChannel().postMessage(event);
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(event));
    localStorage.removeItem(storageKey);
  } catch {
    // Storage can be disabled. Focus recovery remains the fallback.
  }
}

export function subscribeAuthSync(listener: (event: AuthSyncEvent) => void) {
  if (typeof BroadcastChannel !== "undefined") {
    const activeChannel = authChannel();
    const onMessage = (message: MessageEvent<unknown>) => {
      const event = parseAuthSyncEvent(message.data);
      if (event) listener(event);
    };
    activeChannel.addEventListener("message", onMessage);
    return () => activeChannel.removeEventListener("message", onMessage);
  }
  const onStorage = (storageEvent: StorageEvent) => {
    if (storageEvent.key !== storageKey || !storageEvent.newValue) return;
    try {
      const event = parseAuthSyncEvent(JSON.parse(storageEvent.newValue));
      if (event) listener(event);
    } catch {
      // Ignore malformed events written by unrelated scripts.
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function authChannel() {
  channel ??= new BroadcastChannel(channelName);
  return channel;
}
