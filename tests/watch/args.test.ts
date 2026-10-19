import { expect, it } from "bun:test";
import { parseWatchArgs } from "../../src/watch/args.js";
import { isHeadlessInvocation } from "../../src/cli-routing.js";
it("removes viewer options before routing and keeps prompt/config values opaque", () => {
  const parsed = parseWatchArgs(["--watch", "--watch-port", "4318"]);
  expect(parsed.watch.port).toBe(4318); expect(isHeadlessInvocation(parsed.args, true)).toBe(false);
  expect(parseWatchArgs(["--watch", "-p", "--dev", "--watch-no-open"]).args).toEqual(["-p", "--dev"]);
  expect(parseWatchArgs(["--system-prompt-prepend", "--watch"]).watch.enabled).toBe(false);
});
it("rejects malformed/duplicate options and incompatible protocol invocations", () => {
  for (const argv of [["--watch-port", "1"], ["--watch", "--watch"], ["--watch", "--watch-port", "65536"],
    ["--watch", "--watch-linger", "301"], ["--watch", "--watch-port", "-1"], ["--watch", "--dev"],
    ["acp", "--watch"], ["--acp-worker", "--watch"], ["workflow", "--watch"], ["--watch", "--watch-typo"]]) {
    expect(() => parseWatchArgs(argv)).toThrow();
  }
});
