import { z } from "zod";
import type { Tool } from "../tools/types.js";
import { createKeylessWebSearch } from "./web-search-keyless.js";

export {
  createKeylessWebSearch,
  WebSearchBlockedError,
  type CurlRunner,
  type KeylessSearchOptions,
} from "./web-search-keyless.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchFunction = (query: string, maxResults: number, signal?: AbortSignal) => Promise<SearchResult[]>;

export interface WebSearchOptions {
  searchFn?: SearchFunction;
  maxResults?: number;
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

/**
 * SerpAPI search backend. Requires a SerpAPI key.
 * Get one at https://serpapi.com (free tier available).
 */
export function createSerpApiSearch(apiKey: string): SearchFunction {
  return async (query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> => {
    const params = new URLSearchParams({
      q: query,
      api_key: apiKey,
      engine: "google",
      num: String(maxResults),
    });

    const response = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: withTimeoutSignal(signal, 15000),
    });

    if (!response.ok) {
      throw new Error(`SerpAPI returned HTTP ${response.status}`);
    }

    const data = await response.json() as any;
    const organic = data.organic_results ?? [];

    return organic.slice(0, maxResults).map((r: any) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
    }));
  };
}

/**
 * Serper API backend (Google Search). Requires a Serper API key.
 * Get one at https://serper.dev (free tier: 2500 queries).
 */
export function createSerperSearch(apiKey: string): SearchFunction {
  return async (query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> => {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: maxResults }),
      signal: withTimeoutSignal(signal, 15000),
    });

    if (!response.ok) {
      throw new Error(`Serper API returned HTTP ${response.status}`);
    }

    const data = await response.json() as any;
    const organic = data.organic ?? [];

    return organic.slice(0, maxResults).map((r: any) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: r.snippet ?? "",
    }));
  };
}

/**
 * Brave Search backend. Requires a Brave Search API key.
 * Get one at https://brave.com/search/api/ (free tier: 2000 queries/month).
 */
export function createBraveSearch(apiKey: string): SearchFunction {
  return async (query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> => {
    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
    });

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: withTimeoutSignal(signal, 15000),
    });

    if (!response.ok) {
      throw new Error(`Brave Search returned HTTP ${response.status}`);
    }

    const data = await response.json() as any;
    const results = data.web?.results ?? [];

    return results.slice(0, maxResults).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  };
}

export function webSearchTool(options: WebSearchOptions = {}): Tool {
  const searchFn = options.searchFn ?? createKeylessWebSearch();
  const maxResults = options.maxResults ?? 5;

  return {
    definition: {
      name: "web_search",
      description: "Search the web for information. Returns direct URLs and snippets; use http_fetch only when full page content is needed.",
      parameters: z.object({
        query: z.string().trim().min(1).max(500).describe("The search query"),
      }),
      permission: "auto",
      readOnly: true,
    },
    handler: async (args, signal) => {
      const query = args.query as string;

      try {
        if (signal?.aborted) {
          return { success: false, output: "", error: "aborted" };
        }
        const results = await searchFn(query, maxResults, signal);
        if (signal?.aborted) {
          return { success: false, output: "", error: "aborted" };
        }

        if (results.length === 0) {
          return { success: true, output: "No results found." };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return { success: true, output: formatted };
      } catch (err) {
        if (signal?.aborted) {
          return { success: false, output: "", error: "aborted" };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}
