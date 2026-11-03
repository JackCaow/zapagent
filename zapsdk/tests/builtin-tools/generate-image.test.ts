import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Resvg } from "@resvg/resvg-js";
import { generateImageTool } from "../../builtin-tools/generate-image.js";
import { restoreGeneratedImage } from "../../utils/generated-image.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolExecutor } from "../../tools/executor.js";
import { DefaultExecutionBroker } from "../../execution/broker.js";
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="green"/></svg>').render().asPng();
let root: string, calls: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "zap-generate-image-test-")); calls = 0; mkdirSync(join(root, "workspace")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function tool(generate?: () => Promise<any>, grants = false) {
  return generateImageTool({ defaultCwd: join(root, "workspace"), allowedPaths: [join(root, "workspace")], protectedPaths: [join(root, "workspace", ".git")],
    artifactDirectory: join(root, "artifacts"), useExecutionGrants: grants,
    generate: async () => { calls++; return generate ? generate() : { bytes: png, width: 2, height: 3, requestBytes: 200, responseBytes: 500 }; } });
}

test("writes PNG once, returns preview/image block and stores a bounded recoverable artifact", async () => {
  const result = await tool().handler({ prompt: "green rectangle", output_path: "out/image.png" });
  expect(result.success).toBe(true);
  expect(calls).toBe(1);
  expect(readFileSync(join(root, "workspace/out/image.png"))).toEqual(png);
  expect(result.output).toContain("2×3");
  expect(result.contentBlocks?.[0]).toMatchObject({ type: "image", mediaType: "image/png", base64: png.toString("base64") });
  expect((result.meta as any).generatedImage.thumbnail).toMatchObject({ width: 32, height: 32 });
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toEqual(png);
  const second = await tool().handler({ prompt: "another", output_path: "out/image.png" });
  expect(second.success).toBe(false); expect(calls).toBe(1);
});

test("rejects protected, outside, existing, symlink and ungranted targets before remote generation", async () => {
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "workspace/link"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "workspace/existing.png"), "existing");
  for (const path of ["../outside/image.png", ".git/image.png", "link/image.png", "existing.png", "not-image.txt"]) {
    expect((await tool().handler({ prompt: "draw", output_path: path })).success).toBe(false);
  }
  expect((await tool(undefined, true).handler({ prompt: "draw", output_path: "ok.png" })).success).toBe(false);
  expect(calls).toBe(0);
  expect(readFileSync(join(root, "workspace/existing.png"), "utf8")).toBe("existing");
});

test("prevents overwrites after generation, retaining a cached image instead of retrying", async () => {
  const result = await tool(async () => {
    writeFileSync(join(root, "workspace/race.png"), "concurrent edit");
    return { bytes: png, width: 2, height: 3, requestBytes: 1, responseBytes: 100 };
  }).handler({ prompt: "draw", output_path: "race.png" });
  expect(result.success).toBe(false); expect(calls).toBe(1);
  expect(readFileSync(join(root, "workspace/race.png"), "utf8")).toBe("concurrent edit");
  expect(result.error).toContain("recover the existing PNG");
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toEqual(png);
  expect(readdirSync(join(root, "workspace")).some(name => name.includes(".tmp."))).toBe(false);
});

test("cancel after provider completion retains the artifact without publishing the target", async () => {
  const controller = new AbortController();
  const result = await tool(async () => { controller.abort(); return { bytes: png, width: 2, height: 3, requestBytes: 1, responseBytes: 1 }; })
    .handler({ prompt: "draw", output_path: "cancelled.png" }, controller.signal);
  expect(result.success).toBe(false);
  expect(existsSync(join(root, "workspace/cancelled.png"))).toBe(false);
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toEqual(png);
  expect(calls).toBe(1);
});

test("tool execution requires approval and uses the actual grant for workspace writes", async () => {
  const registry = new ToolRegistry(); registry.register(tool(undefined, true));
  const deny = new ToolExecutor(registry, { cwd: join(root, "workspace"), onApproval: async () => false });
  expect((await deny.execute("generate_image", { prompt: "draw", output_path: "denied.png" })).success).toBe(false);
  expect(calls).toBe(0);
  const approved = new ToolExecutor(registry, { cwd: join(root, "workspace"), onApproval: async () => true,
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "disabled" }) });
  const result = await approved.execute("generate_image", { prompt: "draw", output_path: "approved.png" });
  expect(result.success).toBe(true);
  expect(existsSync(join(root, "workspace/approved.png"))).toBe(true);
  expect(calls).toBe(1);
});

test("cache restore ignores arbitrary metadata paths and rejects corrupted and symlinked entries", async () => {
  const result = await tool().handler({ prompt: "draw", output_path: "ok.png" });
  const artifact = (result.meta as any).generatedImage;
  const cache = join(root, "artifacts", `${artifact.id}.png`);
  artifact.filePath = join(root, "outside/secret.png");
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toEqual(png);
  writeFileSync(cache, "corrupt");
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toBeUndefined();
  rmSync(cache); symlinkSync(join(root, "workspace/ok.png"), cache);
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toBeUndefined();
  expect(restoreGeneratedImage(join(root, "artifacts"), { generatedImage: { ...artifact, id: "../../secret" } })).toBeUndefined();
});


test("a workspace file budget failure preserves the completed artifact without publishing or retrying", async () => {
  const registry = new ToolRegistry(); registry.register(tool(undefined, true));
  const executor = new ToolExecutor(registry, { cwd: join(root, "workspace"), onApproval: async () => true,
    executionBroker: new DefaultExecutionBroker({ sandboxMode: "disabled", limits: { maxFileBytes: 10 } }) });
  const result = await executor.execute("generate_image", { prompt: "draw", output_path: "too-large.png" });
  expect(result.success).toBe(false); expect(calls).toBe(1);
  expect(existsSync(join(root, "workspace/too-large.png"))).toBe(false);
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toEqual(png);
});

test("a changed directory after remote completion cannot redirect the image outside the workspace", async () => {
  mkdirSync(join(root, "workspace/mutable")); mkdirSync(join(root, "outside"));
  const result = await tool(async () => {
    rmSync(join(root, "workspace/mutable"), { recursive: true });
    symlinkSync(join(root, "outside"), join(root, "workspace/mutable"), process.platform === "win32" ? "junction" : "dir");
    return { bytes: png, width: 2, height: 3, requestBytes: 1, responseBytes: 1 };
  }).handler({ prompt: "draw", output_path: "mutable/image.png" });
  expect(result.success).toBe(false); expect(calls).toBe(1);
  expect(existsSync(join(root, "outside/image.png"))).toBe(false);
  expect(restoreGeneratedImage(join(root, "artifacts"), result.meta)).toEqual(png);
});
