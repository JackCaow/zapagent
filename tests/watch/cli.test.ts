import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCustomProvider, getDefaultConfig } from "../../src/config.js";

it("streams real CLI root, child, executor and final outcome over authenticated Watch SSE", async () => {
  const work = mkdtempSync(join(tmpdir(), "zap-watch-cli-")), cwd = join(work, "workspace"), data = join(work, "data");
  mkdirSync(cwd); mkdirSync(data); writeFileSync(join(cwd, "fixture.txt"), "CANARY_TOOL_SECRET");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let requests = 0;
  const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any; if (++requests === 1) await gate;
    const child = body.messages.some((m: any) => m.role === "user" && String(m.content).includes("CHILD_WATCH_FIXTURE"));
    const done = body.messages.some((m: any) => m.role === "tool");
    const delta = done ? { content: "CANARY_FINAL_SECRET" } : { tool_calls: [{ index: 0, id: "same-call", type: "function",
      function: child ? { name: "read_file", arguments: JSON.stringify({ path: join(cwd, "fixture.txt") }) }
        : { name: "agent", arguments: JSON.stringify({ task: "CHILD_WATCH_FIXTURE inspect local file", agent_type: "explore", thoroughness: "quick" }) } }] };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 1,
      choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, done ? "stop" : "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const configured = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "CANARY_API_SECRET", models: ["fixture"], contextWindow: 128000 });
  writeFileSync(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), customSystemPrompt: "CANARY_SYSTEM_SECRET", providers: [configured], active: { providerId: configured.id, model: "fixture" } }));
  let stdout = "", stderr = "", resolveUrl!: (value: string) => void;
  const endpoint = new Promise<string>(resolve => { resolveUrl = resolve; });
  const binary = process.env.ZAP_TEST_COMPILED_BINARY;
  const child = spawn(binary ?? process.execPath, [...(binary ? [] : [resolve(process.env.ZAP_TEST_CLI_ENTRY ?? "src/index.tsx")]), "--watch", "--watch-no-open", "--watch-linger", "30",
    "-p", "CANARY_PROMPT_SECRET", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "--dangerously-disable-os-sandbox",
    "--max-turns", "5", "--timeout-ms", "20000", "--cwd", cwd], { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: work, USERPROFILE: work, ZAPCODE_DATA_DIR: data, ZAPCODE_EXECUTION: "local", ZAPCODE_DEVTOOLS_PORT: "9876" } });
  const finished = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  child.stdout!.on("data", d => { stdout += String(d); });
  child.stderr!.on("data", d => { stderr += String(d); const match = stderr.match(/\[watch\] (http:\/\/127\.0\.0\.1:[0-9]+\/#token=[a-zA-Z0-9_-]+)/); if (match) resolveUrl(match[1]!); });
  const timer = setTimeout(() => { release(); child.kill("SIGKILL"); }, 25000), controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const url = new URL(await Promise.race([endpoint, finished.then(code => { throw Error(`CLI exited ${code}: ${stderr}`); })]));
    const html = await (await fetch(url.origin)).text();
    expect(html).toContain("<title>Zap Watch</title>");
    expect(html).toContain("/api/watch/v1/events");
    expect(html).not.toContain("__WATCH_NONCE__");
    const headers = { Authorization: `Bearer ${url.hash.slice(7)}` };
    const initial = await (await fetch(url.origin + "/api/watch/v1/snapshot", { headers })).json() as any;
    const stream = await fetch(`${url.origin}/api/watch/v1/events?instanceId=${initial.instanceId}&after=${initial.throughSeq}`, { headers, signal: controller.signal });
    reader = stream.body!.getReader(); release(); let buffer = "", terminal = false; const frames: any[] = [];
    while (!terminal) {
      const next = await reader.read(); if (next.done) throw Error("SSE closed before outcome"); buffer += new TextDecoder().decode(next.value);
      let end: number; while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const line = block.split("\n").find(x => x.startsWith("data: ")); if (!line || !block.includes("event: watch")) continue;
        const frame = JSON.parse(line.slice(6)); frames.push(frame);
        if (frame.changes.some((c: any) => c.op === "process.set" && c.state === "stopping")) terminal = true;
      }
    }
    const snapshot = await (await fetch(url.origin + "/api/watch/v1/snapshot", { headers })).json() as any;
    const tools = snapshot.nodes.filter((n: any) => n.kind === "tool");
    expect(tools.some((n: any) => n.label === "read_file" && n.wasExecuted && n.success === true)).toBe(true);
    expect(tools.some((n: any) => n.label === "agent" && n.success === true)).toBe(true);
    expect(new Set(tools.map((n: any) => n.scope.runId)).size).toBe(2);
    expect(snapshot.nodes.some((n: any) => n.kind === "request" && n.attempt === 1)).toBe(true);
    expect(snapshot.edges.some((e: any) => e.kind === "spawns")).toBe(true);
    expect(snapshot.outcomes[0].execution).toBe("finished");
    for (const canary of ["CANARY_TOOL_SECRET", "CANARY_FINAL_SECRET", "CANARY_SYSTEM_SECRET", "CANARY_PROMPT_SECRET", "CANARY_API_SECRET"]) {
      expect(JSON.stringify(snapshot) + JSON.stringify(frames)).not.toContain(canary);
    }
    expect(snapshot.diagnostics.unassociated_tool ?? 0).toBe(0);
    expect(snapshot.diagnostics.projection_error ?? 0).toBe(0);
    child.kill("SIGINT"); expect(await finished).toBe(0);
    const output = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(output.some((e: any) => e.type === "result")).toBe(true);
    expect(stdout).not.toContain("[watch]"); expect(stderr).toContain("Inherited DevTools collection disabled");
  } finally {
    release(); controller.abort(); await reader?.cancel().catch(() => {}); if (child.exitCode === null) child.kill("SIGKILL");
    await finished.catch(() => {}); clearTimeout(timer); provider.stop(); rmSync(work, { recursive: true, force: true });
  }
}, 30000);
