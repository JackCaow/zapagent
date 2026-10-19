import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCustomProvider, getDefaultConfig } from "../../src/config.js";
import { createPublicChecks } from "../../src/headless/publicChecks.js";
import { parseHeadlessArgs } from "../../src/headless/args.js";
import { isHeadlessInvocation } from "../../src/cli-routing.js";
import { validateInlineAcceptanceRecord } from "../../zapsdk/runtime/inline-acceptance.js";

const manifest = () => ({ version: 1, id: "public-result", revision: 1, maxRepairAttempts: 1,
  budget: { modelCalls: 8, toolCalls: 4, timeoutMs: 15000 }, checks: [
    { id: "content", path: "result.json", kind: "json-equals", pointer: "/ok", expected: true },
    { id: "size", path: "result.json", kind: "file-size", maxBytes: 64 },
    { id: "encoding", path: "result.json", kind: "utf8" },
  ] });

it("validates public declarations before execution and never accepts executable configuration", () => {
  for (const value of [ { ...manifest(), command: "touch unauthorized" },
    { ...manifest(), checks: [{ ...manifest().checks[0], path: "../secret" }] },
    { ...manifest(), checks: [{ ...manifest().checks[0], pointer: "/~2invalid" }] },
    { ...manifest(), checks: [manifest().checks[0], manifest().checks[0]] },
    { ...manifest(), budget: { ...manifest().budget, modelCalls: Infinity } },
    { ...manifest(), maxRepairAttempts: -1 },
  ]) expect(() => createPublicChecks(value, "/tmp", "/tmp/unused")).toThrow();
  expect(createPublicChecks(manifest(), "/tmp", "/tmp/unused").acceptance.spec.subjects).toHaveLength(1);
  expect(parseHeadlessArgs(["-p", "x", "--public-checks", "checks.json"]).ok).toBe(true);
  expect(parseHeadlessArgs(["-p", "x", "--public-checks", "a", "--public-checks", "b"]).ok).toBe(false);
  expect(parseHeadlessArgs(["-p", "x", "--public-checks"]).ok).toBe(false);
  expect(isHeadlessInvocation(["--public-checks", "checks.json"], true)).toBe(false);
});

it("checks immutable bytes, strict UTF-8 and escaped JSON pointers with bounded diagnostics", async () => {
  const config = createPublicChecks({ ...manifest(), checks: [
    { id: "content", path: "result.json", kind: "json-equals", pointer: "/a~1b/~0key", expected: true },
    manifest().checks[2],
  ] }, "/tmp", "/tmp/unused");
  for (const [bytes, codes] of [
    [new TextEncoder().encode('{"a/b":{"~key":false}}'), ["JSON_VALUE_MISMATCH", "UTF8_OK"]],
    [new TextEncoder().encode('{"a/b":{"~key":true}}'), ["JSON_VALUE_OK", "UTF8_OK"]],
    [new Uint8Array([0xf5]), ["INVALID_UTF8", "INVALID_UTF8"]],
    [new TextEncoder().encode("bad json"), ["INVALID_JSON", "UTF8_OK"]],
  ] as const) {
    const result = await config.acceptance.verifiers[0]!.verify({ outcome: { attemptId: "a" } as any,
      spec: config.acceptance.spec, snapshot: { id: "snapshot", providerId: "fixture", proof: "immutable_snapshot",
        subjects: [{ subjectId: "file-0", exists: true, version: "sha256:fixture" }], readFile: async () => bytes.slice() },
      signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
    expect(result.map(check => check.code)).toEqual([...codes]);
    expect(result.every(check => !!check.publicDiagnostic && check.dependencies[0]!.version === "sha256:fixture")).toBe(true);
  }
  const arrayCheck = createPublicChecks({ ...manifest(), checks: [
    { id: "array", path: "result.json", kind: "json-equals", pointer: "/length", expected: 1 },
  ] }, "/tmp", "/tmp/unused");
  const arrayResult = await arrayCheck.acceptance.verifiers[0]!.verify({ outcome: { attemptId: "a" } as any,
    spec: arrayCheck.acceptance.spec, snapshot: { id: "s", providerId: "fixture", proof: "immutable_snapshot",
      subjects: [{ subjectId: "file-0", exists: true, version: "v" }], readFile: async () => new TextEncoder().encode("[true]") },
    signal: new AbortController().signal, deadlineAt: Date.now() + 1000 });
  expect(arrayResult[0]!.code).toBe("JSON_VALUE_MISMATCH"); // Array properties are not JSON Pointer members.
});

it("real CLI repairs a semantic failure, retains receipts, respects limits/denial and pins its public configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "zap-public-cli-"));
  const data = join(root, "data"); await mkdir(data);
  let calls = 0, mode = "repair", cwd = root;
  const requests: any[] = [];
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as any; requests.push(body);
    const index = calls++;
    if (mode === "deadline") await new Promise(resolve => setTimeout(resolve, 1000));
    // Changing the manifest after startup must not rewrite the accepted spec.
    if (mode === "repair" && index === 0) await writeFile(join(cwd, "checks.json"), JSON.stringify({ ...manifest(), checks: [] }));
    const delta = index % 2 === 0 ? { tool_calls: [{ index: 0, id: `write-${index}`, type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: "result.json", content: JSON.stringify({ ok: mode === "host-failure" || index >= 2 && mode === "repair" }) }) } }] }
      : { content: "Done." };
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: index % 2 === 0 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const provider = createCustomProvider({ name: "Fixture", baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture", models: ["fixture-model"], contextWindow: 128000 });
    await writeFile(join(data, "config.json"), JSON.stringify({ ...getDefaultConfig(), providers: [provider], active: { providerId: provider.id, model: "fixture-model" } }), { mode: 0o600 });
    const hostFailureEntry = join(root, "host-failure.ts");
    await writeFile(hostFailureEntry, `
      import { runHeadless } from ${JSON.stringify(resolve("src/headless/runHeadless.ts"))};
      import { parseHeadlessArgs } from ${JSON.stringify(resolve("src/headless/args.ts"))};
      import { createFormatter } from ${JSON.stringify(resolve("src/headless/formatter.ts"))};
      const parsed = parseHeadlessArgs(process.argv.slice(2));
      if (!parsed.ok) throw new Error(parsed.message);
      const formatter = createFormatter("stream-json", false, "outcome-v1");
      const onEvent = formatter.onEvent;
      formatter.onEvent = event => {
        if (event.kind === "runtime_lifecycle" && event.detail.stage === "runtime_returned") throw new Error("host result processing failed");
        onEvent(event);
      };
      process.exit(await runHeadless(parsed.args, { formatter }));
    `);
    for (mode of ["repair", "exhausted", "budget", "denied", "deadline", "host-failure", "invalid", "legacy", "resume"]) {
      calls = 0; requests.length = 0;
      cwd = join(root, mode); await mkdir(cwd);
      const config = manifest();
      if (mode === "budget") config.budget.modelCalls = 2;
      if (mode === "deadline") config.budget.timeoutMs = 200;
      if (mode === "invalid") config.checks = [];
      await writeFile(join(cwd, "checks.json"), JSON.stringify(config));
      const child = spawn(process.execPath, [mode === "host-failure" ? hostFailureEntry : resolve("src/index.tsx"), "-p", "Write result.json with ok true.", "--public-checks", "checks.json",
        "--result-schema", mode === "legacy" ? "legacy" : "outcome-v1", "--output-format", "stream-json",
        "--permission-mode", mode === "denied" ? "default" : "bypassPermissions", "--dangerously-disable-os-sandbox", "--cwd", cwd,
        ...(mode === "resume" ? ["--continue"] : []),
      ], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAPCODE_DISABLE_BACKGROUND_TASKS: "1", ZAPCODE_DEVTOOLS_PORT: "" } });
      let stdout = "", stderr = "";
      child.stdout!.on("data", chunk => { stdout += String(chunk); });
      child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const guard = setTimeout(() => child.kill("SIGKILL"), 20000);
      let code: number | null;
      try { code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
      finally { clearTimeout(guard); }
      if (["invalid", "legacy", "resume"].includes(mode)) {
        expect({ mode, code, stderr }).toMatchObject({ code: 2 }); expect(calls).toBe(0); continue;
      }
      const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
      const finals = lines.filter(line => line.type === "result");
      if (mode === "deadline") {
        expect(code).toBe(124);
        expect(finals).toHaveLength(0);
        expect(lines.some(line => line.type === "error" && line.code === "REPAIR_DEADLINE_EXCEEDED")).toBe(true);
        expect(calls).toBeLessThanOrEqual(1);
        continue;
      }
      if (mode === "host-failure") {
        expect(code).toBe(1);
        expect(finals).toHaveLength(0);
        expect(lines.some(line => line.type === "error" && line.message === "host result processing failed")).toBe(true);
        expect(calls).toBe(2);
        expect(JSON.parse(await readFile(join(cwd, "result.json"), "utf8"))).toEqual({ ok: true });
        continue;
      }
      expect(finals).toHaveLength(1);
      const final = finals[0];
      expect(final.schema).toBe("zap.outcome");
      expect(code).toBe(mode === "repair" ? 0 : 5);
      expect(final.ok).toBe(mode === "repair");
      expect(final.publicChecks.usage.modelCalls).toBe(calls);
      expect(requests[0].tools.some((tool: any) => ["agent", "delegate_agent", "cron_create"].includes(tool.function.name))).toBe(false);
      if (mode === "repair" || mode === "exhausted") {
        expect(calls).toBe(4);
        expect(final.publicChecks.attempts).toHaveLength(2);
        const [first, second] = final.publicChecks.attempts;
        expect(first.attemptId).not.toBe(second.attemptId);
        expect(first.report.status).toBe("failed");
        expect(second.report.status).toBe(mode === "repair" ? "passed" : "failed");
        const feedback = JSON.stringify(requests[2].messages);
        expect(feedback).toContain("JSON_VALUE_MISMATCH");
        expect(feedback).toContain(first.snapshotId);
        expect(feedback).toContain("sha256:");
        expect(feedback).toContain("consecutiveFailures");
        expect(feedback).toContain("false");
        expect(final.turns).toBe(2); // Tool rounds; model calls also include final responses.
        if (mode === "repair") expect(JSON.parse(await readFile(join(cwd, "result.json"), "utf8"))).toEqual({ ok: true });
      } else {
        expect(calls).toBe(2);
        expect(final.publicChecks.code).toBe(mode === "budget" ? "REPAIR_MODEL_LIMIT" : "REPAIR_PREREQUISITE_BLOCKED");
        if (mode === "denied") await expect(readFile(join(cwd, "result.json"))).rejects.toThrow();
      }
    }
    const records = [];
    for (const project of await readdir(join(data, "projects"))) {
      const directory = join(data, "projects", project, "acceptance");
      for (const file of await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) if (file.endsWith(".json")) {
        const record = JSON.parse(await readFile(join(directory, file), "utf8"));
        validateInlineAcceptanceRecord(record); records.push(record);
      }
    }
    expect(records.length).toBeGreaterThanOrEqual(6);
    expect(records.some(record => record.report.status === "passed")).toBe(true);
  } finally { model.stop(); await rm(root, { recursive: true, force: true }); }
}, 60000);
