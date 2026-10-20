import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assembleZapVmRuntimePackage } from "../scripts/package-zapvm-runtime.js"

describe("zapVM runtime release package", () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it("assembles the discovery contract from verified regular inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-runtime-package-"))
    cleanup.push(root)
    const source = join(root, "source")
    mkdirSync(source)
    const files = Object.fromEntries(["zap", "zapvm", "image-tool", "bundle", "public-key"].map((name) => {
      const path = join(source, name)
      writeFileSync(path, name)
      return [name, path]
    }))
    const output = join(root, "output")
    assembleZapVmRuntimePackage({
      zapBinary: files.zap,
      zapVmBinary: files.zapvm,
      imageTool: files["image-tool"],
      imageBundle: files.bundle,
      imagePublicKey: files["public-key"],
      outputDirectory: output,
      architecture: "arm64",
      zapVmRevision: "abc123",
    }, ({ imageRoot, smokeBinary }) => {
      // Validate the runtime that will ship, not a stale binary beside image-tool.
      expect(smokeBinary).toBe(join(imageRoot, "..", "bin", "zapvm"))
      expect(readFileSync(smokeBinary, "utf8")).toBe("zapvm")
      mkdirSync(join(imageRoot, "signed-v1"))
      writeFileSync(join(imageRoot, "signed-v1", "manifest.json"), "{}\n")
      writeFileSync(join(imageRoot, "active.json"), "{}\n")
    })

    expect(existsSync(join(output, "zapvm-runtime", "bin", "zapvm"))).toBe(true)
    expect(readFileSync(join(output, "zapvm-runtime", "image-public.pem"), "utf8")).toBe("public-key")
    expect(readFileSync(join(output, "zapvm-runtime", "licenses", "LICENSE"), "utf8")).toContain("MIT License")
    expect(readFileSync(join(output, "zapvm-runtime", "licenses", "zapvm-LICENSE"), "utf8")).toContain("Apache License")
    expect(readFileSync(join(output, "zapvm-runtime", "licenses", "zapvm-NOTICE"), "utf8")).toContain("zapVM")
    expect(readFileSync(join(output, "zapvm-runtime", "licenses", "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("Modified Ink")
    expect(JSON.parse(readFileSync(join(output, "runtime-package.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      architecture: "arm64",
      zapVmRevision: "abc123",
    })
  })

  it("rejects symlinked release inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-runtime-package-link-"))
    cleanup.push(root)
    const real = join(root, "real")
    const linked = join(root, "linked")
    writeFileSync(real, "binary")
    symlinkSync(real, linked)
    expect(() => assembleZapVmRuntimePackage({
      zapBinary: linked,
      zapVmBinary: real,
      imageTool: real,
      imageBundle: real,
      imagePublicKey: real,
      outputDirectory: join(root, "output"),
      architecture: "amd64",
      zapVmRevision: "abc123",
    }, () => {})).toThrow("regular non-symlink")
  })

  it("does not publish a package when image boot validation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "zap-runtime-package-failed-"))
    cleanup.push(root)
    const source = join(root, "source")
    writeFileSync(source, "fixture")
    const output = join(root, "output")
    expect(() => assembleZapVmRuntimePackage({
      zapBinary: source, zapVmBinary: source, imageTool: source,
      imageBundle: source, imagePublicKey: source, outputDirectory: output,
      architecture: "arm64", zapVmRevision: "test",
    }, () => { throw new Error("candidate boot validation failed") })).toThrow("boot validation failed")
    expect(existsSync(output)).toBe(false)
  })
})
