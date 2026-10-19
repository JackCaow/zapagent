import type { HostWorkflowController } from "./workflows.js";
import { OutcomeProtocolError, type AcceptanceConfiguration } from "../runtime/outcome.js";
import { projectLegacyEvent } from "../runtime/types.js";
import type { RuntimeEventListener } from "../runtime/types.js";
import type { HostControllableRuntime } from "./session-runtime.js";
import {
  HOST_PROTOCOL_VERSION,
  type HostProtocolError,
  type HostProtocolRequest,
  type HostProtocolResponse,
} from "./types.js";

export interface HostRuntimeResolver {
  resolve(threadId: string): HostControllableRuntime | undefined | Promise<HostControllableRuntime | undefined>;
}

export class HostRuntimeRegistry implements HostRuntimeResolver {
  private readonly runtimes = new Map<string, HostControllableRuntime>();

  register(runtime: HostControllableRuntime): () => void {
    if (this.runtimes.has(runtime.threadId)) {
      throw new Error(`Runtime already registered for thread ${runtime.threadId}`);
    }
    this.runtimes.set(runtime.threadId, runtime);
    return () => {
      if (this.runtimes.get(runtime.threadId) === runtime) this.runtimes.delete(runtime.threadId);
    };
  }

  resolve(threadId: string): HostControllableRuntime | undefined {
    return this.runtimes.get(threadId);
  }
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) throw new HostRequestError("INVALID_PARAMS", `${name} is required`);
  return value;
}

function optionalInteger(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new HostRequestError("INVALID_PARAMS", `${name} must be a safe integer`);
  return value as number;
}

function optionalNonNegativeInteger(params: Record<string, unknown>, name: string): number | undefined {
  const value = optionalInteger(params, name);
  if (value !== undefined && value < 0) {
    throw new HostRequestError("INVALID_PARAMS", `${name} must be non-negative`);
  }
  return value;
}

function optionalPositiveInteger(params: Record<string, unknown>, name: string): number | undefined {
  const value = optionalInteger(params, name);
  if (value !== undefined && value < 1) {
    throw new HostRequestError("INVALID_PARAMS", `${name} must be positive`);
  }
  return value;
}

class HostRequestError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "HostRequestError";
  }
}

function protocolError(error: unknown): HostProtocolError {
  if (error instanceof OutcomeProtocolError) return { code: error.code, message: error.message, retryable: false };
  if (error instanceof HostRequestError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL_ERROR", message, retryable: false };
}

export class HostProtocolService {
  private readonly resolver: HostRuntimeResolver;
  private readonly activeTurns = new Map<string, AbortController>();

  constructor(resolver: HostRuntimeResolver, private readonly workflows?: HostWorkflowController) {
    this.resolver = resolver;
  }

  async handle(value: unknown): Promise<HostProtocolResponse> {
    const id = value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : "unknown";
    try {
      const request = this.validate(value);
      const result = await this.dispatch(request);
      return { version: request.version, id: request.id, ok: true, result };
    } catch (error) {
      return { version: (value as { version?: unknown })?.version === 1 ? 1 : HOST_PROTOCOL_VERSION, id, ok: false, error: protocolError(error) };
    }
  }

  async subscribe(threadId: string, afterSequence: number, listener: RuntimeEventListener, version: 1 | 2 = 1): Promise<() => void> {
    const runtime = await this.requireRuntime(threadId);
    await runtime.initialize?.();
    let replaying = true;
    const buffered: Parameters<RuntimeEventListener>[0][] = [];
    const unsubscribe = runtime.subscribe({ threadId }, (event) => {
      if (replaying) buffered.push(event);
      else listener(event);
    }, version === 1 ? 2 : 3);
    const replay = await runtime.eventStore.list(threadId, { afterSequence });
    const seen = new Set<number>();
    for (const event of replay) {
      seen.add(event.sequence);
      listener(version === 1 ? projectLegacyEvent(event) : event);
    }
    replaying = false;
    for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) {
      if (!seen.has(event.sequence) && event.sequence > afterSequence) listener(event);
    }
    return unsubscribe;
  }

  private validate(value: unknown): HostProtocolRequest {
    if (!value || typeof value !== "object") throw new HostRequestError("INVALID_REQUEST", "request must be an object");
    const request = value as Partial<HostProtocolRequest>;
    if (request.version !== 1 && request.version !== 2) throw new HostRequestError("UNSUPPORTED_VERSION", "unsupported HostProtocol version");
    if (typeof request.id !== "string" || !request.id.trim()) throw new HostRequestError("INVALID_REQUEST", "request id is required");
    if (typeof request.threadId !== "string" || !request.threadId.trim()) throw new HostRequestError("INVALID_REQUEST", "threadId is required");
    const methods = new Set([
      "workflow.read", "workflow.cancel", "workflow.reconcile", "workflow.wait", "workflow.dispatch", "thread.snapshot", "thread.run", "thread.cancel", "thread.events",
      "agent.list", "agent.cancel", "agent.steer", "agent.resume",
    ]);
    if (typeof request.method !== "string" || !methods.has(request.method)) {
      throw new HostRequestError("METHOD_NOT_FOUND", "unknown HostProtocol method");
    }
    if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
      throw new HostRequestError("INVALID_PARAMS", "params must be an object");
    }
    return request as HostProtocolRequest;
  }

  private async dispatch(request: HostProtocolRequest): Promise<unknown> {
    const params = request.params ?? {};
    if (request.method.startsWith("workflow.")) {
      if (request.version !== 2 || !this.workflows) throw new HostRequestError("UNSUPPORTED_CAPABILITY", "Workflow controller is not configured for protocol v2");
      return this.workflows.handle(request.threadId, request.method, params);
    }
    const runtime = await this.requireRuntime(request.threadId);
    if (request.method === "thread.snapshot" || request.method === "thread.events") await runtime.initialize?.();
    switch (request.method) {
      case "thread.snapshot": return request.version === 1 ? runtime.threadSnapshot() : { ...runtime.threadSnapshot(), lastOutcome: runtime.lastOutcome?.() };
      case "thread.run": {
        if (this.activeTurns.has(request.threadId)) throw new HostRequestError("THREAD_BUSY", "thread already has an active turn", true);
        const controller = new AbortController();
        this.activeTurns.set(request.threadId, controller);
        try {
          if (request.version === 2) {
            if (!runtime.runWithOutcome) throw new HostRequestError("UNSUPPORTED_CAPABILITY", "Runtime does not support outcome-v1");
            return await runtime.runWithOutcome(requiredString(params, "input"), { signal: controller.signal, acceptance: params.acceptance as AcceptanceConfiguration | undefined });
          }
          if ("acceptance" in params) throw new HostRequestError("INVALID_PARAMS", "acceptance requires protocol v2");
          return await runtime.run(requiredString(params, "input"), { signal: controller.signal });
        } finally {
          this.activeTurns.delete(request.threadId);
        }
      }
      case "thread.cancel": {
        const reason = typeof params.reason === "string" ? params.reason : "cancelled by host";
        const controller = this.activeTurns.get(request.threadId);
        const runtimeCancelled = runtime.cancelTurn(reason);
        if (runtimeCancelled) controller?.abort(new Error(reason));
        return { cancelled: runtimeCancelled };
      }
      case "thread.events": {
        const afterSequence = optionalNonNegativeInteger(params, "afterSequence");
        const beforeSequence = optionalNonNegativeInteger(params, "beforeSequence");
        if (afterSequence !== undefined && beforeSequence !== undefined) {
          throw new HostRequestError("INVALID_PARAMS", "afterSequence and beforeSequence are mutually exclusive");
        }
        if (params.direction !== undefined && params.direction !== "forward" && params.direction !== "backward") {
          throw new HostRequestError("INVALID_PARAMS", "direction must be forward or backward");
        }
        const page = await runtime.eventStore.page(request.threadId, {
          afterSequence,
          beforeSequence,
          limit: optionalPositiveInteger(params, "limit"),
          direction: params.direction === "backward" ? "backward" : "forward",
        });
        return request.version === 1 ? { ...page, items: page.items.map(projectLegacyEvent) } : page;
      }
      case "agent.list": return runtime.listAgents();
      case "agent.cancel": return runtime.cancelAgent(requiredString(params, "runId"), typeof params.reason === "string" ? params.reason : undefined);
      case "agent.steer": return runtime.steerAgent(requiredString(params, "runId"), requiredString(params, "text"));
      case "agent.resume": return runtime.resumeAgent(requiredString(params, "runId"));
    }
  }

  private async requireRuntime(threadId: string): Promise<HostControllableRuntime> {
    const runtime = await this.resolver.resolve(threadId);
    if (!runtime) throw new HostRequestError("THREAD_NOT_FOUND", `thread ${threadId} is not registered`);
    return runtime;
  }
}
