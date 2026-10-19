import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCustomProvider, getDefaultConfig } from "../../src/config.js";

it("CLI descendants receive host instructions and emit scoped tool observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-delegation-cli-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "fixture.txt"), "LOCAL_CHILD_OBSERVATION");
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any;
    requests.push(body);
    const child = body.messages.some((m: any) => m.role === "user" && m.content.includes("CHILD_TASK_SENTINEL"));
    const done = body.messages.some((m: any) => m.role === "tool");
    const delta = done ? { content: "Fixture complete." } : { tool_calls: [{ index: 0,
      // Deliberately reuse the ID across root/child to exercise scoped pairing.
      id: "fixture-call", type: "function", function: child
        ? { name: "read_file", arguments: JSON.stringify({ path: join(cwd, "fixture.txt") }) }
        : { name: "agent", arguments: JSON.stringify({ agent_type: "explore", thoroughness: "quick",
            task: "CHILD_TASK_SENTINEL: read the fixture and report it.", system_prompt: "CUSTOM_CHILD_ROLE",
            inheritedInstructions: "FORGED_HOST_INSTRUCTION" }) },
    }] };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture-model", created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 },
    })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, done ? "stop" : "tool_calls") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "fixture", models: ["fixture-model"], contextWindow: 128000 });
    for (const custom of [false, true]) for (const profile of ["standard", "concise"] as const) {
      requests.length = 0;
      const data = join(root, `data-${profile}-${custom}`);
      await mkdir(data);
      await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), promptProfile: profile,
        customSystemPrompt: custom ? "HOST_CONFIG_SENTINEL" : "", providers: [provider],
        active: { providerId: provider.id, model: "fixture-model" } }), { mode: 0o600 });
      const binary = process.env.ZAP_TEST_COMPILED_BINARY;
      const child = spawn(binary ?? process.execPath, [...(binary ? [] : [resolve("src/index.tsx")]),
        "--print", "Delegate the local fixture inspection.", "--output-format", "stream-json",
        "--result-schema", "outcome-v1", "--permission-mode", "bypassPermissions", "--dangerously-disable-os-sandbox",
        "--max-turns", "5", "--timeout-ms", "20000", "--cwd", cwd, "--no-devtools",
        "--system-prompt-prepend", "HOST_PREPEND_SENTINEL", "--system-prompt-append", "HOST_APPEND_SENTINEL"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data,
          ZAPCODE_EXECUTION: "local", ZAPCODE_DEVTOOLS_PORT: "" },
      });
      let stdout = "", stderr = "";
      child.stdout!.on("data", d => stdout += String(d)); child.stderr!.on("data", d => stderr += String(d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
      let code: number | null;
      try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
      finally { clearTimeout(timer); }
      if (code !== 0) throw new Error(stderr + stdout);
      expect(requests).toHaveLength(5);
      expect(requests[4].messages.some((message: any) => message.role === "user" && String(message.content).includes("Review the original user request"))).toBe(true);
      for (const request of requests) {
        const system = request.messages.find((m: any) => m.role === "system").content as string;
        expect(system.split("HOST_PREPEND_SENTINEL")).toHaveLength(2);
        expect(system.split("HOST_APPEND_SENTINEL")).toHaveLength(2);
        expect(system.includes("HOST_CONFIG_SENTINEL")).toBe(custom);
        expect(system).not.toContain("FORGED_HOST_INSTRUCTION");
      }
      expect(requests[1].messages[0].content).toContain("CUSTOM_CHILD_ROLE");
      const parentAgent = requests[0].tools.find((tool: any) => tool.function.name === "agent");
      expect(parentAgent.function.description).toContain("Read-only shell access: unavailable.");
      for (const request of requests.slice(1, 3)) {
        expect(request.tools.some((tool: any) => tool.function.name === "bash")).toBe(false);
        expect(request.messages[0].content).toContain("Shell access: bash is unavailable in this subagent.");
        expect(request.messages[0].content).toContain("Compilation, tests, interpreters and custom executables are unavailable in this read-only role.");
      }
      expect(JSON.stringify(requests[2].messages.filter((m: any) => m.role === "tool"))).toContain("LOCAL_CHILD_OBSERVATION");
      const events = stdout.trim().split("\n").map(line => JSON.parse(line));
      const use = events.find(e => e.type === "subagent_tool_use");
      const result = events.find(e => e.type === "subagent_tool_result");
      expect(use.name).toBe("read_file");
      expect(use.path).toHaveLength(1);
      expect(result.path).toEqual(use.path);
      expect(result.id).toBe(use.id);
      expect(result.ok).toBe(true);
      expect(result.preview).toContain("LOCAL_CHILD_OBSERVATION");
      const final = events.findLast(e => e.type === "result");
      expect(final.toolCalls).toHaveLength(1);
      expect(final.toolCalls[0].name).toBe("agent");
      expect(final.toolCalls[0].ok).toBe(true);
    }
  } finally { server.stop(); await rm(root, { recursive: true, force: true }); }
}, 120000);
