import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
declare const Bun: { which(command: string): string | null; spawn(command: string[], options: { env: NodeJS.ProcessEnv; stdout: "pipe"; stderr: "pipe" }): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> } };
const { ensureBinary, target } = createRequire(import.meta.url)("../npm/install.cjs");
const bytes = Buffer.from("native candidate");
const hash = createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zap-native-download-"));
  const urls: string[] = [];
  const options = { version: "1.2.3-rc.1", platform: "linux", arch: "arm64", env: { ZAPAGENT_CACHE_DIR: root },
    fetch: async (url: string) => { urls.push(url); return url.endsWith(".sha256")
      ? new Response(`${hash}  zap-linux-arm64\n`) : new Response(bytes); } };
  return { root, urls, options };
}
describe("native npm CLI", () => {
  it("selects the five published assets and rejects unsupported platforms before network access", async () => {
    expect(target("darwin", "arm64")).toBe("zap-macos-arm64");
    expect(target("darwin", "x64")).toBe("zap-macos-x64");
    expect(target("linux", "arm64")).toBe("zap-linux-arm64");
    expect(target("linux", "x64")).toBe("zap-linux-x64");
    expect(target("win32", "x64")).toBe("zap-windows-x64.exe");
    await expect(ensureBinary({ platform: "freebsd", arch: "x64" })).rejects.toThrow("does not provide a binary");
  });
  it("pins URLs to the package version, verifies bytes and reuses an offline cache", async () => {
    const f = fixture();
    try {
      const file = await ensureBinary(f.options);
      expect(readFileSync(file)).toEqual(bytes);
      expect(f.urls).toEqual([
        "https://github.com/JackCaow/zapagent/releases/download/v1.2.3-rc.1/zap-linux-arm64.sha256",
        "https://github.com/JackCaow/zapagent/releases/download/v1.2.3-rc.1/zap-linux-arm64",
      ]);
      expect(await ensureBinary({ ...f.options, fetch: () => { throw Error("offline"); } })).toBe(file);
      writeFileSync(file, "damaged");
      expect(await ensureBinary(f.options)).toBe(file);
      expect(readFileSync(file)).toEqual(bytes);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("does not install corrupted bytes and permits a clean retry", async () => {
    const f = fixture();
    try {
      await expect(ensureBinary({ ...f.options, fetch: async (url: string) => url.endsWith(".sha256")
        ? f.options.fetch(url) : new Response("corrupt") })).rejects.toThrow("Checksum verification failed");
      expect(readdirSync(f.root, { recursive: true }).some(file => String(file).endsWith(".tmp") || String(file).endsWith(".sha256"))).toBe(false);
      expect(readFileSync(await ensureBinary(f.options))).toEqual(bytes);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("rejects a checksum for another asset, insecure origins, and HTTP failures", async () => {
    const f = fixture();
    try {
      await expect(ensureBinary({ ...f.options, fetch: async () => new Response(`${hash}  wrong.exe`) })).rejects.toThrow("Invalid checksum metadata");
      await expect(ensureBinary({ ...f.options, env: { ...f.options.env, ZAPAGENT_DOWNLOAD_BASE_URL: "http://example.com" } })).rejects.toThrow("require HTTPS");
      await expect(ensureBinary({ ...f.options, fetch: async () => new Response("not found", { status: 404 }) })).rejects.toThrow("HTTP 404");
      expect(readdirSync(f.root)).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("publishes one verified cache entry when installers race", async () => {
    const f = fixture();
    try {
      const files = await Promise.all(Array.from({ length: 3 }, () => ensureBinary(f.options)));
      expect(new Set(files).size).toBe(1);
      expect(readdirSync(dirname(files[0])).sort()).toEqual(["zap", "zap.sha256"]);
      expect(readFileSync(files[0])).toEqual(bytes);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

(process.platform === "win32" ? it.skip : it)("forwards arguments and exit status through Node with no Bun on PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "zap-node-launch-"));
  try {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const script = Buffer.from('#!/bin/sh\nprintf "%s\\n" "$@"\nexit 17\n');
    const checksum = createHash("sha256").update(script).digest("hex");
    await ensureBinary({ version, env: { ZAPAGENT_CACHE_DIR: root },
      fetch: async (url: string) => url.endsWith(".sha256")
        ? new Response(`${checksum}  ${target()}\n`) : new Response(script) });
    const proc = Bun.spawn([Bun.which("node")!, join(process.cwd(), "npm/cli.cjs"), "--fixture", "argument with spaces"], {
      env: { ...process.env, PATH: "", ZAPAGENT_CACHE_DIR: root }, stdout: "pipe", stderr: "pipe",
    });
    expect(await new Response(proc.stdout).text()).toBe("--fixture\nargument with spaces\n");
    expect(await proc.exited).toBe(17);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
