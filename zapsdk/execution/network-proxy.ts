import { createServer, connect, isIP, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";

export interface NetworkPolicy {
  /** Exact hosts, `*.example.com` (subdomains only), or `*` for everything. */
  allowedDomains: string[];
  deniedDomains?: string[];
}

/** Hosts a dev workflow needs: package registries, git hosts, toolchain
 * downloads, common CDNs. Everything else is refused until the user adds it. */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  "github.com", "*.github.com", "*.githubusercontent.com", "ghcr.io", "gitlab.com", "*.gitlab.com", "bitbucket.org",
  "registry.npmjs.org", "*.npmjs.org", "*.npmjs.com", "registry.yarnpkg.com", "yarnpkg.com", "nodejs.org", "bun.sh",
  "deno.land", "jsr.io", "*.jsr.io", "unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com",
  "pypi.org", "files.pythonhosted.org", "*.pythonhosted.org", "pypi.python.org",
  "crates.io", "*.crates.io", "static.rust-lang.org", "sh.rustup.rs", "*.rust-lang.org",
  "proxy.golang.org", "sum.golang.org", "golang.org", "*.golang.org", "go.dev", "pkg.go.dev",
  "rubygems.org", "*.rubygems.org", "repo.maven.apache.org", "repo1.maven.org", "*.gradle.org", "jitpack.io",
  "packagist.org", "repo.packagist.org", "getcomposer.org", "api.nuget.org", "*.nuget.org",
  "registry-1.docker.io", "*.docker.io", "*.docker.com", "formulae.brew.sh", "*.brew.sh",
  "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com", "dl-cdn.alpinelinux.org",
  "fonts.googleapis.com", "fonts.gstatic.com",
];

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackAddress(host: string): boolean {
  return LOOPBACK_NAMES.has(host) || /^127\./.test(host) || host === "::1" || host === "::ffff:127.0.0.1";
}

/** Link-local space holds cloud metadata services (169.254.169.254) and is never
 * a legitimate sandbox destination, whatever the allowlist says. */
function isLinkLocalAddress(address: string): boolean {
  return /^169\.254\./.test(address) || /^fe[89ab][0-9a-f]:/i.test(address) || /^::ffff:169\.254\./i.test(address);
}

function matches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  if (p === "*") return true;
  if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

export type NetworkDecision = { allowed: true } | { allowed: false; reason: string };

export function decideHost(policy: NetworkPolicy, rawHost: string): NetworkDecision {
  const host = normalizeHost(rawHost);
  if (!host) return { allowed: false, reason: "empty host" };
  if (isLinkLocalAddress(host)) return { allowed: false, reason: "link-local addresses are never reachable from the sandbox" };
  if (policy.deniedDomains?.some((pattern) => matches(pattern, host))) {
    return { allowed: false, reason: `${host} is in sandboxNetwork.deniedDomains` };
  }
  if (isLoopbackAddress(host)) return { allowed: true };
  if (policy.allowedDomains.some((pattern) => matches(pattern, host))) return { allowed: true };
  return { allowed: false, reason: `${host} is not in the sandbox network allowlist` };
}

const MAX_HEAD_BYTES = 64 * 1024;

/**
 * Loopback HTTP/CONNECT proxy that enforces a domain allowlist for sandboxed
 * commands. The OS sandbox only lets a command reach this port, so a tool that
 * ignores the proxy settings fails closed instead of bypassing the policy.
 * Host-name filtering only: it does not inspect TLS traffic.
 */
export class NetworkProxy {
  readonly port: number;
  readonly url: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly blocked = new Map<string, string>();

  constructor(private readonly policy: () => NetworkPolicy) {
    this.server = createServer((socket) => this.accept(socket));
    this.server.listen(0, "127.0.0.1");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("network proxy could not bind a loopback port");
    this.port = address.port;
    this.url = `http://127.0.0.1:${this.port}`;
    this.server.unref();
  }

  /** Hosts refused so far, with the reason, for diagnostics. */
  blockedHosts(): ReadonlyMap<string, string> { return this.blocked; }

  close(): void {
    this.server.close();
    for (const socket of this.sockets) socket.destroy();
  }

  private accept(client: Socket): void {
    this.sockets.add(client);
    client.once("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > MAX_HEAD_BYTES) this.reject(client, 431, "request header too large");
        return;
      }
      client.off("data", onData);
      client.pause();
      void this.route(client, buffer.subarray(0, end).toString("latin1"), buffer.subarray(end + 4));
    };
    client.on("data", onData);
  }

  private reject(client: Socket, status: number, message: string): void {
    const body = `${message}\n`;
    client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nContent-Type: text/plain\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }

  private async route(client: Socket, head: string, rest: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const requestLine = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!requestLine) return this.reject(client, 400, "malformed proxy request");
    const [, method, target] = requestLine;
    let host: string;
    let port: number;
    let forwardHead: string | undefined;
    if (method === "CONNECT") {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
      if (!m) return this.reject(client, 400, "malformed CONNECT target");
      host = m[1]; port = Number(m[2]);
    } else {
      let url: URL;
      try { url = new URL(target); } catch { return this.reject(client, 400, "proxy requests need an absolute URL"); }
      if (url.protocol !== "http:") return this.reject(client, 400, "only http: URLs are proxied without CONNECT");
      host = url.hostname; port = Number(url.port || 80);
      const headers = lines.slice(1).filter((line) => !/^(proxy-connection|connection|proxy-authorization):/i.test(line));
      forwardHead = [`${method} ${url.pathname}${url.search} HTTP/1.1`, ...headers, "Connection: close"].join("\r\n") + "\r\n\r\n";
    }
    const decision = decideHost(this.policy(), host);
    if (!decision.allowed) {
      const key = normalizeHost(host);
      if (!this.blocked.has(key)) this.blocked.set(key, decision.reason);
      return this.reject(client, 403,
        `zap sandbox: network access to ${key} is blocked (${decision.reason}). `
        + "Add it to sandboxNetwork.allowedDomains in the config, or retry the command outside the sandbox with approval.");
    }
    let address = normalizeHost(host);
    if (isIP(address) === 0) {
      try { address = (await lookup(address)).address; } catch { return this.reject(client, 502, `cannot resolve ${host}`); }
    }
    if (isLinkLocalAddress(address)) return this.reject(client, 403, `zap sandbox: ${host} resolves to a link-local address`);
    const upstream = connect({ host: address, port });
    this.sockets.add(upstream);
    upstream.once("close", () => this.sockets.delete(upstream));
    let connected = false;
    upstream.on("error", () => {
      if (connected) client.destroy();
      else this.reject(client, 502, `cannot connect to ${host}:${port}`);
      upstream.destroy();
    });
    client.once("close", () => upstream.destroy());
    upstream.once("connect", () => {
      connected = true;
      if (method === "CONNECT") {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
      } else {
        upstream.write(forwardHead!);
        if (rest.length) upstream.write(rest);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  }
}
