import type { ExecutionEnvironmentFacts } from "../../zapsdk/execution/types.js"

/** Render Host facts consistently in standard and custom system prompts. */
export function sandboxTemporaryDirectoryDescription(facts?: ExecutionEnvironmentFacts): string[] {
  const directory = facts?.sandboxTemporaryDirectory
  if (!directory) return []
  const variable = facts.processPlatform === "win32" ? "%TEMP%" : "$TMPDIR"
  return [
    `Sandboxed shell scratch space: ${directory.environmentVariables.join(", ")} point to a private writable directory. Use ${variable} instead of hard-coded /tmp paths or project files for disposable work.`,
    directory.scope === "workspace"
      ? "Scratch, private HOME and caches persist across commands in this workspace's managed storage. Use unique temporary names and remove disposable files when done; the OS may clear scratch. Other workspaces have separate storage. Host credentials are not copied. Approved unsandboxed commands use the host environment; other filesystem access follows runtime grants."
      : "This directory belongs to one shell command and is removed when that command finishes. Create and consume scratch files in the same invocation; separate Bash calls and check_steps entries do not share it. These facts do not apply to approved unsandboxed commands; other filesystem access still follows runtime grants.",
  ]
}
