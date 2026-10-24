import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Ink consumers must travel together so their hooks resolve the same Ink instance.
export const bundledUiPackages = ["ink", "ink-spinner", "ink-text-input", "react"] as const;
const repository = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[], cwd: string): string {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Package command failed: ${args[0]}\n${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export function packNpmPackage(options: { root?: string; destination: string; dryRun?: boolean }): string {
  const root = resolve(options.root ?? repository), destination = resolve(options.destination);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patch = manifest.patchedDependencies?.["ink@7.1.1"];
  if (manifest.name !== "zapagent" || manifest.private !== true || manifest.dependencies?.ink !== "7.1.1" || typeof patch !== "string") {
    throw new Error("Expected the private zapagent source workspace with its pinned Ink patch");
  }
  const work = mkdtempSync(join(tmpdir(), "zapagent-npm-pack-"));
  try {
    // Snapshot the existing files allowlist. No checkout files or manifest are rewritten.
    const source = join(work, "source.tgz");
    run([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", source], root);
    run(["tar", "-xzf", source, "-C", work], root);
    const stage = join(work, "package");
    for (const name of bundledUiPackages) {
      const installed = join(root, "node_modules", name);
      const dependency = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
      if (dependency.name !== name || (name === "ink" && dependency.version !== "7.1.1")) throw new Error(`Unexpected installed ${name}`);
      if (!readdirSync(installed).some(file => /^licen[sc]e(?:\.|$)/i.test(file))) throw new Error(`Missing ${name} license`);
      const tarball = join(work, `${name}.tgz`), unpack = join(work, name);
      // Apply each upstream package's files allowlist; do not copy caches or local extras.
      run([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", tarball], installed);
      mkdirSync(unpack);
      run(["tar", "-xzf", tarball, "-C", unpack], root);
      mkdirSync(join(stage, "node_modules"), { recursive: true });
      renameSync(join(unpack, "package"), join(stage, "node_modules", name));
      manifest.dependencies[name] = dependency.version;
    }
    // A stale/unpatched development install must never produce a release candidate.
    run(["git", "apply", "--reverse", "--check", resolve(root, patch)], join(stage, "node_modules", "ink"));
    delete manifest.private;
    delete manifest.patchedDependencies;
    delete manifest.scripts;
    manifest.bundledDependencies = [...bundledUiPackages];
    manifest.bin = { zap: "npm/cli.cjs" };
    manifest.scripts = { postinstall: "node npm/install.cjs" };
    manifest.engines = { node: ">=22" };
    writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    // Let Bun collect the complete installed dependency closure, including nested
    // versions. A partial node_modules tree makes npm skip missing bundled deps.
    renameSync(join(stage, "node_modules"), join(work, "checked-roots"));
    symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "junction");
    const closure = join(work, "closure.tgz");
    run([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", closure], stage);
    const expanded = join(work, "expanded"); mkdirSync(expanded);
    run(["tar", "-xzf", closure, "-C", expanded], root);
    const final = join(expanded, "package");
    const clean = (directory: string) => {
      for (const file of readdirSync(directory)) {
        const path = join(directory, file), stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Unexpected bundled filesystem entry");
        if (file.startsWith(".bun-tag-")) rmSync(path);
        else if (stat.isDirectory()) clean(path);
      }
    };
    clean(join(final, "node_modules"));
    run(["git", "apply", "--reverse", "--check", resolve(root, patch)], join(final, "node_modules", "ink"));
    const inventory: Array<{ name: string; version: string; license: string; path: string;
      notices: Array<{ path: string; sha256: string }> }> = [];
    const collect = (directory: string) => {
      const metadata = join(directory, "package.json");
      if (existsSync(metadata)) {
        const dependency = JSON.parse(readFileSync(metadata, "utf8"));
        if (typeof dependency.name === "string" && typeof dependency.version === "string") {
          let licenses = readdirSync(directory).filter(file => /^licen[sc]e(?:[.-]|$)/i.test(file));
          if (!licenses.length && dependency.name === "yoga-layout" && dependency.version === "3.2.1") {
            // The upstream 3.2.1 npm tarball omitted its root MIT license.
            copyFileSync(join(root, "third_party", "yoga-layout", "LICENSE"), join(directory, "LICENSE"));
            licenses = ["LICENSE"];
          }
          if (!licenses.length || typeof dependency.license !== "string") throw new Error(`Missing bundled license: ${dependency.name}@${dependency.version}`);
          inventory.push({ name: dependency.name, version: dependency.version, license: dependency.license,
            path: relative(final, directory).split(sep).join("/"), notices: licenses.sort().map(file => {
              const path = join(directory, file), bytes = readFileSync(path);
              if (!bytes.length) throw new Error(`Empty bundled license: ${dependency.name}`);
              return { path: relative(final, path).split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex") };
            }) });
        }
      }
      for (const file of readdirSync(directory)) if (lstatSync(join(directory, file)).isDirectory()) collect(join(directory, file));
    };
    collect(join(final, "node_modules"));
    writeFileSync(join(final, "bundled-dependencies.json"), JSON.stringify(inventory, null, 2) + "\n");
    manifest.files.push("bundled-dependencies.json");
    writeFileSync(join(final, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (options.dryRun) return run([process.execPath, "pm", "pack", "--ignore-scripts", "--dry-run"], final);
    const filename = `${manifest.name}-${manifest.version}.tgz`;
    run([process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", join(work, filename)], final);
    mkdirSync(destination, { recursive: true });
    const target = join(destination, filename);
    if (existsSync(target)) throw new Error(`Candidate already exists; choose a fresh destination: ${target}`);
    copyFileSync(join(work, filename), target, constants.COPYFILE_EXCL);
    return target;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let destination = join(repository, "dist", "npm"), dryRun = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--dry-run") dryRun = true;
      else if (args[i] === "--destination" && args[i + 1]) destination = resolve(args[++i]!);
      else throw new Error("Usage: bun run pack:npm [--destination directory] [--dry-run]");
    }
    console.log(packNpmPackage({ destination, dryRun }));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
