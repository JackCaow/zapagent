import { spawn } from "node:child_process"
import { join } from "node:path"
import { lstat } from "node:fs/promises"
import type { AppConfig } from "../config.js"
import { createExecutionEnvironment, resolveExecutionBackend } from "../execution-environment.js"
import { GoalBudgetLedger, type GoalBudgetRole } from "../../zapsdk/goal/budget.js"
import { prepareNpmOfflineInstall, createNpmVmWorkspace, importNpmVmWorkspace, cleanupNpmOfflineInstall, revalidateNpmOfflineInstall, assertNpmInputsUnchanged } from "../../zapsdk/goal/npm-installer.js"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import { discoverZapVmInstallation } from "../../zapsdk/execution/zapvm.js"
import { requireProcessSealing } from "../../zapsdk/execution/required-process-seal.js"
import { executeCommandTool } from "../../zapsdk/builtin-tools/command.js"
import { ToolExecutor } from "../../zapsdk/tools/executor.js"
import { ToolRegistry } from "../../zapsdk/tools/registry.js"
import { randomUUID } from "node:crypto"
import { copyPathOid, scanCopyTree } from "../../zapsdk/workspace/copy.js"

const command = "/usr/bin/env -i HOME=/tmp PATH=/usr/bin:/bin /usr/bin/npm ci --offline --ignore-scripts --no-audit --no-fund --no-progress --logs-max=0 --cache /workspace/.zapcode/cache --userconfig /workspace/.zapcode/user.npmrc --globalconfig /workspace/.zapcode/global.npmrc"

/** Called only before a private Goal/child lease becomes visible to its model,
 * or before a verifier starts. The enclosing Goal phase's durable ownership
 * marker is already recorded and remains until the entire phase finishes. */
export interface GoalNpmInstallProof { dependencyHash: string; manifestDigest: string; lockDigest: string }

export async function assertGoalNpmDependenciesUnchanged(cwd: string, proof: GoalNpmInstallProof): Promise<void> {
  await assertNpmInputsUnchanged(cwd, proof)
  const modules = join(cwd, "node_modules")
  await scanCopyTree(modules)
  if (await copyPathOid(modules, 0o700) !== proof.dependencyHash) throw new Error("GOAL_NPM_INSTALLATION_MODIFIED")
}

export async function installGoalNpmDependencies(input: { cwd: string; ledger: GoalBudgetLedger; goalId: string; epoch: number; role: GoalBudgetRole; config: AppConfig; signal?: AbortSignal }): Promise<GoalNpmInstallProof> {
  const admission = input.ledger.admit(input.goalId, input.epoch, { operationId: randomUUID(), role: input.role, kind: "tool", opaque: false })
  if (!admission.ok) throw new Error(`Goal npm installation admission denied: ${admission.reason}`)
  input.signal?.throwIfAborted()
  const installation = discoverZapVmInstallation()
  if (!installation || resolveExecutionBackend(input.config.executionBackend) !== "vm") throw new Error("GOAL_NPM_PROCESS_SEAL_UNSUPPORTED")
  const privateRoot = join(getAppDataDir(), "goal", "npm-preparations")
  const prepared = await prepareNpmOfflineInstall({ workspace: input.cwd, privateRoot, vmOnly: true, signal: input.signal })
  let completed = false
  try {
    const stage = await createNpmVmWorkspace(prepared)
    const environment = createExecutionEnvironment(stage.workspace, "required", "vm", false, undefined, [])
    if (environment.broker.supportsProcessSeal?.({ name: "bash", executionLocation: "workspace" }) !== true) throw new Error("GOAL_NPM_PROCESS_SEAL_UNSUPPORTED")
    const registry = new ToolRegistry()
    registry.register(executeCommandTool({ ...environment.commandOptions, defaultCwd: stage.workspace, timeoutMs: 120_000,
      disableBackgroundTasks: true, allowUnsandboxed: false, sandboxNetwork: false, restrictedNetwork: false, workspaceOnly: true }))
    let unconfirmed = false
    const executor = new ToolExecutor(registry, { cwd: stage.workspace, onApproval: async () => true,
      workspace: { root: stage.workspace, mode: "isolated-write", protectedWorkspacePaths: stage.protectedPaths },
      executionBroker: requireProcessSealing(environment.broker, () => { unconfirmed = true }) })
    const result = await executor.execute("bash", { command }, input.signal)
    const seal = result.runtime?.processSeal
    if (unconfirmed || !seal || seal.state !== "sealed" || !seal.executionId) throw new Error("GOAL_NPM_SEAL_UNCONFIRMED")
    if (!result.success || result.runtime?.command?.exitCode !== 0) throw new Error(`Goal npm offline install failed: ${result.error ?? result.output}`)
    input.signal?.throwIfAborted()
    await revalidateNpmOfflineInstall(prepared)
    const existing = join(prepared.workspace, "node_modules")
    const present = await lstat(existing).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (present) {
      // A copied child/verifier can already contain its parent's installation.
      // Trust it only when an independently sealed install produced identical
      // bytes and links; never delete or replace pre-existing user data.
      await scanCopyTree(join(stage.workspace, "node_modules"))
      await scanCopyTree(existing)
      // Import materializes the top-level directory as Host-private 0700;
      // compare normalized root mode while retaining all child modes.
      const stagedOid = await copyPathOid(join(stage.workspace, "node_modules"), 0o700)
      if (!stagedOid || stagedOid !== await copyPathOid(existing, 0o700)) throw new Error("Existing node_modules differs from the sealed npm installation; refusing to replace it")
    } else await importNpmVmWorkspace(prepared, stage, seal, seal.executionId, {
      // The lease is Host-owned and has not yet been exposed to a model or a
      // verifier; all work is serialized by the enclosing Goal phase.
      withExclusiveWorkspace: async (_workspace, action) => action(),
      publishNoReplace: (source, destination) => new Promise<void>((resolve, reject) => {
        const child = spawn(installation.binaryPath, ["_fs-publish-directory", "--source", source, "--destination", destination], { stdio: ["ignore", "ignore", "pipe"] })
        let stderr = ""
        child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += chunk })
        const abort = () => { child.kill("SIGKILL") }
        input.signal?.addEventListener("abort", abort, { once: true })
        if (input.signal?.aborted) abort()
        child.once("error", reject)
        child.once("close", code => { input.signal?.removeEventListener("abort", abort); code === 0 ? resolve() : reject(new Error(`Goal npm atomic import failed (${code}): ${stderr.slice(0, 1024)}`)) })
      }),
    })
    const installedOid = await copyPathOid(existing, 0o700)
    if (!installedOid) throw new Error("Goal npm installation disappeared after import")
    completed = true
    return { dependencyHash: installedOid, manifestDigest: prepared.manifestDigest, lockDigest: prepared.lockDigest }
  } finally {
    // An uncertain or interrupted operation is retained under the private
    // Goal directory, along with its durable phase marker and import journal.
    if (completed) await cleanupNpmOfflineInstall(prepared, privateRoot)
  }
}
