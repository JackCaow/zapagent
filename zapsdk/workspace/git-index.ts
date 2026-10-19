import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/** Copy index data only, without executing Git in a child-controlled repository.
 * A split index resolves its shared index beside this private copy. Files are
 * bounded, regular and opened without following links or waiting on FIFOs. */
export async function copyAgentIndex(repo: string, destination: string): Promise<string | undefined> {
  const directory = join(repo, ".git");
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
    throw new Error("Agent index requires a standalone Git directory");
  }
  let remaining = MAX_INDEX_BYTES;
  async function copy(name: string, optional = false): Promise<boolean> {
    const input = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error) => {
        if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
    if (!input) return false;
    try {
      const info = await input.stat();
      if (!info.isFile() || info.size > remaining) throw new Error("Agent Git index must be bounded regular data");
      const data = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await input.read(data, length, data.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size) throw new Error("Agent Git index changed while being copied");
      remaining -= length;
      await writeFile(join(destination, name), data.subarray(0, length), { flag: "wx", mode: 0o600 });
      return true;
    } finally { await input.close(); }
  }
  if (!await copy("index", true)) return undefined;
  const shared = (await readdir(directory)).filter(name => /^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(name));
  if (shared.length > 128) throw new Error("Too many shared Agent Git indexes");
  for (const name of shared) await copy(name);
  return join(destination, "index");
}

/** Git's index is untrusted data, not a source of path authority. */
export function agentIndexPaths(output: string): string[] {
  if (output && !output.endsWith("\0")) throw new Error("Truncated Agent Git file list");
  const paths = [...new Set(output.split("\0").filter(Boolean))];
  for (const path of paths) {
    if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes("\\")
      || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
      throw new Error(`Unsafe or unsupported Agent Git index path: ${path}`);
    }
  }
  return paths;
}
