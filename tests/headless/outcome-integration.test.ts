import { spawn } from "node:child_process";
import { expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCustomProvider, getDefaultConfig } from "../../src/config.js";
import { AgentEventEmitter } from "../../zapsdk/agent/events.js";
import { AgentRuntime } from "../../zapsdk/runtime/agent-runtime.js";
import { JsonRuntimeStateStore } from "../../zapsdk/runtime/state-store.js";
import { JsonlRuntimeEventStore } from "../../zapsdk/runtime/event-store.js";
import { RuntimeStateTracker } from "../../zapsdk/runtime/state-tracker.js";

it("real CLI preserves legacy delivery failure while outcome-v1 finishes after write, shell edit and temporary deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-outcome-cli-"));
  const data = join(root, "data");
  await mkdir(data);
  let requests = 0;
  let reviewRequests = 0;
  let background = false;
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: unknown }> };
    requests++;
    if (body.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.includes("Review the original user request"))) reviewRequests++;
    const tools = body.messages.filter(message => message.role === "tool").length;
    const call = (name: string, args: object) => ({ tool_calls: [{ index: 0, id: `tool-${tools}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const delta = background ? tools === 0 ? call("bash", { command: "sleep 30", run_in_background: true }) : { content: "Background launched." } : tools === 0 ? call("write_file", { path: "marker.txt", content: "before" })
      : tools === 1 ? call("write_file", { path: "temporary.sh", content: "echo temporary" })
      : tools === 2 ? call("bash", { command: "sed -i.bak 's/before/after/' marker.txt && rm temporary.sh marker.txt.bak" })
      : { content: "Done; external acceptance has not run." };
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tools < (background ? 1 : 3) ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture-model"], contextWindow: 128000 });
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture-model" } }), { mode: 0o600 });
    for (const profile of ["outcome-v1", "legacy", "denied", "background"] as const) {
      background = profile === "background";
      const schema = profile === "legacy" ? "legacy" : "outcome-v1";
      const cwd = join(root, profile); await mkdir(cwd);
      const prior = requests;
      const priorReviews = reviewRequests;
      const child = spawn(process.execPath, [resolve("src/index.tsx"), "--print", "Create marker, modify it, delete the temporary script, then finish.", "--output-format", "stream-json", "--result-schema", schema, "--permission-mode", profile === "denied" ? "default" : "bypassPermissions", "--dangerously-disable-os-sandbox", "--max-turns", "8", "--cwd", cwd], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_DEVTOOLS_PORT: "", ZAPCODE_DISABLE_BACKGROUND_TASKS: background ? "0" : "1" },
      });
      let stdout = "", stderr = "";
      child.stdout!.on("data", chunk => { stdout += String(chunk); });
      child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
      const finals = lines.filter(line => line.type === "result");
      expect(finals).toHaveLength(1);
      const phases = lines.filter(line => line.kind === "runtime_lifecycle").map(line => line.detail.stage);
      expect(phases).toEqual(schema === "outcome-v1" ? ["checkpoint_started", "checkpoint_finished", "sealing", "runtime_returned", "host_cleanup_started", "host_cleanup_finished"]
        : ["checkpoint_started", "checkpoint_finished", "runtime_returned", "host_cleanup_started", "host_cleanup_finished"]);
      const sealing = lines.filter(line => line.kind === "runtime_sealing");
      if (schema === "outcome-v1") {
        expect(sealing.filter(line => line.detail.status === "completed").map(line => line.detail.stage)).toEqual([
          "background_settle", "state_flush", "state_load", "outcome_save", "event_flush", "terminal_append", "publication_ack", "ownership_release",
        ]);
        expect(sealing.every(line => line.detail.attemptId === finals[0].attemptId && line.detail.elapsedMs >= 0)).toBe(true);
      } else expect(sealing).toHaveLength(0);
      expect(requests - prior).toBe(background ? 3 : 5);
      expect(reviewRequests - priorReviews).toBe(1);
      expect(finals[0].toolCalls).toHaveLength(background ? 1 : 3);
      if (background) {
        expect(finals[0].execution.backgroundTasks).toHaveLength(1);
        expect(finals[0].execution.backgroundTasks[0].disposition).toBe("stopped");
      } else if (profile === "denied") {
        await expect(readFile(join(cwd, "marker.txt"))).rejects.toThrow();
        expect(finals[0].toolCalls.every((tool: { ok: boolean }) => !tool.ok)).toBe(true);
      } else expect(await readFile(join(cwd, "marker.txt"), "utf8")).toBe("after");
      await expect(readFile(join(cwd, "temporary.sh"))).rejects.toThrow();
      if (schema === "outcome-v1") {
        expect(code).toBe(0);
        expect(finals[0]).toMatchObject({ schema: "zap.outcome", schemaVersion: 1, ok: true, execution: { status: "finished" }, acceptance: { status: "unverified" } });
        expect(finals[0].completion).toBeUndefined();
        expect(finals[0].error).toBeUndefined();
        expect(lines[0].schema).toBe("zap.outcome");
      } else {
        expect(code).toBe(1);
        expect(finals[0]).toMatchObject({ ok: false, stopReason: "incomplete", completion: { status: "incomplete" } });
        expect(finals[0].schema).toBeUndefined();
      }
    }
  } finally { model.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);

it("headless emits a protocol failure on sealing timeout and recovers its disk outbox without another model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-sealing-cli-"));
  const data = join(root, "data");
  await mkdir(data);
  let requests = 0;
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    requests++;
    const response = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture-model"], contextWindow: 128000 });
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture-model" } }), { mode: 0o600 });
    const entry = join(root, "blocked-store.ts");
    await writeFile(entry, `
      import { JsonlRuntimeEventStore } from ${JSON.stringify(resolve("zapsdk/runtime/event-store.ts"))};
      import { runHeadless } from ${JSON.stringify(resolve("src/headless/runHeadless.ts"))};
      import { parseHeadlessArgs } from ${JSON.stringify(resolve("src/headless/args.ts"))};
      const append = JsonlRuntimeEventStore.prototype.append;
      JsonlRuntimeEventStore.prototype.append = function(event) {
        if (event.payload.type === "attempt_ended") return new Promise(() => {});
        return append.call(this, event);
      };
      const parsed = parseHeadlessArgs(process.argv.slice(2));
      if (!parsed.ok) throw new Error(parsed.message);
      process.exit(await runHeadless(parsed.args, { sealingTimeoutMs: 200 }));
    `);
    const child = spawn(process.execPath, [entry, "--print", "Say done.", "--output-format", "stream-json", "--result-schema", "outcome-v1", "--dangerously-disable-os-sandbox", "--cwd", root], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_DEVTOOLS_PORT: "", ZAPCODE_DISABLE_BACKGROUND_TASKS: "1" },
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const guard = setTimeout(() => child.kill("SIGKILL"), 10000);
    let code: number | null;
    try { code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(guard); }
    expect({ code, stderr }).toMatchObject({ code: 1 });
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines.filter(line => line.type === "result")).toHaveLength(0);
    expect(lines.some(line => line.type === "error" && line.code === "OUTCOME_SEALING_TIMEOUT")).toBe(true);
    expect(lines.some(line => line.kind === "runtime_sealing" && line.detail.stage === "terminal_append" && line.detail.status === "timeout")).toBe(true);
    const [project] = await readdir(join(data, "projects"));
    const stateDirectory = join(data, "projects", project!, "runtime-state");
    const [stateFile] = (await readdir(stateDirectory)).filter(name => name.endsWith(".json"));
    expect(stateFile).toBeDefined();
    const saved = JSON.parse(await readFile(join(stateDirectory, stateFile!), "utf8"));
    const entryRecord = Object.values(saved.attemptOutcomes)[0] as any;
    expect(entryRecord.publication).toBe("pending");
    const store = new JsonRuntimeStateStore({ directory: stateDirectory });
    const events = new JsonlRuntimeEventStore({ directory: join(stateDirectory, "..", "runtime-events") });
    class RecoveryOnly extends AgentEventEmitter {
      async run(): Promise<never> { throw new Error("Recovery must not run a model"); }
      toolDefinitions() { return []; }
      effectiveSystemPrompt() { return undefined; }
    }
    const runtime = new AgentRuntime({ threadId: saved.threadId, agent: new RecoveryOnly(), eventStore: events,
      stateTracker: new RuntimeStateTracker({ threadId: saved.threadId, workspaceRoot: root, store }) });
    try {
      await runtime.initialize();
      expect(runtime.lastOutcome()).toEqual(entryRecord.outcome);
      expect((await store.load(saved.threadId))!.attemptOutcomes[entryRecord.outcome.attemptId]!.publication).toBe("published");
      expect((await events.list(saved.threadId)).filter(event => event.eventId === entryRecord.terminalEventId)).toHaveLength(1);
      expect(requests).toBe(1);
    } finally { await runtime.close(); }
  } finally { model.stop(); await rm(root, { recursive: true, force: true }); }
}, 15000);
