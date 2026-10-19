import { execFile } from "node:child_process";
import type { SearchFunction, SearchResult } from "./web-search.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const MAX_QUERY_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_000;
const DEFAULT_CACHE_ENTRIES = 128;

type FetchFunction = typeof fetch;
export type CurlRunner = (args: string[], signal?: AbortSignal) => Promise<string>;

export interface KeylessSearchOptions {
  fetchFn?: FetchFunction;
  curlRunner?: CurlRunner;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  backoffMs?: number;
  requestIntervalMs?: number;
  maxCacheEntries?: number;
}

type BackendFailure = {
  backend: string;
  error: unknown;
};

type BackendRaceResult = {
  results: SearchResult[];
  failures: BackendFailure[];
};

export class WebSearchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchBlockedError";
  }
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

function defaultCurlRunner(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function looksLikeChallenge(body: string, status: number): boolean {
  if (status === 202 || status === 403 || status === 429) return true;
  const head = body.slice(0, 4_000).toLowerCase();
  return head.includes("just a moment")
    || head.includes("enable javascript and cookies to continue")
    || head.includes("attention required! | cloudflare")
    || head.includes("cf-challenge")
    || (head.includes("anomaly") && head.includes("duckduckgo"));
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const codePoint = Number.parseInt(code.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (code.startsWith("#")) {
      const codePoint = Number.parseInt(code.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function cleanHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMarkdown(value: string): string {
  return decodeHtml(value.replace(/\*\*/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeHtml(rawUrl);
  const match = decoded.match(/[?&]uddg=([^&]+)/);
  if (!match) return decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function unwrapBingUrl(rawUrl: string): string {
  const decoded = decodeHtml(rawUrl);
  const match = decoded.match(/[?&]u=([^&]+)/);
  if (!match) return decoded;
  try {
    const encoded = match[1].startsWith("a1") ? match[1].slice(2) : match[1];
    return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return decoded;
  }
}

function parseJinaDuckDuckGo(markdown: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const entry = /^\d+\.\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*\n([\s\S]*?)(?=\n\d+\.\[|\n*$)/gm;
  for (const match of markdown.matchAll(entry)) {
    if (results.length >= maxResults) break;
    const url = unwrapDuckDuckGoUrl(match[2]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippet = (match[3] ?? "").split("\n").map(line => line.trim()).find(Boolean) ?? "";
    results.push({
      title: cleanMarkdown(match[1]),
      url,
      snippet: cleanMarkdown(snippet),
    });
  }
  return results;
}

function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/class="[^"]*result__body[^"]*"/);
  for (let index = 1; index < blocks.length && results.length < maxResults; index++) {
    const block = blocks[index];
    const title = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!title) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const url = unwrapDuckDuckGoUrl(title[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: cleanHtml(title[2]),
      url,
      snippet: snippet ? cleanHtml(snippet[1]) : "",
    });
  }
  return results;
}

function parseBingHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li class="b_algo"/i);
  for (let index = 1; index < blocks.length && results.length < maxResults; index++) {
    const block = blocks[index];
    const title = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    const snippet = block.match(/<p[^>]*class="[^"]*b_(?:lineclamp|caption)[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      ?? block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    let url = unwrapBingUrl(title[1]);
    if (url.startsWith("/")) url = `https://www.bing.com${url}`;
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: cleanHtml(title[2]),
      url,
      snippet: snippet ? cleanHtml(snippet[1]) : "",
    });
  }
  return results;
}

function splitCurlResponse(output: string): { body: string; status: number } {
  const match = output.match(/\n__HTTP_STATUS__:(\d+)\s*$/);
  return {
    body: match?.index === undefined ? output : output.slice(0, match.index),
    status: match ? Number(match[1]) : 200,
  };
}

function browserHeaders(): Record<string, string> {
  return {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
}

async function jinaDuckDuckGoSearch(
  query: string,
  maxResults: number,
  fetchFn: FetchFunction,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const target = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetchFn(`https://r.jina.ai/${target}`, {
    headers: {
      ...browserHeaders(),
      "Accept": "text/plain",
      "X-Return-Format": "markdown",
    },
    signal: timeoutSignal(signal, Math.max(timeoutMs, 20_000)),
  });
  const body = await response.text();
  if (looksLikeChallenge(body, response.status)) {
    throw new WebSearchBlockedError(`Jina/DDG returned HTTP ${response.status} or a challenge page`);
  }
  if (!response.ok) throw new Error(`Jina returned HTTP ${response.status}`);
  return parseJinaDuckDuckGo(body, maxResults);
}

async function curlDuckDuckGoSearch(
  query: string,
  maxResults: number,
  curlRunner: CurlRunner,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const output = await curlRunner([
    "-sS",
    "--compressed",
    "--max-time", String(timeoutSeconds),
    "-A", BROWSER_UA,
    "-e", "https://html.duckduckgo.com/",
    "-H", "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
    "--data-urlencode", `q=${query}`,
    "https://html.duckduckgo.com/html/",
    "-w", "\n__HTTP_STATUS__:%{http_code}",
  ], timeoutSignal(signal, timeoutMs));
  const { body, status } = splitCurlResponse(output);
  if (looksLikeChallenge(body, status)) {
    throw new WebSearchBlockedError(`curl/DDG returned HTTP ${status} or a challenge page`);
  }
  if (status < 200 || status >= 300) throw new Error(`curl/DDG returned HTTP ${status}`);
  return parseDuckDuckGoHtml(body, maxResults);
}

async function bingSearch(
  query: string,
  maxResults: number,
  fetchFn: FetchFunction,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults * 2}`;
  const response = await fetchFn(url, {
    headers: browserHeaders(),
    signal: timeoutSignal(signal, timeoutMs),
  });
  const body = await response.text();
  if (looksLikeChallenge(body, response.status)) {
    throw new WebSearchBlockedError(`Bing returned HTTP ${response.status} or a challenge page`);
  }
  if (!response.ok) throw new Error(`Bing returned HTTP ${response.status}`);
  return parseBingHtml(body, maxResults);
}

async function firstNonEmpty(
  attempts: Array<{
    backend: string;
    run: (signal: AbortSignal) => Promise<SearchResult[]>;
  }>,
  callerSignal?: AbortSignal,
): Promise<BackendRaceResult> {
  const controllers = attempts.map(() => new AbortController());
  const failures: BackendFailure[] = [];

  return await new Promise((resolve) => {
    let settled = 0;
    let finished = false;
    attempts.forEach((attempt, index) => {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controllers[index].signal])
        : controllers[index].signal;
      attempt.run(signal).then((results) => {
        if (finished) return;
        if (results.length > 0) {
          finished = true;
          controllers.forEach((controller, controllerIndex) => {
            if (controllerIndex !== index) controller.abort();
          });
          resolve({ results, failures });
          return;
        }
        settled++;
        if (settled === attempts.length) resolve({ results: [], failures });
      }).catch((error) => {
        if (finished) return;
        failures.push({ backend: attempt.backend, error });
        settled++;
        if (settled === attempts.length) resolve({ results: [], failures });
      });
    });
  });
}

function failureSummary(failures: BackendFailure[]): string {
  return failures.map(({ backend, error }) => (
    `${backend}: ${error instanceof Error ? error.message : String(error)}`
  )).join("; ");
}

function cacheKey(query: string, maxResults: number): string {
  return `${maxResults}\u0000${query}`;
}

/**
 * Zero-key web search modeled after the local ddg-search skill:
 * memory cache -> hedged Jina/DDG + curl/DDG -> independent Bing fallback.
 * Challenges enter a short process-local backoff so agent retry loops do not
 * repeatedly hit an already-blocked DDG endpoint or persist user queries.
 */
export function createKeylessWebSearch(options: KeylessSearchOptions = {}): SearchFunction {
  const fetchFn = options.fetchFn ?? fetch;
  const curlRunner = options.curlRunner ?? defaultCurlRunner;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const requestIntervalMs = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES;
  const cache = new Map<string, { expiresAt: number; results: SearchResult[] }>();
  let ddgBlockedUntil = 0;
  let lastDdgRequestAt = 0;

  return async (rawQuery, rawMaxResults, signal) => {
    throwIfAborted(signal);
    const query = rawQuery.trim();
    if (!query) throw new Error("search query must not be empty");
    if (query.length > MAX_QUERY_LENGTH) {
      throw new Error(`search query exceeds ${MAX_QUERY_LENGTH} characters`);
    }
    const maxResults = Math.min(20, Math.max(1, Math.floor(rawMaxResults)));
    const key = cacheKey(query, maxResults);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.results.map(result => ({ ...result }));
    }
    if (cached) cache.delete(key);

    const failures: BackendFailure[] = [];
    if (now() >= ddgBlockedUntil) {
      const waitMs = Math.max(0, requestIntervalMs - (now() - lastDdgRequestAt));
      await sleep(waitMs, signal);
      throwIfAborted(signal);
      lastDdgRequestAt = now();
      const ddg = await firstNonEmpty([
        {
          backend: "jina-ddg",
          run: backendSignal => jinaDuckDuckGoSearch(query, maxResults, fetchFn, backendSignal, timeoutMs),
        },
        {
          backend: "curl-ddg",
          run: backendSignal => curlDuckDuckGoSearch(query, maxResults, curlRunner, backendSignal, timeoutMs),
        },
      ], signal);
      throwIfAborted(signal);
      failures.push(...ddg.failures);
      if (ddg.results.length > 0) {
        cache.set(key, { expiresAt: now() + cacheTtlMs, results: ddg.results });
        while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value!);
        return ddg.results.map(result => ({ ...result }));
      }
      if (ddg.failures.some(failure => failure.error instanceof WebSearchBlockedError)) {
        ddgBlockedUntil = now() + backoffMs;
      }
    } else {
      failures.push({ backend: "ddg", error: new WebSearchBlockedError("temporary backoff active") });
    }

    try {
      const results = await bingSearch(query, maxResults, fetchFn, signal, timeoutMs);
      throwIfAborted(signal);
      if (results.length > 0) {
        cache.set(key, { expiresAt: now() + cacheTtlMs, results });
        while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value!);
        return results.map(result => ({ ...result }));
      }
      return [];
    } catch (error) {
      throwIfAborted(signal);
      failures.push({ backend: "bing", error });
    }

    throw new Error(`All keyless search backends failed. ${failureSummary(failures)}`);
  };
}
