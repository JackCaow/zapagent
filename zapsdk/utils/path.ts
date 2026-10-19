import { homedir } from "node:os";
import { detectPlatform, type PlatformInfo } from "./platform.js";

/**
 * 跨平台路径工具。
 *
 * 当前 surface 故意留得很小——只暴露目前真正有 caller 的方法。
 * 历史上有过一批 normalize/toNative/toURL/toWSLPath/… 的辅助方法，但都没有
 * caller、也没有测试覆盖，最终在清理时删除。新增方法之前请确保有调用方和测试。
 */
export class PathConverter {
  // Lazy: 通过 getter 读 detectPlatform() 的缓存——避免在 module load 期间触发
  // 子进程探测。
  private get platformInfo(): PlatformInfo {
    return detectPlatform();
  }

  /**
   * 展开 ~ 为用户主目录（仅支持 bare ~，不支持 ~user 形式）。
   *
   * Unix shell 约定，`node:fs` 不会自动应用，所以接收模型给出的原始路径参数的
   * 工具如果不自己展开，就会在 `~/foo` 上静默失败。
   */
  expandTilde(path: string): string {
    if (!path) return path;
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return homedir() + path.slice(1);
    // Windows backslash form: `~\foo` — preserve original separator.
    if (process.platform === "win32" && path.startsWith("~\\")) {
      return homedir() + path.slice(1);
    }
    return path;
  }

  /** 当前平台的空设备路径 (Windows: `NUL`, Unix: `/dev/null`)。 */
  getDevNull(): string {
    return this.platformInfo.features.devNull;
  }

  /**
   * 将命令中重定向到 /dev/null 的部分替换为平台空设备 (NUL)。
   * 防止 cmd.exe 把 `/dev/null` 当成相对路径，在 CWD 下创建出 `dev/null` 文件。
   *
   * 仅匹配 *重定向上下文* (`> /dev/null`、`2>/dev/null`、`&>/dev/null` 等)，
   * 避免误改 `echo "/dev/null"` 这类引号或字面用法。注意：本函数不解析引号，
   * 所以引号内的重定向字面量（罕见）仍会被改写——这是已知折衷。
   *
   * 限制：默认假设命令在 cmd.exe 上执行。若要走 Git Bash / WSL，调用方应跳过
   * 本步骤（`/dev/null` 在那些 shell 下是合法的）。
   */
  sanitizeDevNull(command: string): string {
    return rewriteDevNullRedirects(command, this.getDevNull());
  }
}

/**
 * Pure rewriter — exported so tests can drive it with an explicit devNull
 * value (otherwise the test result depends on the host platform).
 *
 * Rewrites `<redirect-op> /dev/null` to `<redirect-op> <devNull>`.
 * Returns input unchanged when devNull is already `/dev/null` (Unix host).
 */
export function rewriteDevNullRedirects(command: string, devNull: string): string {
  if (devNull === "/dev/null") return command;
  // 重定向操作符：>、>>、<、N>、N>>、&>，可选空白后跟 /dev/null
  return command.replace(
    /(\d?>>?|&>|<)\s*\/dev\/null\b/g,
    (_, op) => `${op} ${devNull}`,
  );
}

// 导出单例方便使用
export const pathConverter = new PathConverter();

/**
 * 兼容旧 API: 展开 ~ 为用户主目录
 */
export function expandHome(path: string): string {
  return pathConverter.expandTilde(path);
}
