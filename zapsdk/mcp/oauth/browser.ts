// Open a URL in the user's default browser. Uses platform-native invocations
// instead of pulling in the heavy `open` npm package — it's three lines of
// spawn and avoids a postinstall script.

import { spawn } from "node:child_process";

export interface OpenBrowserOptions {
  /** If true, do nothing and resolve. Useful in headless test runners. */
  noop?: boolean;
}

export async function openBrowser(url: string, opts: OpenBrowserOptions = {}): Promise<void> {
  if (opts.noop) return;

  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    // `start ""` consumes the empty title arg so a URL with spaces (rare,
    // but legal in query strings) isn't interpreted as the title.
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => resolve());   // swallow ENOENT etc.
    child.on("close", () => resolve());
    // Don't keep the parent event loop waiting on the child.
    child.unref();
  });
}
