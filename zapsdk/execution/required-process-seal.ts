import { operationFailure } from "./failure.js";
import type { ExecutionBroker, ExecutionBrokerRequest } from "./types.js";
import type { ToolResult } from "../tools/types.js";

/** Host decorator: require the selected backend to verify every process
 * before a tool result is accepted. Never changes the selected backend or a
 * permission grant. The capability check concerns protocol support, not a
 * claim that a specific command has already been sealed. */
export function requireProcessSealing(inner: ExecutionBroker, onUnconfirmed?: () => void): ExecutionBroker {
  return {
    sandboxStatus: () => inner.sandboxStatus(),
    ...(inner.shellEnvironment ? { shellEnvironment: tool => inner.shellEnvironment!(tool) } : {}),
    ...(inner.serviceCapabilities ? { serviceCapabilities: workspace => inner.serviceCapabilities!(workspace) } : {}),
    supportsProcessSeal: tool => inner.supportsProcessSeal?.(tool) === true,
    async execute(request: ExecutionBrokerRequest, signal?: AbortSignal): Promise<ToolResult> {
      if (!request.effects.process.length) return inner.execute(request, signal);
      const tool = { name: request.name, executionLocation: request.tool.definition.executionLocation };
      if (inner.supportsProcessSeal?.(tool) !== true) {
        onUnconfirmed?.();
        return { success: false, output: "", error: "Selected backend cannot prove process-tree sealing",
          failure: operationFailure("CAPABILITY_UNSUPPORTED", "broker", request.executionId) };
      }
      let result: ToolResult;
      try { result = await inner.execute({ ...request, requireProcessSeal: true }, signal); }
      catch (error) { onUnconfirmed?.(); throw error; }
      if (result.runtime?.processSeal?.state !== "sealed" || result.runtime.processSeal.executionId !== request.executionId) {
        onUnconfirmed?.();
        return { success: false, output: "", error: "Process-tree sealing was not confirmed",
          failure: operationFailure("BACKEND_UNAVAILABLE", "broker", request.executionId),
          runtime: result.runtime };
      }
      return result;
    },
  };
}
