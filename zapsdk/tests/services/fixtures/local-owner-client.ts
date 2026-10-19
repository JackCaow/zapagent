import { readFileSync } from "node:fs";
import { connectLocalServiceOwner } from "../../../services/local-owner.js";
import { DefaultExecutionBroker } from "../../../execution/broker.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { serviceTools } from "../../../services/tools.js";
const input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
try {
  const backend = await connectLocalServiceOwner(input.descriptorPath);
  const workspace = { ...backend.workspace, mode: "root" as const };
  const broker = new DefaultExecutionBroker({ services: backend, sandboxMode: "required", allowUnsandboxed: false });
  const registry = new ToolRegistry(); serviceTools(broker, workspace).forEach(tool => registry.register(tool));
  const executor = new ToolExecutor(registry, { workspace, cwd: workspace.root, executionBroker: broker, onApproval: async () => true });
  const result = await executor.execute(input.tool, input.args, undefined, { sessionId: "separate-client", toolCallId: input.callId ?? "fixture" });
  process.stdout.write(JSON.stringify(result) + "\n"); if (!result.success) process.exitCode = 1;
} catch { process.stderr.write("Owner fixture client failed\n"); process.exitCode = 1; }
