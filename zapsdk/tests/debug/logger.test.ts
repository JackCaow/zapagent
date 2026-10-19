import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Logger } from "../../debug/logger.js";

describe("Logger", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.ZAPCODE_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "zap-debug-logger-"));
    process.env.ZAPCODE_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR;
    else process.env.ZAPCODE_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("does not drop an entry logged immediately after construction", async () => {
    const logger = new Logger();

    logger.info("first_event", { value: "kept" });
    await logger.close();

    expect(existsSync(logger.logFile)).toBe(true);
    const content = readFileSync(logger.logFile, "utf-8");
    expect(content).toContain("first_event");
    expect(content).toContain("kept");
  });

  it("writes logs with owner-only directory and file permissions", async () => {
    if (process.platform === "win32") return;
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    chmodSync(logsDir, 0o777);
    const logger = new Logger();

    logger.warn("private_log");
    await logger.close();

    expect(dirname(logger.logFile)).toBe(logsDir);
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
    expect(statSync(logger.logFile).mode & 0o777).toBe(0o600);
  });
});
