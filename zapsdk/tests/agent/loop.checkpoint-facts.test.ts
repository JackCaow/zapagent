import { afterEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopAgent } from "../../agent/loop.js";
import { CheckpointManager } from "../../checkpoint/index.js";
import { writeFileTool } from "../../builtin-tools/filesystem.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import type { CheckpointEditTracker } from "../../checkpoint/types.js";
import type { LLMProvider } from "../../core/llm.js";
import type { LLMChunk, LLMResponse, Message } from "../../core/types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'zap checkpoint "facts"-')); roots.push(base);
  const root = join(base, "workspace"), outside = join(base, "outside.txt"); await mkdir(root);
  await writeFile(outside, "outside-before"); await writeFile(join(root, "note.txt"), "inside-before");
  const manager = new CheckpointManager({ sessionId: "facts", cwd: root, config: { blobDir: join(base, "blobs") } });
  const registry = new ToolRegistry(); registry.register(writeFileTool({ defaultCwd: root }));
  return { base, root, outside, manager, registry };
}
function model(mode: "call" | "stream" | "xml", inputs: Message[][], answer: (step: number) => LLMResponse): LLMProvider {
  const call = async (messages: Message[]) => { inputs.push(structuredClone(messages)); return answer(inputs.length); };
  const provider: LLMProvider = { call };
  if (mode !== "call") provider.stream = async function* (messages): AsyncIterable<LLMChunk> {
    const response = await call(messages);
    if (response.type === "tool_call") {
      if (mode === "xml") {
        const tool = response.toolCalls![0]!;
        yield { type: "text_delta", text: `<tool_call>write_file<arg_key>path</arg_key><arg_value>${tool.arguments.path}</arg_value><arg_key>content</arg_key><arg_value>${tool.arguments.content}</arg_value></tool_call>` };
      }
      else for (const tool of response.toolCalls ?? []) {
        yield { type: "tool_call_start", toolCallId: tool.id, toolName: tool.name };
        yield { type: "tool_call_delta", toolCallId: tool.id, partialJson: JSON.stringify(tool.arguments) };
      }
    } else yield { type: "text_delta", text: response.text };
    yield { type: "done", usage: response.usage };
  };
  return provider;
}
const usage = { inputTokens: 1, outputTokens: 1 };
const done: LLMResponse = { type: "text", text: "Recorded coverage and actual write outcomes.", usage };

for (const mode of ["call", "stream", "xml"] as const) for (const profile of ["standard", "concise"] as const) {
  it(`${mode}/${profile}: describes explicit strict coverage before denying an uncovered external write`, async () => {
    const f = await fixture(), inputs: Message[][] = [];
    const executor = new ToolExecutor(f.registry, { cwd: f.root, checkpointMode: "before-write", onApproval: async () => true, onTrackEdit: f.manager.createEditTracker() });
    const provider = model(mode, inputs, step => step < 3 ? { type: "tool_call", text: "", toolCalls: [{ id: `write-${step}`, name: "write_file",
      arguments: { path: step === 1 ? f.outside : "note.txt", content: "after" } }], usage } : done);
    const result = await new LoopAgent({ provider, registry: f.registry, executor, systemPrompt: "Custom host role.", promptProfile: profile, maxSteps: 5 }).run("Observe checkpoint scope and write.");
    const first = inputs[0]!.map(message => message.content).join("\n");
    expect(first).toContain(`Checkpoint workspace root: ${JSON.stringify(f.root)}`);
    expect(first).toContain("system temporary paths"); expect(first).not.toContain(f.base + "/blobs");
    expect(result.toolResults[0]?.failure?.code).toBe("CHECKPOINT_REQUIRED");
    expect(result.toolResults[1]?.success).toBe(true);
    expect(await readFile(f.outside, "utf8")).toBe("outside-before");
    expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe("after");
    const snapshot = await f.manager.makeSnapshot(0); expect(snapshot?.trackedFiles["note.txt"]?.kind).toBe("present");
    expect(Object.keys(snapshot!.trackedFiles)).toEqual(["note.txt"]);
  });
}

it("legacy Host coverage remains unknown and can still support its own external path", async () => {
  const f = await fixture(), inputs: Message[][] = []; let tracked = false;
  const executor = new ToolExecutor(f.registry, { cwd: f.root, onApproval: async () => true,
    onTrackEdit: async paths => { tracked = paths.includes(f.outside); } });
  const provider = model("call", inputs, step => step === 1 ? { type: "tool_call", text: "", toolCalls: [{ id: "legacy", name: "write_file", arguments: { path: f.outside, content: "legacy-covered" } }], usage } : done);
  const result = await new LoopAgent({ provider, registry: f.registry, executor, maxSteps: 3 }).run("Use Host-defined coverage.");
  const first = inputs[0]!.map(message => message.content).join("\n");
  expect(first).toContain("coverage scope is unknown"); expect(first).not.toContain("Checkpoint workspace root:");
  expect(tracked).toBe(true); expect(result.toolResults[0]?.success).toBe(true);
  expect(await readFile(f.outside, "utf8")).toBe("legacy-covered");
});

it("unconfigured tracking is disclosed and explicitly strict writes remain denied", async () => {
  const f = await fixture(), inputs: Message[][] = [];
  const executor = new ToolExecutor(f.registry, { cwd: f.root, checkpointMode: "before-write", onApproval: async () => true });
  const provider = model("call", inputs, step => step === 1 ? { type: "tool_call", text: "", toolCalls: [{ id: "absent", name: "write_file", arguments: { path: "note.txt", content: "denied" } }], usage } : done);
  const result = await new LoopAgent({ provider, registry: f.registry, executor, maxSteps: 3 }).run("Inspect the Host boundary.");
  expect(inputs[0]!.map(message => message.content).join("\n")).toContain("No checkpoint tracker is configured");
  expect(result.toolResults[0]?.failure?.code).toBe("CHECKPOINT_REQUIRED");
  expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe("inside-before");
});

it("executor clones preserve the live tracker while later runs refresh changed configuration", async () => {
  const f = await fixture(), inputs: Message[][] = []; const tracker = f.manager.createEditTracker();
  const original = new ToolExecutor(f.registry, { cwd: f.root, onApproval: async () => true, onTrackEdit: tracker });
  const executor = original.withRegistry(f.registry).withRuntimePolicy(original.policyEngine, "before-write")
    .withApprovalLifecycle(() => {}).withExecutionLifecycle(() => {});
  expect(executor.onTrackEdit).toBe(tracker);
  const agent = new LoopAgent({ provider: model("call", inputs, () => done), registry: f.registry, executor, promptProfile: "concise", maxSteps: 2 });
  await agent.run("Read current coverage."); f.manager.updateConfig({ enabled: false, maxFileBytes: 4 });
  await agent.run("Read updated coverage.");
  expect(inputs[0]!.map(message => message.content).join("\n")).toContain("Tracker enabled: true");
  const latest = inputs.at(-1)!.map(message => message.content).join("\n");
  expect(latest).toContain("Tracker enabled: false"); expect(latest).toContain("Maximum snapshot file bytes: 4");
  const denied = await executor.execute("write_file", { path: "note.txt", content: "denied" });
  expect(denied.failure?.code).toBe("CHECKPOINT_REQUIRED");
  expect(await readFile(join(f.root, "note.txt"), "utf8")).toBe("inside-before");
});

it("a failed optional description cannot break a valid legacy tracking callback", async () => {
  const f = await fixture(), inputs: Message[][] = [];
  const tracker: CheckpointEditTracker = Object.assign(async () => {}, { describeCoverage: () => { throw new Error("unavailable"); } });
  const executor = new ToolExecutor(f.registry, { cwd: f.root, onApproval: async () => true, onTrackEdit: tracker });
  await new LoopAgent({ provider: model("call", inputs, () => done), registry: f.registry, executor, maxSteps: 2 }).run("Inspect available facts.");
  expect(inputs[0]!.map(message => message.content).join("\n")).toContain("coverage scope is unknown");
  expect((await executor.execute("write_file", { path: "note.txt", content: "tracked" })).success).toBe(true);
});
