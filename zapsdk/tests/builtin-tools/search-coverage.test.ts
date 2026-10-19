import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFilesTool } from "../../builtin-tools/search.js";
import { createLocalProcessBroker } from "../../execution/process.js";
import { DEFAULT_TOOL_RESOURCE_LIMITS } from "../../tools/effects.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zap-search-coverage-"));
  roots.push(root);
  const process = createLocalProcessBroker();
  process.spawnCommand = () => { throw Object.assign(new Error("ripgrep unavailable in fixture"), { code: "ENOENT" }); };
  return { root, context: { process } };
}

describe("JavaScript search coverage", () => {
  for (const multiline of [false, true]) for (const direct of [false, true]) {
    it(`discloses an oversized matching file (${multiline ? "multiline" : "streaming"}, ${direct ? "file" : "directory"})`, async () => {
      const { root, context } = fixture();
      const file = join(root, "large.txt");
      writeFileSync(file, "TARGET\n".repeat(20));
      const result = await searchFilesTool({ maxFileSize: 32, allowedPaths: [root] }).handler(
        { path: direct ? file : root, pattern: "TARGET", glob: "*.txt", multiline }, undefined, context);
      expect(result.success).toBe(true);
      expect(result.output).not.toBe("No matches found.");
      expect(result.output).toContain("Search incomplete");
      expect(result.output).toContain("32 bytes");
      expect(result.output).toContain("large.txt");
      expect(result.meta).toMatchObject({ search: { backend: "javascript", skipped: { oversized: 1 } } });
    });
  }

  it("preserves matches and reports binary omissions without returning binary content", async () => {
    const { root, context } = fixture();
    writeFileSync(join(root, "text.txt"), "TARGET found\n");
    writeFileSync(join(root, "binary.dat"), Buffer.concat([Buffer.alloc(100), Buffer.from("TARGET secret payload")]));
    const result = await searchFilesTool().handler({ path: root, pattern: "TARGET", context_lines: 0 }, undefined, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain("text.txt:1: TARGET found");
    expect(result.output).toContain("binary");
    expect(result.output).not.toContain("secret payload");
    expect(result.meta).toMatchObject({ search: { skipped: { binary: 1 } } });
  });

  it("distinguishes intentional glob scope from a skipped in-scope file", async () => {
    const { root, context } = fixture();
    writeFileSync(join(root, "large.log"), "TARGET".repeat(50));
    writeFileSync(join(root, "small.txt"), "other\n");
    const result = await searchFilesTool({ maxFileSize: 32 }).handler(
      { path: root, pattern: "TARGET", glob: "*.txt" }, undefined, context);
    expect(result.output).toBe("No matches found.");
    expect(result.meta).toMatchObject({ search: { skipped: { oversized: 0, binary: 0, unreadable: 0 }, limitReached: false } });
  });

  it("marks capped results as incomplete while retaining the first matches", async () => {
    const { root, context } = fixture();
    writeFileSync(join(root, "many.txt"), "TARGET\n".repeat(8));
    const result = await searchFilesTool({ maxResults: 2 }).handler(
      { path: root, pattern: "TARGET", context_lines: 0 }, undefined, context);
    expect(result.output).toContain("many.txt:1: TARGET");
    expect(result.output).toContain("many.txt:2: TARGET");
    expect(result.output).not.toContain("many.txt:3");
    expect(result.output).toContain("Search incomplete");
    expect(result.meta).toMatchObject({ search: { limitReached: true } });
  });

  it("keeps permission denial and cancellation as failures", async () => {
    const { root, context } = fixture();
    writeFileSync(join(root, "text.txt"), "TARGET\n");
    const denied = await searchFilesTool({ allowedPaths: [join(root, "other")] }).handler(
      { path: root, pattern: "TARGET" }, undefined, context);
    expect(denied.success).toBe(false);
    const aborted = await searchFilesTool().handler(
      { path: root, pattern: "TARGET" }, AbortSignal.abort(), context);
    expect(aborted.success).toBe(false);
  });

  it("reports the effective host limit and bounds skipped-path examples", async () => {
    const { root, context } = fixture();
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `large-${i}.txt`), "TARGET".repeat(20));
    const result = await searchFilesTool({ maxFileSize: 1000 }).handler(
      { path: root, pattern: "TARGET" }, undefined,
      { ...context, limits: { ...DEFAULT_TOOL_RESOURCE_LIMITS, maxFileBytes: 32 } });
    expect(result.output).toContain("20 file(s) exceeded 32 bytes");
    expect(result.output.length).toBeLessThan(1000);
    const coverage = result.meta as { search: { examples: unknown[]; skipped: { oversized: number } } };
    expect(coverage.search.examples).toHaveLength(3);
    expect(coverage.search.skipped.oversized).toBe(20);
  });

  for (const multiline of [false, true]) {
    const testPermissions = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
    testPermissions(`retains partial matches and reports OS-denied paths (multiline=${multiline})`, async () => {
      const { root, context } = fixture();
      const file = join(root, "unreadable.txt"), directory = join(root, "unreadable-dir");
      writeFileSync(join(root, "visible.txt"), "TARGET found\n");
      writeFileSync(file, "TARGET hidden\n");
      mkdirSync(directory);
      writeFileSync(join(directory, "hidden.txt"), "TARGET hidden\n");
      chmodSync(file, 0); chmodSync(directory, 0);
      try {
        const result = await searchFilesTool().handler(
          { path: root, pattern: "TARGET", multiline, context_lines: 0 }, undefined, context);
        expect(result.success).toBe(true);
        expect(result.output).toContain("visible.txt:1");
        expect(result.output).toContain("2 path(s) could not be read");
        expect(result.output).not.toContain("TARGET hidden");
        expect(result.meta).toMatchObject({ search: { skipped: { unreadable: 2 } } });
      } finally { chmodSync(file, 0o600); chmodSync(directory, 0o700); }
    });
  }
});
