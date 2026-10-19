import { spawn } from "node:child_process";
import type { RuntimeObserver } from "../../zapsdk/runtime/observation.js";
import type { WatchOptions } from "./args.js";
import { WatchHub } from "./hub.js";
import { WatchServer } from "./server.js";

let active: { hub: WatchHub; server: WatchServer } | undefined;
export function watchObserver(): RuntimeObserver | undefined { return active?.hub; }
export function watchSession(threadId: string): () => void {
  const hub = active?.hub; hub?.session(threadId, "idle");
  return () => hub?.session(threadId, "closed");
}
export async function startWatch(options: WatchOptions) {
  if (!options.enabled || active) return;
  const hub = new WatchHub({ onError: () => process.stderr.write("[watch] Observation degraded; agent execution continues.\n") });
  const server = new WatchServer(hub, options.port);
  try { await server.start(); } catch (error) { hub.close(); throw error; }
  active = { hub, server };
  process.stderr.write(`[watch] ${server.url}\n`);
  if (options.open) {
    const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", server.url] : [server.url];
    try {
      const browser = spawn(executable, args, { detached: true, stdio: "ignore" }); browser.unref();
      browser.once("error", () => process.stderr.write("[watch] Browser unavailable; open the URL manually.\n"));
      browser.once("exit", code => { if (code) process.stderr.write("[watch] Open the URL manually.\n"); });
    } catch { process.stderr.write("[watch] Open the URL manually.\n"); }
  }
}
export async function stopWatch(linger = 0) {
  const value = active; if (!value) return;
  value.hub.stop();
  if (linger > 0) {
    process.stderr.write(`[watch] Runtime ended; read-only view remains for ${linger}s. Ctrl+C closes the viewer.\n`);
    const signals = ["SIGINT", "SIGTERM"] as const;
    const previous = signals.map(signal => process.rawListeners(signal));
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        for (const [index, signal] of signals.entries()) {
          process.removeListener(signal, done);
          for (const listener of previous[index]!) process.on(signal, listener);
        }
        resolve();
      };
      const timer = setTimeout(done, linger * 1000);
      for (const signal of signals) { process.removeAllListeners(signal); process.once(signal, done); }
    });
  }
  active = undefined;
  await value.server.close();
}
