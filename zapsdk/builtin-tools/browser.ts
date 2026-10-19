import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Tool } from "../tools/types.js";
import type { ContentBlock } from "../core/types.js";
import { isPathAllowed, resolveToolPath } from "./filesystem.js";

export interface BrowserScreenshotOptions {
  /** Base directory for relative paths. Defaults to process.cwd(). */
  defaultCwd?: string;
  /** Local files may only be rendered from inside these roots. */
  allowedPaths?: string[];
  /** Browser binary. Defaults to ZAPCODE_CHROME, then a Chrome/Chromium/Edge/Brave install. */
  browserPath?: string;
  /** Per-capture timeout. */
  timeoutMs?: number;
}

const MAX_FRAMES = 6;
const MAX_DIMENSION = 2400;
const DEFAULT_TIMEOUT_MS = 40_000;

/** Find a Chromium-family browser. Exported for tests and diagnostics. */
export function findBrowser(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    explicit,
    env.ZAPCODE_CHROME,
    ...(process.platform === "darwin"
      ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ]
      : process.platform === "win32"
        ? [
          join(env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          join(env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
        : [
          "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
          "/snap/bin/chromium", "/usr/bin/microsoft-edge",
        ]),
  ];
  return candidates.find((path): path is string => !!path && existsSync(path));
}

type Target = { kind: "file"; path: string; url: string } | { kind: "url"; url: string };

async function resolveTarget(raw: string, options: BrowserScreenshotOptions): Promise<Target | { error: string }> {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) {
    try { new URL(text); } catch { return { error: `Invalid URL: ${text}` }; }
    return { kind: "url", url: text };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^file:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
    return { error: "Only http(s) URLs and local files can be rendered." };
  }
  const path = /^file:/i.test(text)
    ? decodeURIComponent(new URL(text).pathname)
    : resolveToolPath(text, options.defaultCwd ?? process.cwd());
  if (!existsSync(path) || !statSync(path).isFile()) return { error: `File not found: ${path}` };
  if (!(await isPathAllowed(path, options.allowedPaths))) {
    return { error: `Path is outside the allowed directories: ${path}` };
  }
  return { kind: "file", path, url: pathToFileURL(path).href };
}

function capture(
  browser: string,
  url: string,
  out: string,
  profile: string,
  width: number,
  height: number,
  virtualTimeMs: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    const args = [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run",
      "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking",
      "--allow-file-access-from-files",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${Math.max(1, Math.round(virtualTimeMs))}`,
      `--screenshot=${out}`,
      url,
    ];
    const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.on("data", (d) => { if (log.length < 4000) log += d.toString(); });
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    let finished = false;
    const done = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      kill();
      resolve({ ok, log });
    };
    const timer = setTimeout(() => { log += "\n(timed out)"; done(existsSync(out) && statSync(out).size > 0); }, timeoutMs);
    const onAbort = () => done(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Headless Chrome writes the PNG and then lingers for a long time before it
    // exits. Treat a non-empty file whose size stopped changing as the result.
    let lastSize = -1;
    const poll = setInterval(() => {
      try {
        const size = existsSync(out) ? statSync(out).size : 0;
        if (size > 0 && size === lastSize) done(true);
        lastSize = size;
      } catch { /* retry on the next tick */ }
    }, 250);
    child.once("error", (error) => { log += String(error); done(false); });
    child.once("close", () => done(existsSync(out) && statSync(out).size > 0));
  });
}

/**
 * `browser_screenshot` — render a page or a local file (HTML, SVG, image) in a
 * headless Chromium and return PNG frames. Several `times_ms` give several frames
 * of an animation: the page's timers and animations advance that many virtual
 * milliseconds before each capture, so a CSS/SMIL/JS animation can be checked at
 * t=0, 500, 1000 ... without waiting in real time.
 *
 * It runs in the host process (like the http tools), not in the bash sandbox: a
 * browser cannot start inside it. Local files must sit in the allowed roots.
 */
export function browserScreenshotTool(options: BrowserScreenshotOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    definition: {
      name: "browser_screenshot",
      description:
        "Render a web page or local file (.html, .svg, .png) in headless Chrome and return screenshots. "
        + "Use it to check what a page or an animated SVG really looks like. Several times_ms values return one frame per time, "
        + "so an animation can be inspected without waiting. Needs Chrome, Chromium, Edge or Brave installed.",
      parameters: z.object({
        target: z.string().min(1).describe("http(s) URL, or a path to a local file inside the project"),
        times_ms: z.array(z.number().min(0).max(30_000)).min(1).max(MAX_FRAMES).optional()
          .describe("Page time of each frame in ms (default [1000]); animations and timers advance this long first"),
        width: z.number().int().min(100).max(MAX_DIMENSION).optional().describe("Viewport width in px (default 1280)"),
        height: z.number().int().min(100).max(MAX_DIMENSION).optional().describe("Viewport height in px (default 800)"),
      }),
      permission: "auto",
      timeoutMs: timeoutMs * MAX_FRAMES + 10_000,
      resolveEffects: (args) => {
        const target = String(args.target ?? "");
        const isUrl = /^https?:\/\//i.test(target.trim());
        return {
          filesystem: isUrl ? [] : [{ kind: "filesystem", operation: "read", paths: [resolveToolPath(target, options.defaultCwd ?? process.cwd())] }],
          network: isUrl ? [{ kind: "network", operation: "connect", destinations: [target.trim()], methods: ["GET"] }] : [],
          process: [],
          external: [{ kind: "external", system: "browser:headless", operation: "read" }],
          workspace: { mode: "none" },
          confidence: "declared",
        };
      },
    },
    handler: async (args, signal) => {
      // An explicitly configured binary must exist; do not quietly use another browser.
      const browser = options.browserPath ? (existsSync(options.browserPath) ? options.browserPath : undefined) : findBrowser();
      if (!browser) {
        return {
          success: false,
          output: "",
          error: options.browserPath
            ? `Browser not found at ${options.browserPath}.`
            : "No Chromium-family browser found. Install Google Chrome, Chromium, Edge or Brave, or set ZAPCODE_CHROME to its executable.",
        };
      }
      const target = await resolveTarget(String(args.target), options);
      if ("error" in target) return { success: false, output: "", error: target.error };

      const times = ((args.times_ms as number[] | undefined) ?? [1000]).slice(0, MAX_FRAMES);
      const width = (args.width as number | undefined) ?? 1280;
      const height = (args.height as number | undefined) ?? 800;
      const outDir = join(tmpdir(), "zapcode-screenshots");
      mkdirSync(outDir, { recursive: true });
      const profile = mkdtempSync(join(tmpdir(), "zapcode-chrome-"));
      const stamp = Date.now().toString(36);
      const blocks: ContentBlock[] = [];
      const lines: string[] = [];
      try {
        for (let i = 0; i < times.length; i++) {
          if (signal?.aborted) return { success: false, output: "", error: "aborted" };
          const out = join(outDir, `shot-${stamp}-${i}.png`);
          const result = await capture(browser, target.url, out, profile, width, height, times[i]!, timeoutMs, signal);
          if (!result.ok) {
            const detail = result.log.trim().split("\n").filter((l) => !/crashpad|ERROR:.*(xattr|file_io)/i.test(l)).slice(-4).join("\n");
            return {
              success: false,
              output: lines.join("\n"),
              error: `Screenshot at ${times[i]}ms failed.${detail ? `\n${detail}` : ""}`,
              ...(blocks.length ? { contentBlocks: blocks } : {}),
            };
          }
          const data = readFileSync(out);
          blocks.push({ type: "image", filePath: out, mediaType: "image/png", base64: data.toString("base64"), source: target.url });
          lines.push(`frame ${i + 1}: t=${times[i]}ms, ${(data.length / 1024).toFixed(0)} KB → ${out}`);
        }
      } finally {
        try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      writeFileSync(join(outDir, ".keep"), "");
      return {
        success: true,
        output: `Rendered ${target.kind === "file" ? target.path : target.url} at ${width}x${height}.\n${lines.join("\n")}`,
        contentBlocks: blocks,
      };
    },
  };
}
