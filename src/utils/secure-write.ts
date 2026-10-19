import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { basename, dirname, join } from "node:path"

export interface SecureWriteOptions {
  mode?: number
}

export function writeFileAtomic(path: string, content: string, options: SecureWriteOptions = {}): void {
  const mode = options.mode ?? 0o600
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(tmp, "wx", mode)
    writeFileSync(fd, content, "utf-8")
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
    chmodSync(path, mode)
    fsyncDirectoryBestEffort(dir)
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    throw err
  }
}

function fsyncDirectoryBestEffort(dir: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dir, "r")
    fsyncSync(fd)
  } catch {
    // Some platforms/filesystems reject directory fsync. File fsync + rename
    // still avoids torn file contents; directory fsync is a best-effort bonus.
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}
