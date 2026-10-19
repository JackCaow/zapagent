import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { vmHostBinaryNames } from "../scripts/build-zapvm-host.js"

const root = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

describe("VM monorepo boundaries", () => {
  it("retains an independent Go module and its license", () => {
    expect(read("zapvm/go.mod")).toMatch(/^module zapvm\n/)
    expect(read("zapvm/LICENSE")).toContain("Apache License")
    expect(read("zapvm/NOTICE").length).toBeGreaterThan(0)
  })

  it("names Windows executables correctly without coupling SDK imports to Go", () => {
    expect(vmHostBinaryNames("windows")).toEqual(["zapvm.exe", "zapvm-image.exe"])
    expect(vmHostBinaryNames("darwin")).toEqual(["zapvm", "zapvm-image"])
    expect(vmHostBinaryNames("linux")).toEqual(["zapvm", "zapvm-image"])
    expect(() => vmHostBinaryNames("unsupported")).toThrow("Unsupported VM Host target")
  })

  it("keeps Agent-only builds and npm contents independent", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.scripts.build).not.toContain("go ")
    expect(pkg.scripts["build:all"]).toBe("bun run build && bun run build:vm")
    expect(pkg.scripts["test:vm"]).toContain("go -C zapvm test")
    expect(pkg.files).not.toContain("zapvm")
  })

  it("separates Bun, Go and optional web-client tests", () => {
    expect(read("bunfig.toml")).toContain('pathIgnorePatterns = ["**/zapvm/**"]')
    const workflow = read(".github/workflows/vm.yml")
    expect(workflow).toContain("go test -race")
    expect(workflow).toContain("go vet ./...")
    expect(workflow).toContain("govulncheck")
    expect(workflow).toContain("zapvm/web/client/react/package-lock.json")
    expect(workflow).toContain("npm ci")
    expect(workflow).toContain("npm test")
  })

  it("records the monorepo commit without a second repository checkout", () => {
    const release = read(".github/workflows/release.yml")
    expect(release).toContain('cd zapvm')
    expect(release).not.toContain("zapvm-src")
    expect(release).not.toContain("ZAPVM_REPOSITORY_TOKEN")
    expect(release).not.toContain("ZAPVM_ZAP_BINARY")
    expect(release).toContain('ZAPVM_IMAGE_PROFILE: host-runtime')
    expect(release).toContain('--zapvm-revision "$GITHUB_SHA"')
    expect(release).not.toContain("--draft=false")
  })
})
