import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { countCodePoints, sliceHeadCodePoints } from "../utils/logical-lines.js";

export type HostnameResolver = (hostname: string) => Promise<string[]>;

export interface HttpFetchOptions {
  maxResponseLength?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Jina receives the complete source URL. Disabled by default so signed or
   * internal-looking URLs are never sent to a third party implicitly. */
  useJinaReader?: boolean;
  /** Test/embedding seam. Production defaults to DNS lookup with all records. */
  resolveHostname?: HostnameResolver;
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; ZapCode/1.0)",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
};
const ERROR_BODY_PREVIEW_CHARS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 5;
const PUBLIC_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

interface HttpRuntimeOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  resolveHostname: HostnameResolver;
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  const addresses = records.map((record) => record.address);
  if (!onlyFakeIpAddresses(addresses)) return addresses;
  return resolvePublicDnsOverHttps(hostname);
}

function onlyFakeIpAddresses(addresses: string[]): boolean {
  return addresses.length > 0 && addresses.every((address) => {
    const octets = address.split(".").map(Number);
    return octets.length === 4 && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)
      && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  });
}

export async function resolvePublicDnsOverHttps(
  hostname: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const addresses = new Set<string>();
  for (const type of [1, 28]) {
    const endpoint = new URL(PUBLIC_DOH_ENDPOINT);
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", String(type));
    const response = await fetcher(endpoint, {
      method: "GET",
      headers: { "Accept": "application/dns-json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`DNS-over-HTTPS returned HTTP ${response.status}`);
    const payload = await response.json() as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (payload.Status !== 0) {
      throw new Error(`DNS-over-HTTPS returned DNS status ${String(payload.Status)}`);
    }
    for (const answer of payload.Answer ?? []) {
      if (answer.type === type && typeof answer.data === "string" && isIP(answer.data) !== 0) {
        addresses.add(answer.data);
      }
    }
  }
  if (addresses.size === 0) throw new Error("DNS-over-HTTPS returned no IP addresses");
  return [...addresses];
}

/** Validate both the textual host and every resolved address. Exported for
 * security regression tests and embedders that want to preflight a URL. */
export async function assertSafePublicHttpUrl(
  rawUrl: string,
  resolveHostname: HostnameResolver = defaultResolveHostname,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol || "unknown"}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded credentials are not allowed");
  }

  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`Private or local network destination is not allowed: ${url.hostname}`);
  }

  const literalKind = isIP(hostname);
  const addresses = literalKind ? [hostname] : await resolveHostname(hostname);
  if (addresses.length === 0) throw new Error(`Hostname did not resolve: ${hostname}`);
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new Error(`Private, local, or reserved network destination is not allowed: ${address}`);
    }
  }
  return url;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPublicAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  const kind = isIP(normalized);
  if (kind === 4) return isPublicIpv4(normalized);
  if (kind === 6) return isPublicIpv6(normalized);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  if (address.startsWith("fc") || address.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(address)) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isPublicIpv4(mapped[1]);
  return true;
}

async function fetchWithValidatedRedirects(
  rawUrl: string,
  init: RequestInit,
  options: HttpRuntimeOptions,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = await assertSafePublicHttpUrl(rawUrl, options.resolveHostname);
  for (let redirect = 0; redirect <= options.maxRedirects; redirect++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    if (redirect === options.maxRedirects) {
      throw new Error(`Too many redirects (>${options.maxRedirects})`);
    }
    current = await assertSafePublicHttpUrl(new URL(location, current).toString(), options.resolveHostname);
  }
  throw new Error("Redirect validation failed");
}

async function readResponseTextCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!response.body || maxBytes <= 0) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    return { text: "", truncated: !!response.body, bytes: 0 };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
    return { text, truncated, bytes };
  } finally {
    reader.releaseLock();
  }
}

function appendByteLimitMarker(text: string, truncated: boolean, maxBytes: number): string {
  return truncated ? `${text}\n\n… [response truncated at ${maxBytes} bytes]` : text;
}

function stripHtml(html: string): string {
  let text = html;
  text = text.replace(/<(script|style|nav|footer|header|noscript|iframe|svg|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|br|hr)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#\d+;/g, "");
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).join("\n");
}

function runtimeOptions(options: HttpFetchOptions, brokerMaxResponseBytes?: number): HttpRuntimeOptions {
  const resolver = options.resolveHostname ?? defaultResolveHostname;
  const resolved = new Map<string, Promise<string[]>>();
  return {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxResponseBytes: Math.max(0, Math.floor(Math.min(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      brokerMaxResponseBytes ?? Number.MAX_SAFE_INTEGER,
    ))),
    maxRedirects: Math.max(0, Math.floor(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)),
    resolveHostname: (hostname) => {
      const cached = resolved.get(hostname);
      if (cached) return cached;
      const pending = resolver(hostname);
      resolved.set(hostname, pending);
      return pending;
    },
  };
}

function canUseJina(url: URL): boolean {
  return !url.search && !url.username && !url.password;
}

async function executeHttpCall(
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: HttpFetchOptions,
  allowJina: boolean,
  context?: Parameters<Tool["handler"]>[2],
): Promise<ReturnType<Tool["handler"]> extends Promise<infer R> ? R : never> {
  const maxResponseLength = Math.max(0, Math.floor(options.maxResponseLength ?? 50_000));
  const runtime = runtimeOptions(options, context?.limits?.maxNetworkBytes);
  const url = args.url as string;
  const method = ((args.method as string | undefined) ?? "GET").toUpperCase();
  const raw = (args.raw as boolean | undefined) ?? false;
  const headers = args.headers as Record<string, string> | undefined;
  const body = args.body as string | undefined;
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(runtime.timeoutMs)])
    : AbortSignal.timeout(runtime.timeoutMs);

  try {
    const validated = await assertSafePublicHttpUrl(url, runtime.resolveHostname);
    let targetUrl = validated.toString();
    let requestHeaders: Record<string, string> = { ...DEFAULT_HEADERS, ...headers };
    if (allowJina && options.useJinaReader === true && method === "GET" && !raw && !body && canUseJina(validated)) {
      targetUrl = `https://r.jina.ai/${validated.toString()}`;
      requestHeaders = { ...DEFAULT_HEADERS, "Accept": "text/plain", "X-Return-Format": "markdown" };
    }

    const { response, finalUrl } = await fetchWithValidatedRedirects(targetUrl, {
      method,
      headers: requestHeaders,
      body,
      signal: fetchSignal,
    }, runtime);
    const bodyResult = await readResponseTextCapped(response, runtime.maxResponseBytes, fetchSignal);
    context?.resources?.consumeNetworkBytes(bodyResult.bytes);
    const responseText = appendByteLimitMarker(bodyResult.text, bodyResult.truncated, runtime.maxResponseBytes);

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "unknown";
      const errorDetail = [
        `HTTP ${response.status} ${response.statusText}`,
        `URL: ${finalUrl.toString()}`,
        `Content-Type: ${contentType}`,
        responseText ? `Body:\n${sliceHeadCodePoints(responseText, ERROR_BODY_PREVIEW_CHARS)}` : "",
      ].filter(Boolean).join("\n");
      return { success: false, output: "", error: errorDetail };
    }

    let text = responseText;
    const contentType = response.headers.get("content-type") ?? "";
    if (!raw && method === "GET" && !targetUrl.startsWith("https://r.jina.ai/") &&
      (contentType.includes("text/html") || contentType.includes("application/xhtml"))) {
      text = stripHtml(responseText);
    }
    return { success: true, output: truncateHttpText(text, maxResponseLength) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: `${message}\nURL: ${url}\nMethod: ${method}` };
  }
}

export function httpFetchTool(options: HttpFetchOptions = {}): Tool {
  return {
    definition: {
      name: "http_fetch",
      description: "Read a public HTTP(S) URL with GET or HEAD. Private/local destinations and unsafe redirects are blocked; responses are byte-capped.",
      parameters: z.object({
        url: z.string().url().describe("Public HTTP(S) URL to fetch"),
        method: z.enum(["GET", "HEAD"]).optional().describe("Read-only HTTP method (default: GET)"),
        raw: z.boolean().optional().describe("Return raw response without local HTML extraction (default: false)"),
      }),
      permission: "auto",
      readOnly: true,
      limits: {
        timeoutMs: options.timeoutMs ?? 15_000,
        maxNetworkBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      },
      resolveEffects: (args) => ({
        filesystem: [],
        network: [{
          kind: "network",
          operation: "connect",
          destinations: [String(args.url)],
          methods: [String(args.method ?? "GET").toUpperCase()],
        }],
        process: [],
        external: [],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: (args, signal, context) => executeHttpCall(args, signal, options, true, context),
  };
}

/** Explicitly mutating HTTP surface. It is intentionally a separate Tool so
 * legacy static permission handling cannot auto-approve POST/PUT/DELETE. */
export function httpRequestTool(options: HttpFetchOptions = {}): Tool {
  return {
    definition: {
      name: "http_request",
      description: "Send a mutating request to a public HTTP(S) URL. Always requires approval and blocks private/local destinations and unsafe redirects.",
      parameters: z.object({
        url: z.string().url().describe("Public HTTP(S) URL"),
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().max(1_000_000).optional(),
        raw: z.boolean().optional(),
      }),
      permission: "confirm",
      limits: {
        timeoutMs: options.timeoutMs ?? 15_000,
        maxInputBytes: 1_000_000,
        maxNetworkBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      },
      resolveEffects: (args) => ({
        filesystem: [],
        network: [{
          kind: "network",
          operation: "mutate",
          destinations: [String(args.url)],
          methods: [String(args.method).toUpperCase()],
        }],
        process: [],
        external: [{
          kind: "external",
          system: "http",
          operation: "mutate",
          resource: String(args.url),
        }],
        workspace: { mode: "none" },
        confidence: "declared",
      }),
    },
    handler: (args, signal, context) => executeHttpCall(args, signal, options, false, context),
  };
}

export function truncateHttpText(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  const totalChars = countCodePoints(text);
  if (totalChars <= limit) return text;
  return `${sliceHeadCodePoints(text, limit)}\n\n… [truncated — ${totalChars} total chars]`;
}
