import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BUILTIN_COMMANDS } from "../src/ui/slash-palette.js"
import { bundledUiPackages, packNpmPackage } from "../scripts/pack-npm.js"

const root = process.cwd()

describe("package metadata", () => {
  it("ships root license notices and documents the separate VM license", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))
    expect(pkg.license).toBe("ISC")
    expect(pkg.files).toContain("LICENSE")
    expect(pkg.files).toContain("THIRD_PARTY_NOTICES.md")
    expect(readFileSync(join(root, "LICENSE"), "utf-8")).toContain("zapvm/LICENSE")
    for (const file of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) {
      expect(readFileSync(join(root, file), "utf-8").length).toBeGreaterThan(100)
    }
    expect(readFileSync(join(root, ".gitignore"), "utf-8").split(/\r?\n/)).not.toContain("*.md")
  })

  it("ships patch files required by patchedDependencies", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      files?: string[]
      patchedDependencies?: Record<string, string>
    }
    const files = new Set(pkg.files ?? [])
    expect(files.has("patches")).toBe(true)

    for (const patchPath of Object.values(pkg.patchedDependencies ?? {})) {
      expect(existsSync(join(root, patchPath))).toBe(true)
      const topLevelDir = patchPath.split("/")[0]
      expect(files.has(topLevelDir)).toBe(true)
    }
  })

  it("does not document removed split-footer environment variables", () => {
    const readme = readFileSync(join(root, "README.md"), "utf-8")
    expect(readme).not.toContain("ZAPCODE_SPLIT_FOOTER_TRANSCRIPT")
    expect(readme).not.toContain("ZAPCODE_SPLIT_FOOTER_HEIGHT")
  })

  it("keeps README slash commands in sync with the built-in palette", () => {
    const readme = readFileSync(join(root, "README.md"), "utf-8")
    const documented = new Set(
      [...readme.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]),
    )
    const expected = BUILTIN_COMMANDS.map((entry) => entry.name)

    expect([...documented].filter((cmd) => cmd.startsWith("/"))).toEqual(expected)
    expect(documented.has("/config")).toBe(false)
    expect(documented.has("/shell")).toBe(false)
  })

  it("keeps documented Bun run scripts in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>
    }
    const scripts = new Set(Object.keys(pkg.scripts ?? {}))
    const docs = [
      readFileSync(join(root, "README.md"), "utf-8"),
      readFileSync(join(root, "AGENTS.md"), "utf-8"),
    ].join("\n")
    const documented = [...docs.matchAll(/`bun run ([a-zA-Z0-9:_-]+)`/g)]
      .map((match) => match[1]!)

    expect(documented.length).toBeGreaterThan(0)
    expect(documented.filter((script) => !scripts.has(script))).toEqual([])
  })

  it("keeps the Bun lockfile compatible with frozen CI installs", () => {
    expect(existsSync(join(root, "bun.lock"))).toBe(true)
    const gitignore = readFileSync(join(root, ".gitignore"), "utf-8")
    expect(gitignore.split(/\r?\n/)).not.toContain("bun.lock")

    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf-8")
    const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf-8")
    expect(ci).toContain("bun install --frozen-lockfile")
    expect(release.match(/bun install --frozen-lockfile/g)?.length).toBe(2)
  })

  it("publishes checksums for release binaries", () => {
    const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf-8")
    expect(release).toContain('bun scripts/write-release-checksum.ts "dist/${{ matrix.artifact }}"')
    expect(release).toContain('bun scripts/write-release-checksum.ts "dist/${{ matrix.artifact }}.runtime.tar.gz"')
    expect(release).toContain("dist/${{ matrix.artifact }}.sha256")
    expect(release).toContain("dist/${{ matrix.artifact }}.runtime.tar.gz.sha256")
    expect(release).toContain("zapvm-image-${{ matrix.arch }}.bundle.tar.zst.sha256")
    expect(release).toContain("zapvm-image-${{ matrix.arch }}.public.pem.sha256")
    expect(release).toContain("target-custom-${{ matrix.arch }}-schema3.json.sha256")
    expect(release).toContain("layer-targets-${{ matrix.arch }}.sha256")
  })

  it("stages the independent Runtime image without embedding an Agent", () => {
    const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf-8")
    expect(release).toContain("ZAPVM_IMAGE_PROFILE: host-runtime")
    expect(release).not.toContain("ZAPVM_ZAP_BINARY")
    expect(release).toContain('bundle="$release_dir/zapvm-image-${{ matrix.arch }}.bundle.tar.zst"')
    expect(release).toContain("signed-image/zapvm-image-${{ matrix.arch }}.bundle.tar.zst")
    expect(release).toContain("signed-image/zapvm-image-${{ matrix.arch }}.public.pem")
    expect(release).toContain('"$image_tool" bundle-layers')
    expect(release).toContain("signed-image/layer-targets/*")
    expect(release).toContain("--layer-target-prefix \"layers/${{ matrix.arch }}\"")
  })

  it("builds both modules from the same checkout and keeps candidates draft", () => {
    const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf-8")
    expect(release).toContain("go-version-file: zapvm/go.mod")
    expect(release).toContain('--zapvm-revision "$GITHUB_SHA"')
    expect(release).not.toContain("ZAPVM_REPOSITORY_TOKEN")
    expect(release).not.toContain("ZAPVM_REVISION")
    expect(release).not.toContain("repository: JackCaow/zapVM")
    expect(release).not.toContain("--draft=false")
    expect(release).toContain("draft: true")
  })

  it("authorizes only a GitHub-verified annotated release tag reachable from main", () => {
    const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf-8")
    expect(release).toContain("release tag must be annotated and signed")
    expect(release).toContain(".verification.verified == true")
    expect(release).toContain(".verification.reason == \"valid\"")
    expect(release).toContain(".merge_base_commit.sha == $commit")
    expect(release).toContain("persist-credentials: false")
  })

  it("does not publish SDK test fixtures in the runtime package", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      files?: string[]
    }
    expect(pkg.files).toContain("zapsdk")
    expect(pkg.files).toContain("!zapsdk/tests")
    expect(pkg.files).toContain("!zapsdk/tests/**")
  })

  it("declares Bun as the package runtime for source-distributed global installs", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      packageManager?: string
      engines?: Record<string, string>
      bin?: Record<string, string>
    }

    expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/)
    expect(pkg.engines?.bun).toBe(">=1.3.0")
    expect(pkg.bin?.zap).toBe("src/index.tsx")
    expect(pkg.bin?.zapdev).toBe("src/index.tsx")
    expect(readFileSync(join(root, pkg.bin!.zap), "utf-8").startsWith("#!/usr/bin/env bun\n")).toBe(true)
  })

  it("exposes the reusable SDK from the package root without changing the CLI bin", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      types?: string
      main?: string
      bin?: Record<string, string>
      exports?: Record<string, unknown>
    }

    expect(pkg.main).toBe("src/index.tsx")
    expect(pkg.bin?.zap).toBe("src/index.tsx")
    expect(pkg.types).toBe("zapsdk/index.ts")
    expect(pkg.exports?.["."]).toEqual({
      types: "./zapsdk/index.ts",
      import: "./zapsdk/index.ts",
      default: "./zapsdk/index.ts",
    })
    expect(pkg.exports?.["./zapsdk/*.js"]).toEqual({
      types: "./zapsdk/*.ts",
      import: "./zapsdk/*.ts",
      default: "./zapsdk/*.ts",
    })
    expect(pkg.exports?.["./zapsdk/*"]).toEqual({
      types: "./zapsdk/*",
      import: "./zapsdk/*",
      default: "./zapsdk/*",
    })
    expect(pkg.exports?.["./cli"]).toBe("./src/index.tsx")
    expect(pkg.exports?.["./package.json"]).toBe("./package.json")
  })

  it("pack dry-run includes runtime patches but excludes SDK tests", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      patchedDependencies?: Record<string, string>
    }
    const proc = spawnSync(process.execPath, ["scripts/pack-npm.ts", "--dry-run"], {
      cwd: root,
      encoding: "utf-8",
    })
    expect(proc.status).toBe(0)
    const output = `${proc.stdout}\n${proc.stderr}`
    for (const patchPath of Object.values(pkg.patchedDependencies ?? {})) {
      expect(output).toContain(patchPath)
    }
    expect(output).not.toContain("zapsdk/tests/")
  }, 30_000)

  it("refuses an unpatched Ink installation instead of producing a release candidate", () => {
    const fixture = mkdtempSync(join(tmpdir(), "zap-unpatched-package-"))
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ ...pkg, files: ["entry.js", "patches"], bin: { zap: "entry.js" } }))
      writeFileSync(join(fixture, "entry.js"), "export {};\n")
      cpSync(join(root, "patches"), join(fixture, "patches"), { recursive: true })
      for (const name of bundledUiPackages) cpSync(join(root, "node_modules", name), join(fixture, "node_modules", name), { recursive: true })
      writeFileSync(join(fixture, "node_modules", "ink", "build", "cursor-helpers.js"), "// No Zap patch applied\n")
      const destination = join(fixture, "candidate")
      expect(() => packNpmPackage({ root: fixture, destination })).toThrow("Package command failed: git")
      expect(existsSync(destination)).toBe(false)
    } finally { rmSync(fixture, { recursive: true, force: true }) }
  })

  it("packed global bin entry can start from the published files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-pack-bin-"))
    try {
      const pack = spawnSync(process.execPath, [
        "scripts/pack-npm.ts",
        "--destination",
        tmp,
      ], {
        cwd: root,
        encoding: "utf-8",
      })
      expect(pack.status).toBe(0)

      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
        name: string
        version: string
      }
      const tarball = join(tmp, `${pkg.name}-${pkg.version}.tgz`)
      const extract = spawnSync("tar", ["-xzf", tarball, "-C", tmp], {
        encoding: "utf-8",
      })
      expect(extract.status).toBe(0)

      const pkgDir = join(tmp, "package")
      const packedPkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
        bin?: Record<string, string>
        dependencies?: Record<string, string>
        private?: boolean
        patchedDependencies?: unknown
        bundledDependencies?: string[]
        scripts?: unknown
      }
      expect(packedPkg.bin).toEqual({
        zap: "src/index.tsx",
      })
      expect(packedPkg.private).toBeUndefined()
      expect(packedPkg.patchedDependencies).toBeUndefined()
      expect(packedPkg.scripts).toBeUndefined()
      expect(packedPkg.bundledDependencies).toEqual([...bundledUiPackages])
      const patchCheck = spawnSync("git", ["apply", "--reverse", "--check", join(root, "patches/ink@7.1.1.patch")], {
        cwd: join(pkgDir, "node_modules", "ink"), encoding: "utf8",
      })
      expect(patchCheck.status).toBe(0)
      const inventory = JSON.parse(readFileSync(join(pkgDir, "bundled-dependencies.json"), "utf8")) as Array<{
        name: string; notices: Array<{ path: string }>
      }>
      expect(inventory.length).toBeGreaterThan(bundledUiPackages.length)
      for (const dependency of inventory) {
        expect(dependency.notices.length).toBeGreaterThan(0)
        for (const notice of dependency.notices) expect(existsSync(join(pkgDir, notice.path))).toBe(true)
      }
      const yoga = inventory.find(dependency => dependency.name === "yoga-layout")!
      expect(readFileSync(join(pkgDir, yoga.notices[0]!.path), "utf8")).toBe(
        readFileSync(join(root, "third_party", "yoga-layout", "LICENSE"), "utf8"),
      )
      // Exercise the packed sources with only their declared dependencies.
      // An extracted tarball has no install; Bun's global cache must not make
      // this fixture pass or trigger implicit network downloads.
      const dependencyRoot = join(pkgDir, "node_modules")
      mkdirSync(dependencyRoot, { recursive: true })
      for (const dependency of Object.keys(packedPkg.dependencies ?? {})) {
        const installed = join(root, "node_modules", dependency)
        expect(existsSync(installed)).toBe(true)
        const destination = join(dependencyRoot, dependency)
        if (existsSync(destination)) continue
        mkdirSync(dirname(destination), { recursive: true })
        symlinkSync(installed, destination, "junction")
      }
      const runtimeEnvironment = { ...process.env, BUN_INSTALL_CACHE_DIR: join(tmp, "empty-cache") }
      const binPaths = [...new Set(Object.values(packedPkg.bin ?? {}))]
      for (const binPath of binPaths) {
        const entry = join(pkgDir, binPath)
        expect(existsSync(entry)).toBe(true)
        expect(readFileSync(entry, "utf-8").startsWith("#!/usr/bin/env bun\n")).toBe(true)

        const proc = spawnSync(entry, ["--version"], {
          cwd: pkgDir,
          encoding: "utf-8",
          env: runtimeEnvironment,
        })
        expect(proc.status).toBe(0)
        expect(proc.stdout.trim()).toBe(`zapAgent v${pkg.version}`)
      }

      const cliEntry = join(pkgDir, packedPkg.bin!.zap)
      const headlessHelp = spawnSync(cliEntry, ["--help-headless"], {
        cwd: pkgDir,
        encoding: "utf-8",
        env: runtimeEnvironment,
      })
      expect(headlessHelp.status).toBe(0)
      expect(headlessHelp.stdout).toContain("zap non-interactive mode")
      expect(headlessHelp.stdout).not.toContain("zapcode")
      expect(headlessHelp.stdout).toContain("--permission-mode")

      const sdkImport = spawnSync(process.execPath, [
        "--no-install",
        "-e",
        `import { ToolRegistry, buildMdPack } from '${pkg.name}'; console.log(typeof ToolRegistry, typeof buildMdPack)`,
      ], {
        cwd: pkgDir,
        encoding: "utf-8",
        env: runtimeEnvironment,
      })
      if (sdkImport.status !== 0) throw new Error(`Packed SDK import failed: ${sdkImport.stderr}`)
      expect(sdkImport.status).toBe(0)
      expect(sdkImport.stdout.trim()).toBe("function function")

      const sdkSubpathImport = spawnSync(process.execPath, [
        "--no-install",
        "-e",
        `import { ConversationManager } from '${pkg.name}/zapsdk/memory/conversation.js'; console.log(typeof ConversationManager)`,
      ], {
        cwd: pkgDir,
        encoding: "utf-8",
        env: runtimeEnvironment,
      })
      expect(sdkSubpathImport.status).toBe(0)
      expect(sdkSubpathImport.stdout.trim()).toBe("function")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})
