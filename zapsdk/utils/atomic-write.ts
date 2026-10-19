import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

export interface AtomicWriteOptions {
  mode?: number;
}

export async function writeFileAtomic(
  path: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, "wx", mode);
    await writeFile(handle, content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, path);
    await chmod(path, mode);
    await fsyncDirectoryBestEffort(dir);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export function writeFileAtomicSync(
  path: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? 0o600;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", mode);
    writeFileSync(fd, content, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    chmodSync(path, mode);
    fsyncDirectoryBestEffortSync(dir);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

async function fsyncDirectoryBestEffort(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every filesystem/platform.
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

function fsyncDirectoryBestEffortSync(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not supported on every filesystem/platform.
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}
