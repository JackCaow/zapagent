import type { AgentSession, TaskEvent } from "./types";

const streamProtocol = "zapvm.agent-stream.v1";

interface StreamFrame {
  type: "task-event" | "session" | "error" | string;
  cursor?: number;
  data?: TaskEvent | AgentSession;
  code?: string;
  retryable?: boolean;
}

export interface AgentStreamHandlers {
  cursor: () => number;
  onTaskEvent: (event: TaskEvent, cursor: number) => void;
  onSession: (session: AgentSession) => void;
  onTransport?: (transport: "websocket" | "sse") => void;
}

export function agentStreamSocketURL(taskID: string, cursor: number, location: Pick<Location, "protocol" | "host"> = window.location) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/agent/sessions/${encodeURIComponent(taskID)}/stream/socket?after=${cursor}&limit=1000`;
}

export function subscribeToAgentStream(taskID: string, handlers: AgentStreamHandlers) {
  let socket: WebSocket | undefined;
  let source: EventSource | undefined;
  let retryTimer: number | undefined;
  let retry = 0;
  let websocketFailures = 0;
  let closed = false;

  const schedule = (useSSE = websocketFailures >= 2) => {
    if (closed) return;
    retry += 1;
    retryTimer = window.setTimeout(() => connect(useSSE), Math.min(10_000, 250 * 2 ** retry));
  };

  const connectSSE = () => {
    handlers.onTransport?.("sse");
    source = new EventSource(`/api/agent/sessions/${encodeURIComponent(taskID)}/stream?after=${handlers.cursor()}&limit=1000`);
    source.addEventListener("task-event", (event) => {
      retry = 0;
      const item = JSON.parse((event as MessageEvent).data) as TaskEvent;
      handlers.onTaskEvent(item, Number((event as MessageEvent).lastEventId) || Number(item.cursor) || 0);
    });
    source.addEventListener("session", (event) => {
      retry = 0;
      handlers.onSession(JSON.parse((event as MessageEvent).data) as AgentSession);
    });
    source.onerror = () => {
      source?.close();
      source = undefined;
      schedule(true);
    };
  };

  const connectSocket = () => {
    handlers.onTransport?.("websocket");
    let opened = false;
    try {
      socket = new WebSocket(agentStreamSocketURL(taskID, handlers.cursor()), streamProtocol);
    } catch {
      websocketFailures = 2;
      schedule();
      return;
    }
    socket.onopen = () => {
      opened = true;
      retry = 0;
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as StreamFrame;
        if (frame.type === "task-event" && frame.data) {
          const item = frame.data as TaskEvent;
          handlers.onTaskEvent(item, Number(frame.cursor) || Number(item.cursor) || 0);
        } else if (frame.type === "session" && frame.data) {
          handlers.onSession(frame.data as AgentSession);
        } else if (frame.type === "error") {
          websocketFailures = Math.max(websocketFailures, frame.retryable ? 1 : 2);
          socket?.close();
        }
      } catch {
        websocketFailures = 2;
        socket?.close();
      }
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = undefined;
      if (!opened) websocketFailures += 1;
      schedule();
    };
  };

  const connect = (useSSE = false) => {
    if (closed) return;
    if (useSSE || typeof WebSocket === "undefined") connectSSE();
    else connectSocket();
  };

  connect();
  return () => {
    closed = true;
    socket?.close();
    source?.close();
    if (retryTimer) window.clearTimeout(retryTimer);
  };
}
