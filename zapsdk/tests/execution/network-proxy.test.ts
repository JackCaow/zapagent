import { afterAll, describe, expect, it } from "bun:test"
import { createServer as createHttpServer } from "node:http"
import { connect } from "node:net"
import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_ALLOWED_DOMAINS, NetworkProxy, decideHost } from "../../execution/network-proxy.js"

it("adapter domains stay command scoped and never override explicit denials", () => {
  const base = new NetworkProxy(() => ({ allowedDomains: [], deniedDomains: ["api.anthropic.com"] }))
  const delegate = base.fork()
  const sibling = base.fork()
  try {
    delegate.allowDomains(["api.anthropic.com", "*.chatgpt.com", "*"])
    expect(delegate.decideHost("ab.chatgpt.com").allowed).toBe(true)
    expect(delegate.decideHost("api.anthropic.com").allowed).toBe(false)
    expect(delegate.decideHost("unrelated.example").allowed).toBe(false)
    expect(base.decideHost("ab.chatgpt.com").allowed).toBe(false)
    expect(sibling.decideHost("ab.chatgpt.com").allowed).toBe(false)
  } finally { base.close(); delegate.close(); sibling.close() }
})
import { createPlatformSandbox } from "../../execution/sandbox.js"

describe("decideHost", () => {
  const policy = { allowedDomains: [...DEFAULT_ALLOWED_DOMAINS, "example.org", "*.corp.test"], deniedDomains: ["evil.github.com"] }
  const ok = (h: string) => decideHost(policy, h).allowed

  it("allows registries, wildcard subdomains and loopback", () => {
    for (const h of ["pypi.org", "files.pythonhosted.org", "api.github.com", "example.org", "a.b.corp.test", "localhost", "127.0.0.1", "::1", "PyPI.org."]) expect(ok(h)).toBe(true)
  })
  it("refuses everything else, the wildcard apex, lookalikes and metadata addresses", () => {
    for (const h of ["attacker.com", "corp.test", "pypi.org.attacker.com", "notgithub.com", "169.254.169.254", "evil.github.com", "10.0.0.5"]) expect(ok(h)).toBe(false)
  })
  it("'*' opens everything except link-local", () => {
    expect(decideHost({ allowedDomains: ["*"] }, "anything.net").allowed).toBe(true)
    expect(decideHost({ allowedDomains: ["*"] }, "169.254.169.254").allowed).toBe(false)
  })
})

function request(proxyPort: number, raw: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(proxyPort, "127.0.0.1")
    let out = ""
    socket.on("data", (d) => { out += d.toString("latin1") })
    socket.on("close", () => resolve(out))
    socket.on("error", () => resolve(out))
    socket.write(raw)
    setTimeout(() => socket.end(), 500)
  })
}

describe("NetworkProxy", () => {
  const origin = createHttpServer((req, res) => { res.end(`origin saw ${req.method} ${req.url} host=${req.headers.host}`) })
  origin.listen(0, "127.0.0.1")
  const originPort = (origin.address() as { port: number }).port
  const proxy = new NetworkProxy(() => ({ allowedDomains: ["pypi.org"] }))
  afterAll(() => { proxy.close(); origin.close() })

  it("forwards plain HTTP to an allowed (loopback) host in origin form", async () => {
    const out = await request(proxy.port, `GET http://127.0.0.1:${originPort}/a?b=1 HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`)
    expect(out).toContain("200 OK")
    expect(out).toContain(`origin saw GET /a?b=1 host=127.0.0.1:${originPort}`)
  })

  it("tunnels CONNECT to an allowed host", async () => {
    const out = await request(proxy.port, `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: x\r\n\r\nGET /t HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`)
    expect(out).toContain("200 Connection Established")
    expect(out).toContain("origin saw GET /t")
  })

  it("answers 403 with a hint for a host outside the allowlist, for both forms, and records it", async () => {
    const http = await request(proxy.port, "GET http://attacker.example/x HTTP/1.1\r\nHost: attacker.example\r\n\r\n")
    expect(http).toContain("403 Forbidden")
    expect(http).toContain("sandboxNetwork.allowedDomains")
    const tunnel = await request(proxy.port, "CONNECT attacker.example:443 HTTP/1.1\r\nHost: x\r\n\r\n")
    expect(tunnel).toContain("403 Forbidden")
    expect(proxy.blockedHosts().has("attacker.example")).toBe(true)
  })

  it("rejects malformed requests", async () => {
    expect(await request(proxy.port, "NONSENSE\r\n\r\n")).toContain("400")
  })
})

const macDescribe = process.platform === "darwin" ? describe : describe.skip
macDescribe("macOS Seatbelt confines a command to the proxy", () => {
  const origin = createHttpServer((_req, res) => res.end("origin-ok"))
  origin.listen(0, "127.0.0.1")
  const originPort = (origin.address() as { port: number }).port
  const proxy = new NetworkProxy(() => ({ allowedDomains: [] }))
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zap-netproxy-")))
  afterAll(() => { proxy.close(); origin.close(); rmSync(root, { recursive: true, force: true }) })

  // Async: the proxy lives in this process, so a blocking spawn would starve it.
  async function run(command: string): Promise<{ stdout: string; status: number | null }> {
    const sandbox = createPlatformSandbox({ networkProxy: proxy, tempRoot: join(root, "tmp") })
    const context = sandbox.createContext({
      executionId: "t", workspace: { root, mode: "root-integration" } as never,
      effects: { filesystem: [], network: [], process: [], external: [], workspace: { mode: "root-integration" }, confidence: "declared" } as never,
      grant: { filesystem: { read: [root], write: [root] }, network: { destinations: ["*"], methods: [] } } as never,
    })
    const prepared = context.prepareShell(command, { cwd: root })
    try {
      return await new Promise((resolve) => {
        const child = spawn(prepared.executable, prepared.args, { env: prepared.env, cwd: root })
        let stdout = ""
        child.stdout.on("data", (d) => { stdout += d.toString() })
        child.on("close", (status) => resolve({ stdout, status }))
      })
    } finally { prepared.release?.() }
  }

  it("reaches a loopback server", async () => {
    const r = await run(`/usr/bin/curl -s --max-time 8 http://127.0.0.1:${originPort}/`)
    expect(r.stdout).toBe("origin-ok")
  })

  it("gets 403 for a host that is not allowed", async () => {
    const r = await run("/usr/bin/curl -s --max-time 8 -o /dev/null -w '%{http_code}' http://attacker.example/")
    expect(r.stdout).toBe("403")
  })

  it("cannot dial an external host directly when the proxy settings are ignored", async () => {
    // Control: the host must be reachable outside the sandbox, otherwise nothing is proven.
    const control = await new Promise<string>((resolve) => {
      const c = spawn("/usr/bin/curl", ["-s", "--max-time", "6", "--noproxy", "*", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"])
      let out = ""; c.stdout.on("data", (d) => { out += d }); c.on("close", () => resolve(out))
    })
    if (control !== "200") return
    const code = (await run("/usr/bin/curl -s --noproxy '*' --max-time 6 -o /dev/null -w '%{http_code}' https://example.com")).stdout
    expect(code).toBe("000")
  })
})
