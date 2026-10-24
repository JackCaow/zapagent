import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export function verificationEnvironment(evidence: string, inherited = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key) || ["NPM_TOKEN", "NODE_AUTH_TOKEN", "BUN_AUTH_TOKEN", "NODE_PATH"].includes(key)) delete env[key];
  }
  const home = join(evidence, "home");
  mkdirSync(home, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  for (const [key, filename] of [["NPM_CONFIG_USERCONFIG", "empty.npmrc"], ["NPM_CONFIG_GLOBALCONFIG", "empty-global.npmrc"]]) {
    const config = join(evidence, filename!);
    writeFileSync(config, "");
    env[key!] = config;
  }
  return env;
}

export function consumerRuntimeEnvironment(location: string, cache: string, hashes: Record<string, string>): Record<string, string> {
  const prefix = join(location, "prefix");
  return { ZAPCODE_DATA_DIR: join(location, "data"), BUN_INSTALL_CACHE_DIR: cache,
    // BUN_INSTALL alone does not override globalDir/globalBinDir in bunfig or env.
    BUN_INSTALL: prefix, BUN_INSTALL_BIN: join(prefix, "bin"),
    BUN_INSTALL_GLOBAL_DIR: join(prefix, "install", "global"), ZAPAGENT_INK_HASHES: JSON.stringify(hashes) };
}

export function npmCommand(npmPath: string, node: string, platform = process.platform): string[] {
  // POSIX npm may be an asdf/mise shell shim or a native Volta shim, not JS.
  if (platform !== "win32") return [npmPath];
  const cli = join(dirname(npmPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(cli)) throw new Error("Cannot locate npm-cli.js");
  return [node, cli];
}

/** Cleanup must not turn a verified Windows install into a false failure:
 * Bun/AV can retain directory handles until the verifier itself exits. */
export async function cleanupVerificationDirectory(
  path: string,
  platform = process.platform,
  remove: (path: string) => Promise<void> = path => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
): Promise<{ path: string; code: string } | undefined> {
  try { await remove(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (platform === "win32" && code && ["EBUSY", "EPERM", "ENOTEMPTY"].includes(code)) return { path, code };
    throw error;
  }
}
