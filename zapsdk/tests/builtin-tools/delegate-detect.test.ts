import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { detectProviders } from "../../builtin-tools/delegate-detect.js";

function withFakeBins(bins: Array<"claude" | "codex">, fn: (pathEnv: string) => Promise<void>) {
  return async () => {
    const dir = join(tmpdir(), `zapcode-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    for (const name of bins) {
      const p = join(dir, name);
      writeFileSync(p, "#!/bin/sh\necho fake-version 0.0.1\n", "utf8");
      chmodSync(p, 0o755);
    }
    try {
      await fn([dir, "/usr/bin", "/bin"].join(delimiter));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("detectProviders", () => {
  it("returns both providers when both are on PATH", withFakeBins(["claude", "codex"], async (pathEnv) => {
    const found = await detectProviders({ pathEnv });
    const names = found.map((p) => p.name).sort();
    expect(names).toEqual(["claude", "codex"]);
  }));

  it("returns just claude when only claude is on PATH", withFakeBins(["claude"], async (pathEnv) => {
    const found = await detectProviders({ pathEnv });
    expect(found.map((p) => p.name)).toEqual(["claude"]);
  }));

  it("returns empty when neither is on PATH", async () => {
    const found = await detectProviders({ pathEnv: "/this/path/does/not/exist" });
    expect(found).toEqual([]);
  });
});
