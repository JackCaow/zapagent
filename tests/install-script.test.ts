import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = process.cwd()
const installScript = join(root, "install.sh")

describe("install.sh", () => {
  it("is valid POSIX shell syntax", () => {
    const proc = spawnSync("sh", ["-n", installScript])
    expect(proc.status).toBe(0)
  })

  it("fails clearly when the latest release tag cannot be parsed", () => {
    const script = readFileSync(installScript, "utf-8")
    expect(script).toContain('if [ -z "$TAG" ]; then')
    expect(script).toContain("Could not determine latest release tag")
  })

  it("creates the install directory before moving the binary", () => {
    const script = readFileSync(installScript, "utf-8")
    expect(script).toContain('if [ ! -d "$INSTALL_DIR" ]; then')
    expect(script).toContain('mkdir -p "$INSTALL_DIR"')
  })

  it("installs Windows builds into a user-owned bin directory without sudo", () => {
    const script = readFileSync(installScript, "utf-8")
    expect(script).toContain('FILE="zap-windows-x64.exe"')
    expect(script).toContain('INSTALL_DIR="${ZAP_INSTALL_DIR:-$HOME_DIR/bin}"')
    expect(script).toContain("NEEDS_SUDO=0")
  })

  for (const [arch, asset] of [["x86_64", "zap-linux-x64"], ["aarch64", "zap-linux-arm64"]]) it(`installs a mocked Linux ${arch} release into ZAP_INSTALL_DIR without sudo`, () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-install-test-"))
    const fakeBin = join(tmp, "fake-bin")
    const installDir = join(tmp, "install", "bin")
    try {
      mkdirSync(fakeBin, { recursive: true })
      writeExecutable(join(fakeBin, "uname"), [
        "#!/bin/sh",
        `if [ "$1" = "-s" ]; then echo Linux; else echo ${arch}; fi`,
      ].join("\n"))
      writeExecutable(join(fakeBin, "sudo"), [
        "#!/bin/sh",
        "echo unexpected sudo >&2",
        "exit 99",
      ].join("\n"))
      writeFakeCurl(join(fakeBin, "curl"), "mock zap binary\n")
      writeFileSync(join(fakeBin, "curl"), readFileSync(join(fakeBin, "curl"), "utf8").replaceAll("zap-linux-x64", asset))

      const proc = spawnSync("sh", [installScript], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          ZAP_INSTALL_DIR: installDir,
        },
        encoding: "utf-8",
      })

      expect(proc.status).toBe(0)
      expect(readFileSync(join(installDir, "zap"), "utf-8")).toBe("mock zap binary\n")
      expect(proc.stdout).toContain("Downloading Zap v9.9.9")
      expect(proc.stderr).not.toContain("unexpected sudo")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("fails before install when the release checksum does not match", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-install-test-"))
    const fakeBin = join(tmp, "fake-bin")
    const installDir = join(tmp, "install", "bin")
    try {
      mkdirSync(fakeBin, { recursive: true })
      writeExecutable(join(fakeBin, "uname"), [
        "#!/bin/sh",
        'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi',
      ].join("\n"))
      writeFakeCurl(join(fakeBin, "curl"), "mock zap binary\n", "0".repeat(64))

      const proc = spawnSync("sh", [installScript], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          ZAP_INSTALL_DIR: installDir,
        },
        encoding: "utf-8",
      })

      expect(proc.status).toBe(1)
      expect(proc.stdout).toContain("Checksum verification failed for zap-linux-x64")
      expect(proc.stdout).not.toContain("Installing to")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("installs only the CLI and leaves an existing zapVM runtime untouched", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-runtime-skip-test-"))
    const fakeBin = join(tmp, "fake-bin")
    const installDir = join(tmp, "install", "bin")
    const dataDir = join(tmp, "data")
    const runtimeFetched = join(tmp, "runtime-fetched")
    const daemonTouched = join(tmp, "daemon-touched")
    try {
      mkdirSync(fakeBin, { recursive: true })
      writeExecutable(join(fakeBin, "uname"), [
        "#!/bin/sh",
        'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi',
      ].join("\n"))
      // An older release still lists a runtime archive; it must not be fetched.
      writeFakeCurlWithRuntimeAssets(join(fakeBin, "curl"), "cli zap binary\n", runtimeFetched)
      mkdirSync(join(dataDir, "runtime", "zapvm", "bin"), { recursive: true })
      writeFileSync(join(dataDir, "runtime", "zapvm", "image-public.pem"), "existing key\n")
      writeExecutable(join(dataDir, "runtime", "zapvm", "bin", "zapvm"), [
        "#!/bin/sh",
        `: > '${daemonTouched.replace(/'/g, "'\\''")}'`,
        "exit 0",
      ].join("\n"))

      const proc = spawnSync("sh", [installScript], {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ZAP_INSTALL_DIR: installDir, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(proc.status).toBe(0)
      expect(readFileSync(join(installDir, "zap"), "utf-8")).toBe("cli zap binary\n")
      expect(existsSync(runtimeFetched)).toBe(false)
      expect(existsSync(daemonTouched)).toBe(false)
      expect(readFileSync(join(dataDir, "runtime", "zapvm", "image-public.pem"), "utf-8")).toBe("existing key\n")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, `${content}\n`)
  chmodSync(path, 0o755)
}

function writeFakeCurl(path: string, binary: string, checksumOverride?: string): void {
  const checksum = checksumOverride ?? createHash("sha256").update(binary).digest("hex")
  writeExecutable(path, [
    "#!/bin/sh",
    'out=""',
    'url=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi',
    '  if [ "$1" = "-H" ]; then shift 2; continue; fi',
    '  if [ "${1#-}" != "$1" ]; then shift; continue; fi',
    '  url="$1"',
    "  shift",
    "done",
    'if [ -z "$out" ]; then',
    '  printf \'{"tag_name":"v9.9.9","assets":[{"url":"https://api.github.com/repos/test/repo/releases/assets/1","name":"zap-linux-x64"},{"url":"https://api.github.com/repos/test/repo/releases/assets/2","name":"zap-linux-x64.sha256"}]}\\n\'',
    'elif echo "$url" | grep -q "/assets/2$"; then',
    `  printf '${checksum}  zap-linux-x64\\n' > "$out"`,
    'elif echo "$url" | grep -q "/assets/1$"; then',
    `  printf '${binary.replace(/'/g, "'\\''")}' > "$out"`,
    "else",
    "  exit 22",
    "fi",
  ].join("\n"))
}

function writeFakeCurlWithRuntimeAssets(path: string, binary: string, runtimeMarker: string): void {
  const checksum = createHash("sha256").update(binary).digest("hex")
  writeExecutable(path, [
    "#!/bin/sh",
    'out=""',
    'url=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift 2; continue; fi',
    '  if [ "$1" = "-H" ]; then shift 2; continue; fi',
    '  if [ "${1#-}" != "$1" ]; then shift; continue; fi',
    '  url="$1"',
    "  shift",
    "done",
    'if [ -z "$out" ]; then',
    '  printf \'{"tag_name":"v9.9.9","assets":[{"url":"https://api.github.com/repos/test/repo/releases/assets/1","name":"zap-linux-x64"},{"url":"https://api.github.com/repos/test/repo/releases/assets/2","name":"zap-linux-x64.sha256"},{"url":"https://api.github.com/repos/test/repo/releases/assets/3","name":"zap-linux-x64.runtime.tar.gz"},{"url":"https://api.github.com/repos/test/repo/releases/assets/4","name":"zap-linux-x64.runtime.tar.gz.sha256"}]}\\n\'',
    'elif echo "$url" | grep -q "/assets/2$"; then',
    `  printf '${checksum}  zap-linux-x64\\n' > "$out"`,
    'elif echo "$url" | grep -q "/assets/1$"; then',
    `  printf '${binary.replace(/'/g, "'\\''")}' > "$out"`,
    "else",
    `  : > '${runtimeMarker.replace(/'/g, "'\\''")}'`,
    "  exit 22",
    "fi",
  ].join("\n"))
}
