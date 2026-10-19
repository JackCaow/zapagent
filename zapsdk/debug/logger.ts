import { appendFile, chmod, readdir, unlink, mkdir, symlink, rm, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { getAppDataDir, IS_WINDOWS } from "../utils/platform.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  /** Max number of session log files to keep (default: 20) */
  maxFiles?: number;
}

export class Logger {
  readonly logFile: string;
  private queue: string[] = [];
  private flushing = false;
  private closed = false;
  private readonly initPromise: Promise<void>;

  constructor(options: LoggerOptions = {}) {
    const maxFiles = options.maxFiles ?? 20;
    this.logFile = resolveLogFile();
    this.initPromise = this.init(maxFiles);
  }

  /** Write a log entry (non-blocking) */
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    this.queue.push(JSON.stringify(entry) + "\n");
    void this.drain();
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  /** Wait for all pending writes to complete */
  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.flushing) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Stop accepting new entries and flush */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      await this.initPromise;
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length).join("");
        await appendFile(this.logFile, batch, { encoding: "utf-8", mode: 0o600 });
        await chmodBestEffort(this.logFile, 0o600);
      }
    } catch {
      // Log write failures are silent — never crash the main process
    } finally {
      this.flushing = false;
    }
  }

  private async init(maxFiles: number): Promise<void> {
    try {
      const logsDir = join(getAppDataDir(), "logs");
      await mkdir(logsDir, { recursive: true });
      await chmodBestEffort(logsDir, 0o700);
      // Update latest.log pointer (symlink on Unix, copy on Windows)
      const latestLink = join(logsDir, "latest.log");
      try { await rm(latestLink); } catch {}
      if (IS_WINDOWS) {
        // Symlinks require admin on Windows — copy the file instead
        // We schedule a copy after a short delay so the file exists first
        setTimeout(() => { void copyFile(this.logFile, latestLink).catch(() => {}); }, 500);
      } else {
        try { await symlink(this.logFile, latestLink); } catch {}
      }
      // Rotate: delete oldest files beyond maxFiles
      await rotate(logsDir, maxFiles);
    } catch {}
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveLogFile(): string {
  const logsDir = join(getAppDataDir(), "logs");
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const id = randomBytes(4).toString("hex");
  return join(logsDir, `${ts}_${id}.log`);
}

async function rotate(logsDir: string, maxFiles: number): Promise<void> {
  try {
    const entries = await readdir(logsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".log") && e.name !== "latest.log")
      .map((e) => e.name)
      .sort(); // ISO timestamps sort lexicographically = chronologically

    const excess = files.length - maxFiles;
    for (let i = 0; i < excess; i++) {
      await unlink(join(logsDir, files[i])).catch(() => {});
    }
  } catch {}
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  if (IS_WINDOWS) return;
  try { await chmod(path, mode); } catch {}
}
