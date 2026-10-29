import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCustomProvider, getDefaultConfig } from "../../src/config.js";

it("real CLI sends the selected profile with user/project text and unchanged schemas, retaining failed tool output", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-profile-cli-"));
  const data = join(root, "data"), cwd = join(root, "workspace");
  await mkdir(data); await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT_SENTINEL: retain the public interface.");
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any;
    requests.push(body);
    const hasResult = body.messages.some((m: any) => m.role === "tool");
    const delta = hasResult ? { content: "The check failed; acceptance remains unverified." }
      : { tool_calls: [{ index: 0, id: "check", type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: "printf 'CHECK_FAILURE_SENTINEL'; exit 3" }),
      } }] };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture-model", created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 },
    })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, hasResult ? "stop" : "tool_calls") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "fixture", models: ["fixture-model"], contextWindow: 128000 });
    let schemas: unknown;
    for (const custom of [false, true]) for (const profile of ["standard", "concise"] as const) {
      requests.length = 0;
      await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), promptProfile: profile,
        customSystemPrompt: custom ? "CUSTOM_SENTINEL: follow the user's task." : "", providers: [provider],
        active: { providerId: provider.id, model: "fixture-model" } }), { mode: 0o600 });
      const child = spawn(process.execPath, [resolve("src/index.tsx"), "--print", "Check the fixture and report failure.",
        "--output-format", "stream-json", "--result-schema", "outcome-v1", "--permission-mode", "bypassPermissions",
        "--dangerously-disable-os-sandbox", "--max-turns", "5", "--timeout-ms", "20000", "--cwd", cwd,
        "--system-prompt-prepend", "PREPEND_SENTINEL", "--system-prompt-append", "APPEND_SENTINEL"], {
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_DEVTOOLS_PORT: "" },
      });
      let stdout = "", stderr = "";
      child.stdout!.on("data", d => stdout += String(d)); child.stderr!.on("data", d => stderr += String(d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
      let code: number | null;
      try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
      finally { clearTimeout(timer); }
      if (code !== 0) throw new Error(stderr + stdout);
      expect(code).toBe(0);
      expect(requests).toHaveLength(3);
      expect(requests[2].messages.some((message: any) => message.role === "user" && String(message.content).includes("Review the original user request"))).toBe(true);
      expect(JSON.stringify(requests[2].messages.filter((m: any) => m.role === "tool"))).toContain("CHECK_FAILURE_SENTINEL");
      const system = requests[0].messages.find((m: any) => m.role === "system").content as string;
      expect(system).toContain("PREPEND_SENTINEL"); expect(system).toContain("APPEND_SENTINEL");
      expect(system).toContain("PROJECT_SENTINEL");
      if (custom) expect(system).toContain("CUSTOM_SENTINEL");
      expect(system.includes("Profile: concise")).toBe(profile === "concise");
      expect(system.includes("3-5 ordered, observable items")).toBe(profile === "standard");
      schemas ??= requests[0].tools;
      expect(requests[0].tools).toEqual(schemas);
      expect(JSON.stringify(requests[1].messages.filter((m: any) => m.role === "tool"))).toContain("CHECK_FAILURE_SENTINEL");
      const final = stdout.trim().split("\n").map(l => JSON.parse(l)).findLast(e => e.type === "result");
      expect(final.acceptance.status).toBe("unverified");
      expect(final.toolCalls).toHaveLength(1);
      expect(final.toolCalls[0].ok).toBe(false);
    }
  } finally { server.stop(); await rm(root, { recursive: true, force: true }); }
}, 120000);

it("TUI runtime adapter applies profile changes and custom prompts across turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-profile-tui-"));
  try {
    const child = spawn(process.execPath, [resolve("tests/fixtures/prompt-profile-tui.ts"), root], {
      env: { ...process.env, ZAPCODE_DATA_DIR: join(root, "data"), ZAPCODE_DEVTOOLS_PORT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", d => stdout += String(d)); child.stderr!.on("data", d => stderr += String(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    let code: number | null;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    if (code !== 0) throw new Error(stderr);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { systemCount: 1, protocolCount: 1, concise: false, custom: false },
      { systemCount: 1, protocolCount: 1, concise: true, custom: true },
      { systemCount: 1, protocolCount: 1, concise: false, custom: false },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

it("a restricted headless runtime advertises only its effective capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-restricted-prompt-"));
  try {
    const child = spawn(process.execPath, [resolve("tests/fixtures/prompt-capabilities-headless.ts")], {
      cwd: root, env: { ...process.env, ZAPCODE_DATA_DIR: join(root, "data"), ZAPCODE_DEVTOOLS_PORT: "", ZAP_DISABLE_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => stdout += String(chunk)); child.stderr!.on("data", chunk => stderr += String(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    let code: number | null;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    if (code !== 0) throw new Error(stderr + stdout);
    const result = JSON.parse(stdout);
    expect(result).toEqual({ code: 0, tools: ["read_file", "read_tool_output"], agentGuidance: false, planTool: false,
      searchTool: false, globTool: false, skillLoading: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
