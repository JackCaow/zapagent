import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface DetectedProvider {
  name: "claude" | "codex";
  bin: string;
  version?: string;
}

export interface DetectProvidersOptions {
  pathEnv?: string;
}

async function which(name: string, pathEnv = process.env.PATH ?? ""): Promise<string | null> {
  if (isAbsolute(name)) {
    return await isExecutable(name) ? name : null;
  }
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32"
    ? windowsCandidates(name)
    : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const file = join(dir, candidate);
      if (await isExecutable(file)) return file;
    }
  }
  return null;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsCandidates(name: string): string[] {
  if (/\.[^\\/]+$/.test(name)) return [name];
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [name, ...exts.map((ext) => `${name}${ext.toLowerCase()}`), ...exts.map((ext) => `${name}${ext.toUpperCase()}`)];
}

export async function detectProviders(timeoutMsOrOptions: number | DetectProvidersOptions = 2000): Promise<DetectedProvider[]> {
  const options = typeof timeoutMsOrOptions === "number" ? {} : timeoutMsOrOptions;
  const [claudeBin, codexBin] = await Promise.all([
    which("claude", options.pathEnv),
    which("codex", options.pathEnv),
  ]);
  const out: DetectedProvider[] = [];
  if (claudeBin) out.push({ name: "claude", bin: claudeBin });
  if (codexBin) out.push({ name: "codex", bin: codexBin });
  return out;
}
