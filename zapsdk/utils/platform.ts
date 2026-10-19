import { platform, homedir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type OS = "macos" | "linux" | "windows" | "wsl" | "unknown";

export type PlatformFeatures = {
  /** 符号链接支持 */
  symlinks: boolean;
  /** 文件系统是否区分大小写 */
  caseSensitive: boolean;
  /** 原生系统通知 */
  nativeNotify: boolean;
  /** 文件系统事件 (macOS FSEvents / Linux inotify) */
  fsEvents: boolean;
  /** Unix 权限模型 (Windows 无 chmod/chown) */
  permissions: boolean;
  /** Windows 可执行文件扩展名 */
  executableExtensions: string[];
  /** 路径分隔符 */
  pathSeparator: string;
  /** PATH 环境变量分隔符 */
  pathDelimiter: string;
  /** 空设备路径 */
  devNull: string;
};

export type PlatformInfo = {
  /** 平台类型 */
  platform: OS;
  /** Node.js 版本 */
  nodeVersion: string;
  /** CPU 架构 */
  arch: string;
  /** 是否为 WSL */
  isWSL: boolean;
  /** 是否为 Git Bash on Windows */
  isBashOnWindows: boolean;
  /** 功能特性 */
  features: PlatformFeatures;
};

// 缓存检测结果（避免重复检测）
let _cachedPlatformInfo: PlatformInfo | null = null;

export function getOS(): OS {
  switch (platform()) {
    case "darwin": return "macos";
    case "linux": {
      // 检测 WSL
      if (isWSL()) return "wsl";
      return "linux";
    }
    case "win32": return "windows";
    default:       return "unknown";
  }
}

/**
 * 检测是否为 WSL (Windows Subsystem for Linux)。
 * 只在 Linux 平台上做实际探测——其它平台直接返回 false，避免无谓的 fs/子进程开销。
 */
export function isWSL(): boolean {
  if (process.platform !== "linux") return false;

  // 环境变量是 WSL2 上最便宜也最可靠的信号
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;

  // 回退到 /proc/version (WSL1 + 旧版 WSL2)
  try {
    const version = readFileSync("/proc/version", "utf-8");
    if (version.includes("Microsoft") || version.includes("WSL")) return true;
  } catch {}

  return false;
}

/**
 * 完整的平台信息检测
 */
export function detectPlatform(): PlatformInfo {
  if (_cachedPlatformInfo) return _cachedPlatformInfo;

  const os = platform();
  const arch = process.arch;
  const nodeVersion = process.version;

  // 检测 WSL
  const isWSLDetected = isWSL();

  // 检测 Git Bash on Windows
  const isBashOnWindows = os === "win32" && !!process.env.SHELL?.includes("bash");

  // 检测功能特性
  const features: PlatformFeatures = {
    // Windows 上需要管理员/开发者模式才能创建 symlink；保守按 false 处理
    symlinks: os !== "win32",
    caseSensitive: os !== "win32" && os !== "darwin",
    nativeNotify: os === "darwin" || os === "linux" || os === "win32",
    fsEvents: os === "darwin" || os === "linux",
    permissions: os !== "win32",
    executableExtensions: os === "win32" ? [".exe", ".cmd", ".bat", ".ps1"] : [],
    pathSeparator: os === "win32" ? "\\" : "/",
    pathDelimiter: os === "win32" ? ";" : ":",
    devNull: os === "win32" ? "NUL" : "/dev/null",
  };

  let normalizedPlatform: OS = "unknown";
  if (os === "win32") {
    normalizedPlatform = "windows";
  } else if (os === "darwin") {
    normalizedPlatform = "macos";
  } else if (os === "linux") {
    normalizedPlatform = isWSLDetected ? "wsl" : "linux";
  }

  _cachedPlatformInfo = {
    platform: normalizedPlatform,
    nodeVersion,
    arch,
    isWSL: isWSLDetected,
    isBashOnWindows,
    features,
  };

  return _cachedPlatformInfo;
}

export const IS_WINDOWS = platform() === "win32";
export const IS_MACOS   = platform() === "darwin";
export const IS_LINUX   = platform() === "linux";

/**
 * Detect the user's current shell name (e.g. "zsh", "bash", "fish", "PowerShell", "cmd").
 */
export function detectShell(): string {
  if (IS_WINDOWS) {
    // Check for PowerShell first (PSModulePath is set by PowerShell)
    if (process.env.PSModulePath) return "PowerShell";
    const comspec = process.env.COMSPEC ?? "cmd.exe";
    return basename(comspec, ".exe");
  }
  const shell = process.env.SHELL ?? "/bin/sh";
  return basename(shell); // "zsh", "bash", "fish", etc.
}

/**
 * Copy text to the system clipboard.
 * Returns true on success, false if no clipboard tool is available.
 */
export function copyToClipboard(text: string): boolean {
  const opts = { input: text, stdio: ["pipe", "ignore", "ignore"] as ["pipe", "ignore", "ignore"] };
  try {
    if (IS_MACOS) {
      execSync("pbcopy", opts);
      return true;
    }
    if (IS_WINDOWS) {
      execSync("clip", opts);
      return true;
    }
    // Linux: try Wayland then X11
    try { execSync("wl-copy", opts); return true; } catch {}
    try { execSync("xclip -selection clipboard", opts); return true; } catch {}
    try { execSync("xsel --clipboard --input", opts); return true; } catch {}
    return false;
  } catch {
    return false;
  }
}

/**
 * Return the platform-appropriate base data directory for zapcode.
 *   $ZAPCODE_DATA_DIR — explicit override (used by tests, CI, sandboxed runs)
 *   Windows  → %APPDATA%\zapcode   (or %USERPROFILE%\.zapcode as fallback)
 *   Linux    → $XDG_DATA_HOME/zapcode  (or ~/.local/share/zapcode)
 *   macOS    → ~/.zapcode
 */
export function getAppDataDir(): string {
  // Reject empty string explicitly — `export ZAPCODE_DATA_DIR=$TYPO`
  // (typo'd var → "") should fall through to the OS default, not silently
  // anchor to "" or process.cwd().
  const override = process.env.ZAPCODE_DATA_DIR
  if (override !== undefined && override !== "") return override
  if (IS_WINDOWS) {
    const appdata = process.env.APPDATA
    return appdata ? join(appdata, "zapcode") : join(homedir(), ".zapcode")
  }
  if (IS_LINUX) {
    const xdg = process.env.XDG_DATA_HOME
    return xdg ? join(xdg, "zapcode") : join(homedir(), ".local", "share", "zapcode")
  }
  // macOS — keep legacy path for backwards compat
  return join(homedir(), ".zapcode")
}
