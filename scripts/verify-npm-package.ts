import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledUiPackages } from "./pack-npm.js";
import { consumerRuntimeEnvironment, npmCommand, verificationEnvironment } from "./npm-consumer-process.js";

declare const Bun: { which(command: string): string | null };

const repository = fileURLToPath(new URL("..", import.meta.url));
const artifact = resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.argv.length !== 3 || !artifact.endsWith(".tgz") || !existsSync(artifact)) {
  throw new Error("Usage: bun run verify:npm /absolute/path/zapagent-version.tgz");
}
const evidence = mkdtempSync(join(tmpdir(), "zapagent-npm-verification-"));
console.log(`Verification evidence: ${evidence}`);
const env = verificationEnvironment(evidence);
function run(label: string, command: string[], cwd: string, extra: Record<string, string> = {}, allowedStatuses = [0]): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env: { ...env, ...extra },
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(evidence, `${label}.log`), result.stdout + "\n" + result.stderr);
  if (result.error || result.status === null || !allowedStatuses.includes(result.status)) throw new Error(`${label} failed (${result.status}); inspect ${evidence}`);
  return result.stdout;
}
const npmPath = Bun.which("npm"), node = Bun.which("node");
if (!npmPath || !node) throw new Error("npm and Node are required for independent npm consumer verification");
const npm = npmCommand(npmPath, node);
const extracted = join(evidence, "extracted"); mkdirSync(extracted);
// Git Bash may put GNU tar first in PATH; it cannot handle native drive paths.
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
run("extract", [tar, "-xzf", basename(artifact), "-C", extracted], dirname(artifact));
const snapshot = join(extracted, "package");
const pkg = JSON.parse(readFileSync(join(snapshot, "package.json"), "utf8"));
if (pkg.name !== "zapagent" || pkg.private || pkg.patchedDependencies || pkg.scripts
  || JSON.stringify(pkg.bin) !== JSON.stringify({ zap: "src/index.tsx" })
  || JSON.stringify(pkg.bundledDependencies) !== JSON.stringify(bundledUiPackages)) throw new Error("Unexpected published manifest");
run("patch-check", ["git", "apply", "--reverse", "--check", join(repository, "patches", "ink@7.1.1.patch")], join(snapshot, "node_modules", "ink"));
const hashes = Object.fromEntries(["cursor-helpers.js", "ink.js", "log-update.js"].map(file => [file,
  createHash("sha256").update(readFileSync(join(snapshot, "node_modules", "ink", "build", file))).digest("hex")]));
const cases: Array<Record<string, unknown>> = [];
const summary = { artifactSha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
  name: pkg.name, version: pkg.version, platform: process.platform, arch: process.arch, hashes, cases,
  status: "running", error: undefined as string | undefined };
try {
  for (const manager of ["npm", "bun"] as const) for (const global of [false, true]) {
    const label = `${manager}-${global ? "global" : "local"}`, location = join(evidence, label);
    mkdirSync(location);
    writeFileSync(join(location, "package.json"), '{"private":true}\n');
    const prefix = join(location, "prefix"), cache = join(evidence, `${manager}-cache`);
    const runtime = consumerRuntimeEnvironment(location, cache, hashes);
    let installed: string, audit: Record<string, number> | undefined;
    if (manager === "npm") {
      run(label + "-install", [...npm, "install", ...(global ? ["--global", "--prefix", prefix] : []), artifact,
        "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--cache", cache, "--registry=https://registry.npmjs.org"], location, runtime);
      installed = join(global ? process.platform === "win32" ? prefix : join(prefix, "lib") : location, "node_modules", "zapagent");
      if (!global) {
        const report = JSON.parse(run(label + "-audit", [...npm, "audit", "--omit=dev", "--json", "--cache", cache,
          "--registry=https://registry.npmjs.org"], location, runtime, [0, 1]));
        audit = report.metadata?.vulnerabilities;
        if (!audit || ["info", "low", "moderate", "high", "critical"].some(level => !Number.isInteger(audit![level]) || audit![level]! < 0)) {
          throw new Error("npm consumer audit evidence is unavailable or malformed");
        }
        if (audit.high! > 0 || audit.critical! > 0) throw new Error("npm consumer has high/critical advisories");
      }
    } else {
      if (global) {
        const home = join(prefix, "install", "global"); mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "package.json"), '{"private":true}\n');
      }
      run(label + "-install", [process.execPath, "add", ...(global ? ["--global"] : []), artifact, "--ignore-scripts", "--no-progress"], location, runtime);
      installed = join(global ? join(prefix, "install", "global") : location, "node_modules", "zapagent");
    }
    // Put the probe in the installed package, so globals need no synthetic links.
    const smoke = join(installed, "npm-consumer-smoke.mjs");
    writeFileSync(smoke, readFileSync(join(repository, "scripts", "npm-consumer-smoke.mjs")));
    run(label + "-smoke", [process.execPath, "--no-install", smoke], location, runtime);
    const bin = global ? join(prefix, "bin", "zap") : join(location, "node_modules", ".bin", "zap");
    const entry = process.platform === "win32" ? [process.execPath, join(installed, "src", "index.tsx")] : [bin];
    const version = run(label + "-version", [...entry, "--version"], location, runtime).trim();
    if (version !== `zapAgent v${pkg.version}`) throw new Error(`${label} returned unexpected CLI version`);
    const help = run(label + "-help", [...entry, "--help-headless"], location, runtime);
    if (!help.includes("--permission-mode") || !help.includes("zap -p <prompt>") || /\bzapcode\b/.test(help)) {
      throw new Error(`${label} returned invalid CLI help`);
    }
    cases.push({ manager, global, status: "passed", version, binShimVerified: process.platform !== "win32", ...(audit ? { audit } : {}) });
    // Reclaim only this successful isolated installation; keep logs and failed cases.
    rmSync(location, { recursive: true, force: true });
  }
  for (const manager of ["npm", "bun"]) rmSync(join(evidence, `${manager}-cache`), { recursive: true, force: true });
  rmSync(extracted, { recursive: true, force: true });
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally { writeFileSync(join(evidence, "result.json"), JSON.stringify(summary, null, 2) + "\n"); }
console.log(`All four isolated installs passed; ${join(evidence, "result.json")}`);
