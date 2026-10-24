import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupVerificationDirectory, consumerRuntimeEnvironment, npmCommand, verificationEnvironment } from "../scripts/npm-consumer-process.js";

declare const Bun: { which(command: string): string | null };

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`${command[0]} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

it("keeps npm local and Bun global installs inside verification despite inherited settings", () => {
  const work = mkdtempSync(join(tmpdir(), "zap-consumer-isolation-"));
  try {
    const external = join(work, "external"), oldHome = join(work, "user-home");
    const externalBin = join(external, "bin"), externalGlobal = join(external, "global");
    mkdirSync(externalBin, { recursive: true });
    mkdirSync(oldHome);
    const marker = join(externalBin, "zap"); writeFileSync(marker, "existing user command\n");
    writeFileSync(join(oldHome, ".bunfig.toml"), `[install]\nglobalBinDir = ${JSON.stringify(externalBin)}\nglobalDir = ${JSON.stringify(externalGlobal)}\n`);
    const inherited = { ...process.env, HOME: oldHome, USERPROFILE: oldHome,
      npm_config_global: "true", NPM_CONFIG_PREFIX: external,
      BUN_INSTALL_BIN: externalBin, BUN_INSTALL_GLOBAL_DIR: externalGlobal };
    const evidence = join(work, "evidence"); mkdirSync(evidence);
    const env = verificationEnvironment(evidence, inherited);
    const source = join(work, "source"); mkdirSync(source);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "zap-isolation-fixture", version: "1.0.0", bin: { zap: "cli.js" } }));
    writeFileSync(join(source, "cli.js"), "#!/usr/bin/env bun\nconsole.log('fixture');\n");
    const artifact = join(work, "fixture.tgz");
    run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", artifact], source, env);
    for (const manager of ["npm", "bun"] as const) {
      const location = join(evidence, manager); mkdirSync(location);
      writeFileSync(join(location, "package.json"), '{"private":true}\n');
      const prefix = join(location, "prefix"), runtime = consumerRuntimeEnvironment(location, join(evidence, `${manager}-cache`), {});
      const isolated = { ...env, ...runtime };
      let installed: string;
      if (manager === "npm") {
        const npmPath = Bun.which("npm"), node = Bun.which("node");
        if (!npmPath || !node) throw new Error("npm and Node required");
        run([...npmCommand(npmPath, node), "install", artifact, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", runtime.BUN_INSTALL_CACHE_DIR!], location, isolated);
        installed = join(location, "node_modules", "zap-isolation-fixture");
      } else {
        const global = runtime.BUN_INSTALL_GLOBAL_DIR!; mkdirSync(global, { recursive: true });
        writeFileSync(join(global, "package.json"), '{"private":true}\n');
        run([process.execPath, "add", "--global", artifact, "--ignore-scripts", "--no-progress"], location, isolated);
        installed = join(global, "node_modules", "zap-isolation-fixture");
        expect(readdirSync(join(prefix, "bin")).length).toBeGreaterThan(0);
      }
      expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).name).toBe("zap-isolation-fixture");
    }
    expect(readFileSync(marker, "utf8")).toBe("existing user command\n");
    expect(readdirSync(externalBin)).toEqual(["zap"]);
    expect(existsSync(externalGlobal)).toBe(false);
    expect(existsSync(join(external, "lib"))).toBe(false);
    expect(existsSync(join(external, "node_modules"))).toBe(false);
  } finally { rmSync(work, { recursive: true, force: true }); }
}, 30_000);

(process.platform === "win32" ? it.skip : it)("executes POSIX npm shims through their own interpreter", () => {
  const work = mkdtempSync(join(tmpdir(), "zap-npm-shim-"));
  try {
    const shim = join(work, "npm");
    writeFileSync(shim, '#!/bin/sh\nprintf "npm-shim:%s\\n" "$1"\n', { mode: 0o755 });
    const env = verificationEnvironment(work);
    expect(run([...npmCommand(shim, process.execPath), "--version"], work, env)).toBe("npm-shim:--version\n");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

it("records Windows cleanup locks without changing successful acceptance results", async () => {
  const locked = Object.assign(new Error("held by process"), { code: "EBUSY" });
  const remove = async () => { throw locked; };
  expect(await cleanupVerificationDirectory("verified-install", "win32", remove))
    .toEqual({ path: "verified-install", code: "EBUSY" });
  await expect(cleanupVerificationDirectory("verified-install", "linux", remove)).rejects.toBe(locked);
});

it("does not hide unexpected cleanup errors on Windows", async () => {
  const failure = Object.assign(new Error("disk failed"), { code: "EIO" });
  await expect(cleanupVerificationDirectory("verified-install", "win32", async () => { throw failure; })).rejects.toBe(failure);
  expect(await cleanupVerificationDirectory("verified-install", "win32", async () => {})).toBeUndefined();
});
