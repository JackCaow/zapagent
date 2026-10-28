import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupNpmOfflineInstall, createNpmVmWorkspace, importNpmVmWorkspace, prepareNpmOfflineInstall, recoverNpmVmImport, revalidateNpmOfflineInstall } from "../../goal/npm-installer.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// The fixture resolves the POSIX npm launcher to npm-cli.js. Windows needs a
// separate trusted toolchain discovery and real Job Object integration test.
const npmTest = process.platform === "win32" ? test.skip : test;
function findExecutable(name: string): string {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${name} is required for this integration fixture`);
  return result.stdout.split(/\r?\n/)[0]!.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zap-goal-npm-")); roots.push(root);
  const workspace = join(root, "workspace"), privateRoot = join(root, "private"), packageRoot = join(root, "package");
  await Promise.all([mkdir(workspace), mkdir(privateRoot, { mode: 0o700 }), mkdir(packageRoot)]);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "goal-npm-fixture", version: "1.0.0", scripts: { postinstall: "node -e \"require('fs').writeFileSync('postinstall-ran','yes')\"" } }));
  await writeFile(join(packageRoot, "index.js"), "module.exports = 42;\n");
  const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: packageRoot, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" });
  if (pack.status !== 0) throw new Error(`npm pack fixture failed: ${pack.stderr}`);
  const filename = JSON.parse(pack.stdout)[0].filename as string;
  const archive = await readFile(join(root, filename));
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const manifest = { name: "goal-npm-project", version: "1.0.0", dependencies: { "goal-npm-fixture": "1.0.0" } };
  const lock = { ...manifest, lockfileVersion: 3, requires: true, packages: { "": manifest,
    "node_modules/goal-npm-fixture": { version: "1.0.0", resolved: "https://registry.npmjs.org/goal-npm-fixture/-/goal-npm-fixture-1.0.0.tgz", integrity } } };
  await writeFile(join(workspace, "package.json"), JSON.stringify(manifest));
  await writeFile(join(workspace, "package-lock.json"), JSON.stringify(lock));
  const nodeExecutable = await realpath(findExecutable("node"));
  const npmCliScript = await realpath(findExecutable("npm"));
  return { root, workspace, privateRoot, archive, lock, nodeExecutable, npmCliScript };
}

describe("Goal npm offline installation preparation", () => {
  npmTest("fetches exact locked tarball via GET, checks integrity and supports actual offline npm ci without scripts", async () => {
    const f = await fixture(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mock: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(f.archive); };
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: mock });
    expect(prepared.tarballs).toBe(1);
    expect(await readFile(join(prepared.snapshotPath, "package.json"), "utf8"))
      .toBe(await readFile(join(f.workspace, "package.json"), "utf8"));
    expect(await readFile(join(prepared.snapshotPath, "package-lock.json"), "utf8"))
      .toBe(await readFile(join(f.workspace, "package-lock.json"), "utf8"));
    expect(calls.map(x => [x.url, x.init?.method, x.init?.redirect, x.init?.credentials])).toEqual([
      ["https://registry.npmjs.org/goal-npm-fixture/-/goal-npm-fixture-1.0.0.tgz", "GET", "manual", "omit"],
    ]);
    await revalidateNpmOfflineInstall(prepared);
    // Fixture only: production executes this argv through its contained Broker.
    const run = spawnSync(prepared.argv[0]!, prepared.argv.slice(1), { cwd: prepared.workspace,
      env: { ...prepared.environment }, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(await readFile(join(f.workspace, "node_modules/goal-npm-fixture/index.js"), "utf8")).toBe("module.exports = 42;\n");
    await expect(readFile(join(f.workspace, "node_modules/goal-npm-fixture/postinstall-ran"))).rejects.toThrow();
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
    await expect(readFile(join(prepared.directory, ".goal-npm-owner"))).rejects.toThrow();
  }, 30_000);

  npmTest("pins a private input snapshot and rejects tampering or workspace drift", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const pinned = await readFile(join(prepared.snapshotPath, "package-lock.json"), "utf8");
    await writeFile(join(f.workspace, "package-lock.json"), "{}");
    expect(await readFile(join(prepared.snapshotPath, "package-lock.json"), "utf8")).toBe(pinned);
    await expect(revalidateNpmOfflineInstall(prepared)).rejects.toThrow("manifests changed");
    await writeFile(join(f.workspace, "package-lock.json"), pinned);
    await writeFile(join(prepared.snapshotPath, "package-lock.json"), "{}");
    await expect(revalidateNpmOfflineInstall(prepared)).rejects.toThrow("private inputs changed");
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("prepares VM inputs without a Host Node/npm toolchain", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ workspace: f.workspace, privateRoot: f.privateRoot, vmOnly: true,
      fetch: async () => new Response(f.archive) });
    expect(prepared.argv).toEqual([]);
    const stage = await createNpmVmWorkspace(prepared);
    expect(stage.argv).toContain("/usr/bin/npm");
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("builds a separate protected VM workspace without executing or modifying source", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    expect(stage.workspace.startsWith(prepared.directory + "/")).toBe(true);
    expect(stage.protectedPaths).toEqual([".zapcode", "package.json", "package-lock.json"]);
    expect(stage.argv).toContain("--offline");
    expect(stage.argv).toContain("--ignore-scripts");
    expect(await readFile(join(stage.workspace, "package-lock.json"), "utf8")).toBe(await readFile(join(f.workspace, "package-lock.json"), "utf8"));
    await expect(readFile(join(f.workspace, "node_modules/goal-npm-fixture/index.js"))).rejects.toThrow();
    await expect(readFile(join(stage.workspace, "node_modules/goal-npm-fixture/index.js"))).rejects.toThrow();
    // Exercise the staged cache with the local toolchain; the real Guest and
    // its mount policy require a separate VM integration test.
    const run = spawnSync(f.nodeExecutable, [f.npmCliScript, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--logs-max=0",
      "--cache", join(stage.workspace, ".zapcode/cache"), "--userconfig", join(stage.workspace, ".zapcode/user.npmrc"),
      "--globalconfig", join(stage.workspace, ".zapcode/global.npmrc")], { cwd: stage.workspace, env: { HOME: f.root, PATH: "" }, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(await readFile(join(stage.workspace, "node_modules/goal-npm-fixture/index.js"), "utf8")).toBe("module.exports = 42;\n");
    await expect(readFile(join(stage.workspace, "node_modules/goal-npm-fixture/postinstall-ran"))).rejects.toThrow();
    await expect(readFile(join(f.workspace, "node_modules/goal-npm-fixture/index.js"))).rejects.toThrow();
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("rejects a symlink inserted into the private npm cache", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    await symlink(f.workspace, join(prepared.cachePath, "injected"));
    await expect(createNpmVmWorkspace(prepared)).rejects.toThrow("symlinks");
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("rejects cached tarball tampering before VM staging", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const hex = createHash("sha512").update(f.archive).digest("hex");
    const path = join(prepared.cachePath, "_cacache/content-v2/sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    await writeFile(path, "tampered");
    await expect(createNpmVmWorkspace(prepared)).rejects.toThrow("integrity mismatch");
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("cleans private preparation when the download is cancelled", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = prepareNpmOfflineInstall({ ...f, signal: controller.signal,
      fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        controller.abort();
      }) });
    await expect(pending).rejects.toThrow("cancelled");
    expect(await readdir(f.privateRoot)).toEqual([]);
    await expect(readFile(join(f.workspace, "node_modules/goal-npm-fixture/index.js"))).rejects.toThrow();
  }, 30_000);

  npmTest("requires a matching seal before importing and refuses an existing destination", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    await mkdir(join(stage.workspace, "node_modules"));
    await writeFile(join(stage.workspace, "node_modules/value"), "dependency");
    const caps = { withExclusiveWorkspace: async <T>(_workspace: string, action: () => Promise<T>) => action(),
      publishNoReplace: async (source: string, destination: string) => { await rename(source, destination); } };
    await expect(importNpmVmWorkspace(prepared, stage, undefined, "execution", caps)).rejects.toThrow("seal is unconfirmed");
    await mkdir(join(f.workspace, "node_modules"));
    await expect(importNpmVmWorkspace(prepared, stage, { state: "sealed", executionId: "execution" }, "execution", caps)).rejects.toThrow("already exists");
    expect(await readdir(join(f.workspace, "node_modules"))).toEqual([]);
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("retains durable intent when publication is interrupted and rolls back only matching output", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    await mkdir(join(stage.workspace, "node_modules"));
    await writeFile(join(stage.workspace, "node_modules/value"), "dependency");
    const caps = { withExclusiveWorkspace: async <T>(_workspace: string, action: () => Promise<T>) => action(),
      publishNoReplace: async (source: string, destination: string) => { await rename(source, destination); throw new Error("simulated crash after rename"); } };
    await expect(importNpmVmWorkspace(prepared, stage, { state: "sealed", executionId: "execution" }, "execution", caps)).rejects.toThrow("simulated crash");
    expect(await readFile(join(f.workspace, "node_modules/value"), "utf8")).toBe("dependency");
    await recoverNpmVmImport(prepared, caps);
    await expect(readFile(join(f.workspace, "node_modules/value"))).rejects.toThrow();
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("recovers durable intent after a real publishing process is killed", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    await mkdir(join(stage.workspace, "node_modules"));
    await writeFile(join(stage.workspace, "node_modules/value"), "dependency");
    const moduleUrl = new URL("../../goal/npm-installer.ts", import.meta.url).href;
    const script = `import { rename } from "node:fs/promises";
      import { importNpmVmWorkspace } from ${JSON.stringify(moduleUrl)};
      const { prepared, stage } = JSON.parse(process.env.ZAP_TEST_NPM_IMPORT);
      await importNpmVmWorkspace(prepared, stage, { state: "sealed", executionId: "execution" }, "execution", {
        withExclusiveWorkspace: async (_workspace, action) => action(),
        publishNoReplace: async (source, destination) => { await rename(source, destination); process.kill(process.pid, "SIGKILL"); }
      });`;
    const child = spawnSync(process.execPath, ["-e", script], { cwd: f.root,
      env: { ...process.env, ZAP_TEST_NPM_IMPORT: JSON.stringify({ prepared, stage }) }, encoding: "utf8" });
    expect(child.signal).toBe("SIGKILL");
    expect(await readFile(join(f.workspace, "node_modules/value"), "utf8")).toBe("dependency");
    const caps = { withExclusiveWorkspace: async <T>(_workspace: string, action: () => Promise<T>) => action(),
      publishNoReplace: async (source: string, destination: string) => { await rename(source, destination); } };
    await recoverNpmVmImport(prepared, caps);
    await expect(readFile(join(f.workspace, "node_modules/value"))).rejects.toThrow();
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("preserves a competing modification during interrupted import recovery", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    await mkdir(join(stage.workspace, "node_modules"));
    await writeFile(join(stage.workspace, "node_modules/value"), "dependency");
    const caps = { withExclusiveWorkspace: async <T>(_workspace: string, action: () => Promise<T>) => action(),
      publishNoReplace: async (source: string, destination: string) => { await rename(source, destination); throw new Error("interrupted"); } };
    await expect(importNpmVmWorkspace(prepared, stage, { state: "sealed", executionId: "execution" }, "execution", caps)).rejects.toThrow("interrupted");
    await writeFile(join(f.workspace, "node_modules/value"), "user change");
    await expect(recoverNpmVmImport(prepared, caps)).rejects.toThrow("changed");
    await expect(cleanupNpmOfflineInstall(prepared, f.privateRoot)).rejects.toThrow("explicit recovery");
    expect(await readFile(join(f.workspace, "node_modules/value"), "utf8")).toBe("user change");
    expect((await readdir(prepared.directory)).includes("copy-merge-pending.json")).toBe(true);
    // The test fixture is disposed after the assertion; real Host code must
    // retain the journal and workspace for explicit conflict reconciliation.
  }, 30_000);

  npmTest("never deletes a competing destination after a failed atomic publish", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    await mkdir(join(stage.workspace, "node_modules"));
    await writeFile(join(stage.workspace, "node_modules/value"), "dependency");
    const caps = { withExclusiveWorkspace: async <T>(_workspace: string, action: () => Promise<T>) => action(),
      publishNoReplace: async (_source: string, destination: string) => { await mkdir(destination); await writeFile(join(destination, "owner"), "other"); throw new Error("destination exists"); } };
    await expect(importNpmVmWorkspace(prepared, stage, { state: "sealed", executionId: "execution" }, "execution", caps)).rejects.toThrow("destination exists");
    await expect(recoverNpmVmImport(prepared, caps)).rejects.toThrow("changed");
    expect(await readFile(join(f.workspace, "node_modules/owner"), "utf8")).toBe("other");
  }, 30_000);

  npmTest("rejects dependency symlinks that escape the staged modules", async () => {
    const f = await fixture();
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    const stage = await createNpmVmWorkspace(prepared);
    await mkdir(join(stage.workspace, "node_modules"));
    await symlink("../../package.json", join(stage.workspace, "node_modules/escape"));
    const caps = { withExclusiveWorkspace: async <T>(_workspace: string, action: () => Promise<T>) => action(),
      publishNoReplace: async (source: string, destination: string) => { await rename(source, destination); } };
    await expect(importNpmVmWorkspace(prepared, stage, { state: "sealed", executionId: "execution" }, "execution", caps)).rejects.toThrow("Symlink escapes");
    await expect(readFile(join(f.workspace, "node_modules/escape"))).rejects.toThrow();
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
  }, 30_000);

  npmTest("rejects foreign URLs, redirects, oversized archives and invalid integrity", async () => {
    const f = await fixture();
    const writeLock = async () => writeFile(join(f.workspace, "package-lock.json"), JSON.stringify(f.lock));
    const entry = f.lock.packages["node_modules/goal-npm-fixture"];
    entry.resolved = "https://evil.example/package.tgz"; await writeLock();
    await expect(prepareNpmOfflineInstall(f)).rejects.toThrow("official npm registry");
    entry.resolved = "https://user:secret@registry.npmjs.org/goal-npm-fixture/-/goal-npm-fixture-1.0.0.tgz"; await writeLock();
    await expect(prepareNpmOfflineInstall(f)).rejects.toThrow("official npm registry");
    entry.resolved = "https://registry.npmjs.org/goal-npm-fixture/-/goal-npm-fixture-1.0.0.tgz"; await writeLock();
    await expect(prepareNpmOfflineInstall({ ...f,
      fetch: async () => new Response("", { status: 302, headers: { location: "https://evil.example/x" } }) })).rejects.toThrow("redirects");
    await expect(prepareNpmOfflineInstall({ ...f,
      maxTarballBytes: 2, fetch: async () => new Response(f.archive) })).rejects.toThrow("resource limit");
    await expect(prepareNpmOfflineInstall({ ...f,
      fetch: async () => new Response("tampered") })).rejects.toThrow("integrity mismatch");
  }, 30_000);

  npmTest("blocks project npmrc, linked inputs, workspace drift and unsafe cleanup", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, ".npmrc"), "//registry.npmjs.org/:_authToken=hidden");
    await expect(prepareNpmOfflineInstall(f)).rejects.toThrow(".npmrc");
    await rm(join(f.workspace, ".npmrc"));
    const prepared = await prepareNpmOfflineInstall({ ...f, fetch: async () => new Response(f.archive) });
    await expect(cleanupNpmOfflineInstall({ ...prepared, directory: f.workspace }, f.privateRoot)).rejects.toThrow("Invalid Host-owned");
    await writeFile(join(f.workspace, "package.json"), "{}");
    await expect(revalidateNpmOfflineInstall(prepared)).rejects.toThrow("changed before installation");
    await cleanupNpmOfflineInstall(prepared, f.privateRoot);
    await rm(join(f.workspace, "package-lock.json"));
    await symlink(join(f.root, "elsewhere"), join(f.workspace, "package-lock.json"));
    await expect(prepareNpmOfflineInstall(f)).rejects.toThrow();
  }, 30_000);
});
