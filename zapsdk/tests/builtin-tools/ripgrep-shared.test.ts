import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globFilesTool } from "../../builtin-tools/glob.js";
import { searchFilesTool } from "../../builtin-tools/search.js";
import { getRgBin, runRipgrepRecords } from "../../builtin-tools/ripgrep.js";
import { createLocalProcessBroker } from "../../execution/process.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS } from "../../tools/effects.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zap-rg-shared-"));
  roots.push(root);
  return root;
}
function put(root: string, name: string, text = "TARGET\n") {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function unavailable() {
  const broker = createLocalProcessBroker();
  broker.spawnCommand = () => { throw Object.assign(new Error("missing rg"), { code: "ENOENT" }); };
  return broker;
}

describe("shared ripgrep retrieval", () => {
  it("finds a late file past 10,000 entries with the real rg backend", async () => {
    expect(getRgBin()).toBeTruthy();
    const root = fixture();
    for (let i = 0; i < 12000; i++) put(root, `cache/file-${i}.dat`, "");
    put(root, "zzz/skills/SKILL.md");
    const result = await globFilesTool().handler({ path: root, pattern: "**/SKILL.md" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("zzz/skills/SKILL.md");
    expect(result.meta).toMatchObject({ search: { backend: "ripgrep", complete: true, returned: 1 } });
    const fallback = await globFilesTool().handler({ path: root, pattern: "**/SKILL.md" }, undefined, { process: unavailable() });
    expect(fallback.success).toBe(true);
    expect(fallback.output).toContain("zzz/skills/SKILL.md");
    expect(fallback.meta).toMatchObject({ search: { backend: "javascript", complete: false, returned: 1 } });
  }, 30_000);

  it("shares hidden-file, nested-ignore and negation scope without forcing ignored matches back in", async () => {
    const root = fixture();
    put(root, ".gitignore", "cache/\n*.log\n!keep.log\n");
    put(root, "nested/.gitignore", "omit.ts\n");
    for (const name of [".skills/SKILL.md", "keep.log", "top.ts", "nested/ok.ts", "cache/hidden.ts", "drop.log", "nested/omit.ts", "node_modules/pkg/file.ts", ".git/internal.ts"]) put(root, name);
    const glob = await globFilesTool().handler({ path: root, pattern: "**/*" });
    const search = await searchFilesTool().handler({ path: root, pattern: "TARGET", context_lines: 0 });
    for (const output of [glob.output, search.output]) {
      for (const name of [".skills/SKILL.md", "keep.log", "top.ts", "nested/ok.ts"]) expect(output).toContain(name);
      for (const name of ["cache/hidden.ts", "drop.log", "nested/omit.ts", "node_modules/pkg/file.ts", ".git/internal.ts"]) expect(output).not.toContain(name);
    }
    const ignored = await globFilesTool().handler({ path: root, pattern: "**/hidden.ts" });
    expect(ignored.meta).toMatchObject({ search: { complete: true, returned: 0 } });
  });

  it("preserves relative glob syntax and NUL-delimited filenames", async () => {
    const root = fixture();
    for (const name of ["a.ts", "b.js", "sub/c.ts", "line\nbreak.ts", "中文.ts"]) put(root, name);
    const result = await globFilesTool().handler({ path: root, pattern: "*.{ts,js}" });
    expect(result.meta).toMatchObject({ search: { returned: 4 } });
    expect(result.output).toContain('"line\\nbreak.ts"');
    expect(result.output).toContain("中文.ts");
    expect(result.output).not.toContain("sub/c.ts");
  });

  it("uses a lookahead to distinguish an exact result count from truncation", async () => {
    const root = fixture();
    put(root, "a.ts"); put(root, "b.ts");
    const tool = globFilesTool({ maxResults: 2 });
    expect((await tool.handler({ path: root, pattern: "**/*.ts" })).meta).toMatchObject({ search: { complete: true, returned: 2 } });
    put(root, "c.ts");
    const truncated = await tool.handler({ path: root, pattern: "**/*.ts" });
    expect(truncated.meta).toMatchObject({ search: { complete: false, returned: 2 } });
    expect(truncated.output).toContain("result_limit");
    const search = await searchFilesTool({ maxResults: 2 }).handler({ path: root, pattern: "TARGET", context_lines: 0 });
    expect(search.output).toContain("Search incomplete");
    expect(search.meta).toMatchObject({ search: { backend: "ripgrep", limitReached: true } });
  });

  it("retains explicit host result/depth/output budgets without hiding their scope", async () => {
    const root = fixture();
    put(root, "a.ts"); put(root, "b.ts"); put(root, "sub/c.ts");
    const limited = await globFilesTool().handler({ path: root, pattern: "**/*.ts" }, undefined,
      { limits: { ...DEFAULT_TOOL_RESOURCE_LIMITS, maxFiles: 1, maxDepth: 0 } });
    expect(limited.meta).toMatchObject({ search: { returned: 1, complete: false, maxDepth: 0 } });
    expect(limited.output).toContain("directory depth <= 0");
    expect(limited.output).not.toContain("sub/c.ts");
    const outputLimited = await globFilesTool().handler({ path: root, pattern: "**/*.ts" }, undefined,
      { limits: { ...DEFAULT_TOOL_RESOURCE_LIMITS, maxOutputBytes: 2049 } });
    expect(outputLimited.output).toContain("Glob incomplete");
    expect(outputLimited.meta).toMatchObject({ search: { returned: 0, complete: false } });
  });

  it("enforces path authorization before spawning and declares brokered read-only search", async () => {
    const root = fixture();
    const broker = createLocalProcessBroker();
    const tool = globFilesTool({ allowedPaths: [join(root, "allowed")] });
    const result = await tool.handler({ path: root, pattern: "**/*" }, undefined, { process: broker });
    expect(result.success).toBe(false);
    expect(broker.spawnCount).toBe(0);
    expect(tool.definition.sandboxAware).toBe(true);
    const effects = await tool.definition.resolveEffects!({ path: root, pattern: "*" }, { cwd: root, toolName: "glob_files" });
    expect(effects.process).toEqual([{ kind: "process", operation: "spawn", commandClass: "search", background: false, readOnly: true }]);
  });

  it("does not follow links outside the search tree", async () => {
    const root = fixture(), outside = fixture();
    put(outside, "secret.ts");
    symlinkSync(outside, join(root, "linked"), "dir");
    const result = await globFilesTool().handler({ path: root, pattern: "**/*.ts" });
    expect(result.output).not.toContain("secret.ts");
  });

  it("keeps unavailable-backend fallback bounded and visibly incomplete", async () => {
    const root = fixture();
    put(root, "a.ts"); put(root, "sub/b.ts");
    const result = await globFilesTool({ maxResults: 1 }).handler({ path: root, pattern: "**/*.ts" }, undefined, { process: unavailable() });
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({ search: { backend: "javascript", complete: false, returned: 1 } });
    expect(result.output).toContain("result_limit");
    const depth = await globFilesTool({ maxDepth: 0 }).handler({ path: root, pattern: "**/*.ts" }, undefined, { process: unavailable() });
    expect(depth.output).toContain("depth_limit");
  });

  it("keeps policy/spawn denial as failure in both tools, never a native filesystem fallback", async () => {
    const root = fixture(); put(root, "visible.ts");
    for (const tool of [globFilesTool(), searchFilesTool()]) {
      const broker = createLocalProcessBroker();
      broker.spawnCommand = () => { throw new Error("policy denied"); };
      const result = await tool.handler({ path: root, pattern: "TARGET" }, undefined, { process: broker });
      expect(result.success).toBe(false);
      expect(result.error).toContain("policy denied");
      expect(result.meta).toMatchObject({ search: { backend: "ripgrep", complete: false } });
    }
  });

  const permissionTest = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
  permissionTest("preserves accessible matches and reports rg traversal errors", async () => {
    const root = fixture(); put(root, "visible.ts"); put(root, "denied/secret.ts");
    chmodSync(join(root, "denied"), 0);
    try {
      const result = await globFilesTool().handler({ path: root, pattern: "**/*.ts" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("visible.ts");
      expect(result.meta).toMatchObject({ search: { backend: "ripgrep", complete: false } });
    } finally { chmodSync(join(root, "denied"), 0o700); }
  });

  it("reports invalid regex as an rg failure", async () => {
    const root = fixture(); put(root, "a.ts");
    const result = await searchFilesTool().handler({ path: root, pattern: "[" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("regex parse error");
    expect(result.meta).toMatchObject({ search: { backend: "ripgrep" } });
  });
});

describe("shared search process lifetime", () => {
  for (const mode of ["timeout", "abort", "failure"] as const) it(`retains records and reports ${mode}`, async () => {
    const root = fixture();
    const broker = createLocalProcessBroker();
    const spawn = broker.spawnCommand.bind(broker);
    broker.spawnCommand = (_exe, _args, options) => spawn(process.execPath, ["-e",
      mode === "failure" ? 'process.stdout.write("first\\0");process.stderr.write("failure");process.exit(2);'
        : 'process.stdout.write("first\\0");setTimeout(()=>{},10000);'], options);
    const controller = new AbortController();
    const records: string[] = [];
    const run = await runRipgrepRecords("rg", [], { process: broker, cwd: root, separator: "\0",
      signal: controller.signal, timeoutMs: mode === "timeout" ? 200 : 2000,
      onRecord(record) { records.push(record); if (mode === "abort") controller.abort(); return undefined; },
    });
    expect(records).toEqual(["first"]);
    expect(run.error).toContain(mode === "timeout" ? "timed out" : mode === "abort" ? "aborted" : "code 2");
    expect(run.unavailable).not.toBe(true);
  });
});
