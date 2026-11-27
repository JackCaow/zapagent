import { readFileSync, realpathSync, statSync, unlinkSync, unwatchFile, watchFile } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { canonicalizeWithNearestExistingAncestorSync } from "../zapsdk/builtin-tools/filesystem.js"
import type { PermissionMode } from "./config.js"
import { getProjectAuthorizationSettingsPath } from "./permissions.js"
import { writeFileAtomic } from "./utils/secure-write.js"

export type WorkspaceChoice = "project" | "analyze" | "revoke"
type TurnOrigin = { kind: "user" } | { kind: "task"; ids: readonly string[] }
type ProjectIdentity = { root: string; device: string; inode: string }
type WorkGrant = "auto" | "project" | "approved-plan"

/** Only the interactive host issues these grants. A checkout cannot supply its own. */
export class WorkspaceAccess {
  private readonly root: string
  private readonly record: string
  private readonly taskContinuations = new Map<string, {
    session: string; workspace: ProjectIdentity; signal: AbortSignal
  }>()
  private onGrantChange?: () => void
  private active?: { session: string; run: string; grant?: WorkGrant }

  constructor(cwd: string) {
    this.root = realpathSync(cwd)
    this.record = join(dirname(getProjectAuthorizationSettingsPath(this.root)), "workspace-access.json")
  }

  private identity() {
    const stat = statSync(this.root, { bigint: true })
    return { version: 1, root: this.root, device: String(stat.dev), inode: String(stat.ino), capability: "workspace-work" }
  }

  private recordOutsideWorkspace(): boolean {
    const path = relative(this.root, canonicalizeWithNearestExistingAncestorSync(this.record))
    return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
  }

  remembered(): boolean {
    try {
      if (!this.recordOutsideWorkspace()) return false
      const grant = JSON.parse(readFileSync(this.record, "utf8"))
      return Object.entries(this.identity()).every(([key, value]) => grant?.[key] === value)
    } catch { return false }
  }

  choose(choice: WorkspaceChoice, session: string): void {
    if (choice === "project") {
      if (!this.recordOutsideWorkspace()) throw new Error("Project access must be saved outside the workspace.")
      writeFileAtomic(this.record, JSON.stringify(this.identity()) + "\n")
    }
    if (choice === "revoke" && this.recordOutsideWorkspace()) {
      try { unlinkSync(this.record) }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err }
    }
    if (choice !== "project") this.clearTaskContinuations()
    if (this.active?.session === session && choice !== "project") this.active.grant = undefined
  }

  rememberTask(id: string, session: string, signal: AbortSignal): void {
    if (this.active?.grant !== "auto" || this.active.session !== session || signal.aborted) return
    try {
      this.taskContinuations.set(id, { session, workspace: this.identity(), signal })
    } catch { /* A missing workspace cannot authorize a later turn. */ }
  }

  consumeTasks(ids: readonly string[]): void {
    for (const id of ids) this.taskContinuations.delete(id)
  }

  clearTaskContinuations(): void { this.taskContinuations.clear() }

  private canResume(session: string, ids: readonly string[]): boolean {
    if (!ids.length) return false
    try {
      const { root, device, inode } = this.identity()
      return ids.every(id => {
        const grant = this.taskContinuations.get(id)
        return grant?.session === session && !grant.signal.aborted
          && grant.workspace.root === root && grant.workspace.device === device && grant.workspace.inode === inode
      })
    } catch { return false }
  }

  begin(session: string, run: string, base: PermissionMode, origin: TurnOrigin, onProjectRevoked?: () => void): void {
    if (this.active) throw new Error("Another workspace task is still running")
    const project = base === "default" && origin.kind === "user" && this.remembered()
    const auto = base === "auto" && (origin.kind === "user" || this.canResume(session, origin.ids))
    const active = this.active = { session, run, grant: auto ? "auto" : project ? "project" : undefined }
    if (project && onProjectRevoked) {
      this.onGrantChange = () => {
        if (this.active !== active || active.grant !== "project" || this.remembered()) return
        active.grant = undefined
        onProjectRevoked()
      }
      watchFile(this.record, { persistent: false, interval: 250 }, this.onGrantChange)
      this.onGrantChange()
    }
  }

  get activeRun(): string | undefined { return this.active?.run }

  assertProjectCommandAllowed(base: PermissionMode, session: string, run: string): void {
    const active = this.active
    if (!active || active.run !== run || active.session !== session || this.mode(base, session, run) !== "acceptEdits"
      || (base === "default" && active.grant === "project" && !this.remembered())) {
      throw new Error("This task no longer has project command access")
    }
  }

  approvePlan(session: string): void {
    if (this.active?.session === session && !this.active.grant) this.active.grant = "approved-plan"
  }

  end(run: string): void {
    if (this.active?.run !== run) return
    if (this.onGrantChange) unwatchFile(this.record, this.onGrantChange)
    this.onGrantChange = undefined
    this.active = undefined
  }

  canWork(session: string, remembered: boolean): boolean {
    return this.active ? this.active.session === session && !!this.active.grant : remembered
  }

  mode(base: PermissionMode, session: string, actorRun?: string): PermissionMode {
    if (actorRun && (actorRun !== this.active?.run || session !== this.active?.session)) return "plan"
    if (base === "auto") {
      if (!this.active) return "default"
      return this.active.session === session && this.active.grant === "auto" ? "acceptEdits" : "plan"
    }
    if (base !== "default" || !this.active) return base
    return this.active.session === session && this.active.grant && this.active.grant !== "auto" ? "acceptEdits" : "plan"
  }
}
