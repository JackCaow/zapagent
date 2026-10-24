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

  it("installs a verified runtime archive into the Zap data directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-runtime-install-test-"))
    const fakeBin = join(tmp, "fake-bin")
    const installDir = join(tmp, "install", "bin")
    const dataDir = join(tmp, "data")
    const packageRoot = join(tmp, "package")
    const archive = join(tmp, "zap-linux-x64.runtime.tar.gz")
    const daemonStopped = join(tmp, "daemon-stopped")
    try {
      mkdirSync(join(packageRoot, "zapvm-runtime", "bin"), { recursive: true })
      mkdirSync(join(packageRoot, "zapvm-runtime", "images"), { recursive: true })
      writeFileSync(join(packageRoot, "zap"), "runtime zap binary\n")
      writeFileSync(join(packageRoot, "zapvm-runtime", "bin", "zapvm"), "zapvm host\n")
      writeFileSync(join(packageRoot, "zapvm-runtime", "image-public.pem"), "trusted public key\n")
      writeFileSync(join(packageRoot, "zapvm-runtime", "images", "active.json"), "{}\n")
      expect(spawnSync("tar", ["-czf", archive, "-C", packageRoot, "."]).status).toBe(0)

      mkdirSync(fakeBin, { recursive: true })
      writeExecutable(join(fakeBin, "uname"), [
        "#!/bin/sh",
        'if [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi',
      ].join("\n"))
      writeFakeRuntimeCurl(join(fakeBin, "curl"), archive)
      mkdirSync(join(dataDir, "runtime", "zapvm", "bin"), { recursive: true })
      writeExecutable(join(dataDir, "runtime", "zapvm", "bin", "zapvm"), [
        "#!/bin/sh",
        `marker='${daemonStopped.replace(/'/g, "'\\''")}'`,
        'if [ "$1 $2" = "daemon status" ]; then [ ! -f "$marker" ]; exit $?; fi',
        'if [ "$1 $2" = "daemon stop" ]; then : > "$marker"; exit 1; fi',
        "exit 2",
      ].join("\n"))

      const proc = spawnSync("sh", [installScript], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          ZAP_INSTALL_DIR: installDir,
          ZAPCODE_DATA_DIR: dataDir,
        },
        encoding: "utf-8",
      })

      expect(proc.status).toBe(0)
      expect(proc.stdout).toContain("Stopping the existing zapVM daemon")
      expect(existsSync(daemonStopped)).toBe(true)
      expect(readFileSync(join(installDir, "zap"), "utf-8")).toBe("runtime zap binary\n")
      expect(readFileSync(join(dataDir, "runtime", "zapvm", "image-public.pem"), "utf-8"))
        .toBe("trusted public key\n")
      expect(existsSync(join(dataDir, "runtime", "zapvm", "images", "active.json"))).toBe(true)
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

function writeFakeRuntimeCurl(path: string, archive: string): void {
  const archiveChecksum = createHash("sha256").update(readFileSync(archive)).digest("hex")
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
    'elif echo "$url" | grep -q "/assets/4$"; then',
    `  printf '${archiveChecksum}  zap-linux-x64.runtime.tar.gz\\n' > "$out"`,
    'elif echo "$url" | grep -q "/assets/3$"; then',
    `  cp '${archive.replace(/'/g, "'\\''")}' "$out"`,
    "else",
    "  exit 22",
    "fi",
  ].join("\n"))
}
