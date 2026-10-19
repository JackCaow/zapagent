import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export interface ZapVmPackageInput {
  zapBinary: string
  zapVmBinary: string
  imageTool: string
  imageBundle: string
  imagePublicKey: string
  outputDirectory: string
  architecture: "amd64" | "arm64"
  zapVmRevision: string
}

export type InstallImageBundle = (input: {
  imageTool: string
  bundle: string
  publicKey: string
  imageRoot: string
  architecture: ZapVmPackageInput["architecture"]
  smokeBinary: string
}) => void

export function assembleZapVmRuntimePackage(
  input: ZapVmPackageInput,
  installImageBundle: InstallImageBundle = runImageBundleInstall,
): void {
  const sources = [input.zapBinary, input.zapVmBinary, input.imageTool, input.imageBundle, input.imagePublicKey]
  for (const source of sources) assertRegularFile(source)
  const output = resolve(input.outputDirectory)
  try {
    lstatSync(output)
    throw new Error(`runtime package output already exists: ${output}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const staging = `${output}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    const runtimeRoot = join(staging, "zapvm-runtime")
    const runtimeBin = join(runtimeRoot, "bin")
    const imageRoot = join(runtimeRoot, "images")
    mkdirSync(runtimeBin, { recursive: true, mode: 0o700 })
    mkdirSync(imageRoot, { recursive: true, mode: 0o700 })
    const zapName = process.platform === "win32" || input.zapBinary.toLowerCase().endsWith(".exe") ? "zap.exe" : "zap"
    const zapVmName = process.platform === "win32" || input.zapVmBinary.toLowerCase().endsWith(".exe") ? "zapvm.exe" : "zapvm"
    copyFileSync(input.zapBinary, join(staging, zapName))
    copyFileSync(input.zapVmBinary, join(runtimeBin, zapVmName))
    copyFileSync(input.imagePublicKey, join(runtimeRoot, "image-public.pem"))
    // Preserve the root and independent VM module license boundaries in archives.
    // Keep notices with the directory the installer preserves, not discarded staging files.
    const licenseRoot = join(runtimeRoot, "licenses")
    mkdirSync(licenseRoot)
    for (const [source, name] of [
      ["../LICENSE", "LICENSE"],
      ["../THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["../zapvm/LICENSE", "zapvm-LICENSE"],
      ["../zapvm/NOTICE", "zapvm-NOTICE"],
      ["../zapvm/THIRD_PARTY_NOTICES.md", "zapvm-THIRD_PARTY_NOTICES.md"],
    ]) {
      copyFileSync(new URL(source, import.meta.url), join(licenseRoot, name))
    }
    if (process.platform !== "win32") {
      chmodSync(join(staging, zapName), 0o755)
      chmodSync(join(runtimeBin, zapVmName), 0o755)
    }
    installImageBundle({
      imageTool: input.imageTool,
      bundle: input.imageBundle,
      publicKey: input.imagePublicKey,
      imageRoot,
      architecture: input.architecture,
      smokeBinary: resolve(runtimeBin, zapVmName),
    })
    assertRegularFile(join(imageRoot, "active.json"))
    rejectSymlinks(staging)
    writeFileSync(join(staging, "runtime-package.json"), `${JSON.stringify({
      schemaVersion: 1,
      architecture: input.architecture,
      zapVmRevision: input.zapVmRevision,
      imageBundle: basename(input.imageBundle),
    }, null, 2)}\n`, { mode: 0o600 })
    mkdirSync(dirname(output), { recursive: true })
    renameSync(staging, output)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function runImageBundleInstall(input: Parameters<InstallImageBundle>[0]): void {
  const result = spawnSync(input.imageTool, [
    "install-bundle",
    "--bundle", input.bundle,
    "--public-key", input.publicKey,
    "--root", input.imageRoot,
    "--arch", input.architecture,
    "--smoke-binary", input.smokeBinary,
  ], { stdio: "inherit", shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`zapvm-image install-bundle exited with status ${result.status}`)
}

function assertRegularFile(path: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`expected a regular non-symlink file: ${path}`)
}

function rejectSymlinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error(`runtime package contains a symlink: ${path}`)
    if (info.isDirectory()) rejectSymlinks(path)
  }
}

function parseArgs(argv: string[]): ZapVmPackageInput {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument near ${key ?? "<end>"}`)
    values.set(key.slice(2), value)
  }
  const required = (name: string): string => {
    const value = values.get(name)
    if (!value) throw new Error(`missing --${name}`)
    return value
  }
  const architecture = required("arch")
  if (architecture !== "amd64" && architecture !== "arm64") throw new Error(`unsupported architecture: ${architecture}`)
  return {
    zapBinary: required("zap"),
    zapVmBinary: required("zapvm"),
    imageTool: required("image-tool"),
    imageBundle: required("bundle"),
    imagePublicKey: required("public-key"),
    outputDirectory: required("output"),
    architecture,
    zapVmRevision: required("zapvm-revision"),
  }
}

if (import.meta.main) {
  try {
    assembleZapVmRuntimePackage(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
