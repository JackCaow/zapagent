import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../builtin-tools/index.js";
import { isDefinitionCallReadOnly, resolveDefinitionEffects } from "../../tools/compatibility.js";

describe("path tool effects", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test("every model-addressable read tool declares its canonical filesystem scope", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-effects-paths-"));
    const canonicalRoot = realpathSync(root);
    cleanup.push(root);
    mkdirSync(join(root, "nested"));
    const registry = createBuiltinRegistry({
      executeCommand: { defaultCwd: root },
      readFile: { allowedPaths: [root] },
      listTree: { allowedPaths: [root] },
      searchFiles: { allowedPaths: [root] },
      globFiles: { allowedPaths: [root] },
      documentRead: { allowedPaths: [root] },
      exclude: ["bash"],
    });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["read_file", { path: "nested/file.txt" }],
      ["list_tree", { path: "nested" }],
      ["search_files", { path: "nested", pattern: "needle" }],
      ["glob_files", { path: "nested", pattern: "**/*" }],
      ["read_document", { path: "nested/file.pdf" }],
    ];

    for (const [name, args] of calls) {
      const effects = resolveDefinitionEffects(registry.get(name)?.definition, args, root);
      expect(effects.confidence).toBe("declared");
      expect(effects.filesystem).toHaveLength(1);
      expect(effects.filesystem[0]?.operation).toBe("read");
      expect(effects.filesystem[0]?.paths[0]?.startsWith(canonicalRoot)).toBe(true);
    }
    const search = registry.get("search_files")!.definition;
    expect(isDefinitionCallReadOnly(search, { path: "nested", pattern: "needle" }, root)).toBe(true);
    expect(resolveDefinitionEffects(search, { path: "nested", pattern: "needle" }, root)
      .process.every((effect) => effect.readOnly === true)).toBe(true);
  });
});
