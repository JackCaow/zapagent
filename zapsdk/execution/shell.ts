/** The local command interpreter, independent of the user's login terminal.
 * Keep launchers and model-visible environment descriptions on this contract. */
export function localExecutionShell(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): { executable: string; argsPrefix: string[] } {
  return platform === "win32"
    ? { executable: environment.ComSpec ?? "cmd.exe", argsPrefix: ["/d", "/s", "/c"] }
    : { executable: "/bin/sh", argsPrefix: ["-c"] };
}
