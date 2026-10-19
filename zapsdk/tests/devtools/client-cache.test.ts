import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT_HTML = join(import.meta.dir, "../../devtools/client.html");

class HarnessWebSocket {
  static instances: HarnessWebSocket[] = [];
  readonly listeners = new Map<string, (event: { data: string }) => void>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    HarnessWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: string }) => void): void {
    this.listeners.set(type, cb);
  }

  close(): void {}

  emit(type: string, event: { data: string }): void {
    this.listeners.get(type)?.(event);
  }
}

function withDevtoolsClient(fn: (ctx: { document: Document; socket: HarnessWebSocket }) => void): void {
  const html = readFileSync(CLIENT_HTML, "utf-8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  expect(script.length).toBeGreaterThan(0);

  const { window, document } = parseHTML(html);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const restore = (name: string, descriptor: PropertyDescriptor | undefined): void => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  };

  try {
    HarnessWebSocket.instances = [];
    (window as unknown as { scrollTo: () => void }).scrollTo = () => {};
    Object.defineProperty(globalThis, "window", { value: window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: document, configurable: true });
    Object.defineProperty(globalThis, "location", {
      value: new URL("http://127.0.0.1:9229/?token=t"),
      configurable: true,
    });
    Object.defineProperty(globalThis, "WebSocket", { value: HarnessWebSocket, configurable: true });

    (0, eval)(script);
    const socket = HarnessWebSocket.instances[0];
    expect(socket.url).toBe("ws://127.0.0.1:9229/ws?token=t");
    fn({ document: document as unknown as Document, socket });
  } finally {
    restore("window", originalWindow);
    restore("document", originalDocument);
    restore("location", originalLocation);
    restore("WebSocket", originalWebSocket);
  }
}

describe("devtools client cache usage display", () => {
  it("keeps cache usage when pairing run_usage to HTTP rows", () => {
    const html = readFileSync(CLIENT_HTML, "utf-8");

    expect(html).toContain("function usageWithOptionalCache(e)");
    expect(html).toContain('out.providerUsageReported = e.providerUsageReported');
    expect(html).toContain("if (read !== undefined) out.cacheReadInputTokens = read");
    expect(html).toContain("if (write !== undefined) out.cacheCreationInputTokens = write");
    expect(html).not.toContain("cacheReadInputTokens: e.cacheReadInputTokens || 0");
    expect(html).not.toContain("cacheCreationInputTokens: e.cacheCreationInputTokens || 0");
    expect(html).toContain('"prompt-in"');
    expect(html).toContain('"fresh-in"');
    expect(html).toContain('"cache-read"');
    expect(html).toContain('"cache-write"');
    expect(html).toContain("cache not reported");
    expect(html).toContain("usage not reported by provider");
    expect(html).not.toContain('"actual-in"');
  });

  it("renders separate cache reuse/effective/write ratios", () => {
    const html = readFileSync(CLIENT_HTML, "utf-8");

    expect(html).toContain("function cacheStats(input, read, write)");
    expect(html).toContain("cache reuse");
    expect(html).toContain("Cache effective");
    expect(html).toContain("Cache write ratio");
    expect(html).toContain("Prompt input total");
    expect(html).toContain(">prompt</th>");
    expect(html).toContain(">fresh</th>");
  });

  it("passes the devtools token through to the websocket", () => {
    const html = readFileSync(CLIENT_HTML, "utf-8");

    expect(html).toContain('new URLSearchParams(location.search).get("token")');
    expect(html).toContain("/ws${auth}");
  });

  it("rebuilds token/cache panels from snapshot recentEvents", () => {
    const html = readFileSync(CLIENT_HTML, "utf-8");
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(0);

    const { window, document } = parseHTML(html);
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      readonly listeners = new Map<string, (event: { data: string }) => void>();
      readonly url: string;

      constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
      }

      addEventListener(type: string, cb: (event: { data: string }) => void): void {
        this.listeners.set(type, cb);
      }

      close(): void {}

      emit(type: string, event: { data: string }): void {
        this.listeners.get(type)?.(event);
      }
    }

    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

    const restore = (name: string, descriptor: PropertyDescriptor | undefined): void => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    };

    try {
      (window as unknown as { scrollTo: () => void }).scrollTo = () => {};
      Object.defineProperty(globalThis, "window", { value: window, configurable: true });
      Object.defineProperty(globalThis, "document", { value: document, configurable: true });
      Object.defineProperty(globalThis, "location", {
        value: new URL("http://127.0.0.1:9229/?token=t"),
        configurable: true,
      });
      Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

      (0, eval)(script);
      const socket = FakeWebSocket.instances[0];
      expect(socket.url).toBe("ws://127.0.0.1:9229/ws?token=t");

      socket.emit("message", {
        data: JSON.stringify({
          topic: "snapshot",
          ts: 1,
          payload: {
            conversation: [],
            systemPrompt: "",
            config: {},
            recentEvents: [
              {
                ts: 1_000,
                event: {
                  type: "run_usage",
                  step: 2,
                  inputTokens: 10,
                  outputTokens: 5,
                  cacheReadInputTokens: 90,
                  cacheCreationInputTokens: 0,
                },
              },
              {
                ts: 1_100,
                event: {
                  type: "run_ended",
                  steps: 2,
                  usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadInputTokens: 90,
                    cacheCreationInputTokens: 0,
                  },
                },
              },
            ],
          },
        }),
      });

      const tokensBarText = document.getElementById("tokens-bar")?.textContent ?? "";
      expect(tokensBarText).toContain("Prompt input total100");
      expect(tokensBarText).toContain("Fresh input (last run)10");
      expect(tokensBarText).toContain("Cache read90");
      expect(tokensBarText).toContain("Cache write0");
      expect(tokensBarText).toContain("Cache reuse90%");

      const tokensHistoryText = document.getElementById("tokens-history")?.textContent ?? "";
      expect(tokensHistoryText).toContain("promptfreshout");
      expect(tokensHistoryText).toContain("100105");
    } finally {
      restore("window", originalWindow);
      restore("document", originalDocument);
      restore("location", originalLocation);
      restore("WebSocket", originalWebSocket);
    }
  });

  it("shows latest run_usage in the token summary before run_ended arrives", () => {
    withDevtoolsClient(({ document, socket }) => {
      socket.emit("message", {
        data: JSON.stringify({
          topic: "snapshot",
          ts: 1,
          payload: {
            conversation: [],
            systemPrompt: "",
            config: {},
            recentEvents: [
              {
                ts: 1_000,
                event: {
                  type: "run_usage",
                  step: 1,
                  inputTokens: 25,
                  outputTokens: 7,
                  cacheReadInputTokens: 75,
                  cacheCreationInputTokens: 0,
                },
              },
            ],
          },
        }),
      });

      const tokensBarText = document.getElementById("tokens-bar")?.textContent ?? "";
      expect(tokensBarText).toContain("Prompt input total100");
      expect(tokensBarText).toContain("Fresh input (last run)25");
      expect(tokensBarText).toContain("Output (last run)7");
      expect(tokensBarText).toContain("Cache read75");
      expect(tokensBarText).toContain("Cache write0");
      expect(tokensBarText).toContain("Cache reuse75%");
    });
  });

  it("renders context diagnostics from run_step events", () => {
    withDevtoolsClient(({ document, socket }) => {
      socket.emit("message", {
        data: JSON.stringify({
          topic: "snapshot",
          ts: 1,
          payload: {
            conversation: [],
            systemPrompt: "",
            config: {},
            recentEvents: [
              {
                ts: 1_000,
                event: {
                  type: "run_step",
                  step: 1,
                  messageCount: 4,
                  context: {
                    totalChars: 128,
                    estimatedTokens: 32,
                    hash: "ctx-a",
                    conversationCache: {
                      prefix: {
                        messageCount: 3,
                        chars: 400,
                        estimatedTokens: 100,
                        hash: "prefix-a",
                        messageHashes: ["m1", "m2", "m3"],
                      },
                      tail: {
                        messageCount: 1,
                        chars: 40,
                        estimatedTokens: 10,
                        hash: "tail-a",
                      },
                    },
                    segments: [
                      { name: "workspace", chars: 80, estimatedTokens: 20, hash: "seg-a" },
                      {
                        name: "memory",
                        chars: 48,
                        estimatedTokens: 12,
                        hash: "seg-b",
                        meta: {
                          included: [
                            "project_compact_state.md",
                            "project_rules.md",
                            "cache_notes.md",
                            "older_note.md",
                          ],
                          skipped: { budget: 1, min_score: 2 },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        }),
      });

      let tokensBarText = document.getElementById("tokens-bar")?.textContent ?? "";
      expect(tokensBarText).toContain("Context attach32 tok / 128 chars");
      expect(tokensBarText).toContain("Context hashctx-a");
      expect(tokensBarText).toContain("Context segments2");
      expect(tokensBarText).toContain("Conversation prefix100 tok / 3 msgs");
      expect(tokensBarText).toContain("Conversation tail10 tok / 1 msgs");

      let tokensHistoryText = document.getElementById("tokens-history")?.textContent ?? "";
      expect(tokensHistoryText).toContain("Context attach history");
      expect(tokensHistoryText).toContain("ctx-a");
      expect(tokensHistoryText).toContain("3m/100t prefix-a");
      expect(tokensHistoryText).toContain("1m/10t tail-a");
      expect(tokensHistoryText).toContain("workspace:20t/80ch");
      expect(tokensHistoryText).toContain("memory:12t/48ch");
      expect(tokensHistoryText).toContain(
        "included 4 [project_compact_state.md, project_rules.md, cache_notes.md, +1 more]",
      );
      expect(tokensHistoryText).toContain("skipped budget 1, min_score 2");
      expect(tokensHistoryText).not.toContain("older_note.md");

      socket.emit("message", {
        data: JSON.stringify({
          topic: "event",
          ts: 2_000,
          payload: {
            type: "run_step",
            step: 2,
            messageCount: 5,
            context: {
              totalChars: 256,
              estimatedTokens: 64,
              hash: "ctx-b",
              segments: [
                { name: "workspace", chars: 256, estimatedTokens: 64, hash: "seg-c" },
              ],
            },
          },
        }),
      });

      tokensBarText = document.getElementById("tokens-bar")?.textContent ?? "";
      expect(tokensBarText).toContain("Context attach64 tok / 256 chars");
      expect(tokensBarText).toContain("Context hashctx-b");
      expect(tokensBarText).toContain("Context segments1");

      tokensHistoryText = document.getElementById("tokens-history")?.textContent ?? "";
      expect(tokensHistoryText).toContain("ctx-a");
      expect(tokensHistoryText).toContain("ctx-b");
      expect(tokensHistoryText).toContain("workspace:64t/256ch");
    });
  });

  it("renders context hashes as text in token summary cells", () => {
    withDevtoolsClient(({ document, socket }) => {
      socket.emit("message", {
        data: JSON.stringify({
          topic: "event",
          ts: 1_000,
          payload: {
            type: "run_step",
            step: 1,
            messageCount: 1,
            context: {
              totalChars: 12,
              estimatedTokens: 3,
              hash: "<img src=x onerror=alert(1)>",
              segments: [],
            },
          },
        }),
      });

      const tokensBar = document.getElementById("tokens-bar");
      expect(tokensBar?.textContent ?? "").toContain("Context hash<img src=x onerror=alert(1)>");
      expect(tokensBar?.querySelector("img")).toBeNull();
    });
  });

  it("does not render synthetic zero usage as real token accounting", () => {
    withDevtoolsClient(({ document, socket }) => {
      socket.emit("message", {
        data: JSON.stringify({
          topic: "snapshot",
          ts: 1,
          payload: {
            conversation: [],
            systemPrompt: "",
            config: {},
            recentEvents: [
              {
                ts: 1_000,
                event: {
                  type: "run_ended",
                  steps: 1,
                  usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    providerUsageReported: false,
                  },
                },
              },
            ],
          },
        }),
      });

      const tokensBarText = document.getElementById("tokens-bar")?.textContent ?? "";
      expect(tokensBarText).toContain("Usagenot reported");
      expect(tokensBarText).toContain("Prompt input totalnot reported");
      expect(tokensBarText).toContain("Fresh input (last run)not reported");
      expect(tokensBarText).toContain("Output (last run)not reported");

      const eventsText = document.getElementById("events")?.textContent ?? "";
      expect(eventsText).toContain("usage not reported by provider");
      expect(eventsText).not.toContain("total: 0 prompt");
    });
  });
});
