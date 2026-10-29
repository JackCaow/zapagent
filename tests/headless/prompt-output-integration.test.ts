import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCustomProvider, getDefaultConfig } from "../../src/config.js";

it("the real stream-json CLI never writes guarded prompt text to stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-output-guard-cli-"));
  const data = join(root, "data"), cwd = join(root, "workspace");
  await mkdir(data); await mkdir(cwd);
  const secret = "PRIVATE_CLI_FIXTURE=" + "confidential fixture rule. ".repeat(20) + "End.";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any;
    expect(body.messages.some((m: any) => m.role === "system" && m.content.includes(secret))).toBe(true);
    const frame = (delta: object, finish: string | null) => `data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    let output = "";
    for (let i = 0; i < secret.length; i += 9) output += frame({ content: secret.slice(i, i + 9) }, null);
    return new Response(output + frame({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "fixture", models: ["fixture"], contextWindow: 128000 });
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), executionBackend: "local",
      customSystemPrompt: secret, providers: [provider], active: { providerId: provider.id, model: "fixture" } }), { mode: 0o600 });
    const child = spawn(process.execPath, [resolve("src/index.tsx"), "--print", "Describe your capabilities.",
      "--output-format", "stream-json", "--result-schema", "outcome-v1", "--max-turns", "3",
      "--timeout-ms", "20000", "--cwd", cwd], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_DEVTOOLS_PORT: "", ZAP_DISABLE_UPDATE_CHECK: "1" },
    });
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => stdout += String(chunk)); child.stderr!.on("data", chunk => stderr += String(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    let code: number | null;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    if (code !== 0) throw new Error(stderr + stdout);
    expect(stdout).not.toContain("PRIVATE_CLI_FIXTURE");
    expect(stderr).not.toContain("PRIVATE_CLI_FIXTURE");
    const records = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(record => record.type === "assistant").map(record => record.delta).join("")).toContain("I can't share my system instructions");
    expect(records.findLast(record => record.type === "result").text).toContain("I can't share my system instructions");
  } finally { server.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);
