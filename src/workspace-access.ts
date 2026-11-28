import { randomUUID } from "node:crypto"
import { readFileSync, realpathSync, statSync, unlinkSync, unwatchFile, watchFile } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { canonicalizeWithNearestExistingAncestorSync } from "../zapsdk/builtin-tools/filesystem.js"
import type { PermissionMode } from "./config.js"
import type { ApprovalCallback, ApprovalContext, ApprovalResponse } from "../zapsdk/tools/executor.js"
import { getProjectAuthorizationSettingsPath } from "./permissions.js"
import { writeFileAtomic } from "./utils/secure-write.js"

export type WorkspaceChoice = "project" | "analyze" | "revoke"
type TurnOrigin = { kind: "user" } | { kind: "task"; ids: readonly string[] }
type ProjectIdentity = { root: string; device: string; inode: string }
type WorkGrant = { projectId?: string }

export interface WorkspaceRun {
  actor: { id: string; kind: "root"; runId: string }
  signal: AbortSignal
  mode: PermissionMode
  assertActive(): void
  bindApproval(approve: ApprovalCallback | undefined): ApprovalCallback
}

/** Only the interactive host issues these grants. A checkout cannot supply its own. */
export class WorkspaceAccess {
  private readonly root: string
  private readonly record: string
  private readonly taskContinuations = new Map<string, {
    session: string; workspace: ProjectIdentity; grant: WorkGrant; signal: AbortSignal
  }>()
  private active?: { session: string; run: string; grant?: WorkGrant; revocation: AbortController }
  private watchedGrant?: string

  constructor(cwd: string) {
    this.root = realpathSync(cwd)
    this.record = join(dirname(getProjectAuthorizationSettingsPath(this.root)), "workspace-access.json")
  }

  private identity() {
    const stat = statSync(this.root, { bigint: true })
    return { version: 2, root: this.root, device: String(stat.dev), inode: String(stat.ino), capability: "host-commands" }
  }

  private recordOutsideWorkspace(): boolean {
    const path = relative(this.root, canonicalizeWithNearestExistingAncestorSync(this.record))
    return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
  }

  private projectGrant(): string | undefined {
    try {
      if (!this.recordOutsideWorkspace()) return
      const grant = JSON.parse(readFileSync(this.record, "utf8"))
      if (typeof grant?.id === "string" && grant.id && Object.entries(this.identity()).every(([key, value]) => grant[key] === value)) return grant.id
    } catch { /* An unreadable or outdated record grants nothing. */ }
  }

  remembered(): boolean { return this.projectGrant() !== undefined }

  choose(choice: WorkspaceChoice, session: string): void {
    if (choice === "project") {
      if (!this.recordOutsideWorkspace()) throw new Error("Project access must be saved outside the workspace.")
      let projectId = this.projectGrant()
      if (!projectId) {
        projectId = randomUUID()
        writeFileAtomic(this.record, JSON.stringify({ ...this.identity(), id: projectId }) + "\n")
      }
      this.watchedGrant ??= projectId
      if (this.active?.session === session && !this.active.grant?.projectId && !this.active.revocation.signal.aborted) {
        this.active.grant = { projectId }
      }
    }
    if (choice === "revoke" && this.recordOutsideWorkspace()) {
      try { unlinkSync(this.record) }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err }
      this.watchedGrant = undefined
    }
    if (choice !== "project") this.revoke(session)
  }

  private revoke(session: string): void {
    this.clearTaskContinuations()
    if (this.active?.session !== session) return
    this.active.grant = undefined
    this.active.revocation.abort()
  }

  watchProject(session: () => string, onRevoked: () => void): () => void {
    this.watchedGrant ??= this.projectGrant()
    const check = () => {
      const grant = this.projectGrant()
      const previous = this.watchedGrant
      this.watchedGrant = grant
      if (!previous || grant === previous) return
      this.revoke(session())
      onRevoked()
    }
    watchFile(this.record, { persistent: false, interval: 250 }, check)
    check()
    return () => unwatchFile(this.record, check)
  }

  rememberTask(id: string, session: string, signal: AbortSignal): void {
    if (!this.active?.grant || this.active.session !== session || this.active.revocation.signal.aborted || signal.aborted) return
    try {
      this.taskContinuations.set(id, { session, workspace: this.identity(), grant: this.active.grant, signal })
    } catch { /* A missing workspace cannot authorize a later turn. */ }
  }

  consumeTasks(ids: readonly string[]): void {
    for (const id of ids) this.taskContinuations.delete(id)
  }

  clearTaskContinuations(): void { this.taskContinuations.clear() }

  private canResume(session: string, ids: readonly string[], projectId: string | undefined): boolean {
    if (!ids.length) return false
    try {
      const { root, device, inode } = this.identity()
      return ids.every(id => {
        const grant = this.taskContinuations.get(id)
        return grant?.session === session && !grant.signal.aborted && grant.grant.projectId === projectId
          && grant.workspace.root === root && grant.workspace.device === device && grant.workspace.inode === inode
      })
    } catch { return false }
  }

  begin(session: string, run: string, base: PermissionMode, origin: TurnOrigin): WorkspaceRun {
    if (this.active) throw new Error("Another workspace task is still running")
    const { device, inode } = this.identity()
    const projectId = base === "plan" ? undefined : this.projectGrant()
    const eligible = base !== "plan" && (origin.kind === "user" || this.canResume(session, origin.ids, projectId))
    const grant = eligible ? { projectId } : undefined
    // Track an adopted grant even if the watcher has not observed its creation.
    if (grant) this.watchedGrant ??= projectId
    const active = this.active = { session, run, grant, revocation: new AbortController() }
    const actor = Object.freeze({ id: session, kind: "root" as const, runId: run })
    const signal = active.revocation.signal
    const valid = () => {
      if (this.active !== active || signal.aborted) return false
      try {
        const identity = this.identity()
        if (identity.device === device && identity.inode === inode && (!active.grant?.projectId || this.projectGrant() === active.grant.projectId)) return true
      } catch { /* A missing workspace also invalidates the current turn. */ }
      this.revoke(session)
      return false
    }
    const denied: ApprovalResponse = { approved: false, source: "policy", reason: "This workspace turn no longer has authorization" }
    return {
      actor,
      signal,
      mode: this.mode(base, session, run),
      assertActive: () => {
        if (!valid()) throw new Error(denied.reason)
      },
      bindApproval: approve => {
        const withActor = (context?: Readonly<ApprovalContext>): ApprovalContext => ({
          cwd: this.root, workspaceRoot: this.root, shell: { syntax: "unknown", filesystem: "host" }, ...context, actor,
        })
        return Object.assign(
          async (name: string, args: Record<string, unknown>, request?: AbortSignal, context?: Readonly<ApprovalContext>) => {
            if (!approve || !valid() || request?.aborted) return denied
            const live = request ? AbortSignal.any([request, signal]) : signal
            const decision = await approve(name, args, live, withActor(context))
            return valid() && !live.aborted ? decision : denied
          },
          { precheck: (name: string, args: Record<string, unknown>, context?: Readonly<ApprovalContext>) =>
            approve && valid() ? approve.precheck?.(name, args, withActor(context)) : denied },
        )
      },
    }
  }

  end(run: string): void {
    if (this.active?.run !== run) return
    this.active = undefined
  }

  canRunHostCommands(session: string, run?: string): boolean {
    const active = this.active
    return !!run && active?.run === run && active.session === session && !!active.grant?.projectId
      && !active.revocation.signal.aborted && this.projectGrant() === active.grant.projectId
  }

  mode(base: PermissionMode, session: string, actorRun?: string): PermissionMode {
    if (actorRun && (actorRun !== this.active?.run || session !== this.active?.session
      || this.active.revocation.signal.aborted || !this.active.grant || (!!this.active.grant.projectId && this.projectGrant() !== this.active.grant.projectId))) return "plan"
    if (!this.active) return base === "auto" ? "default" : base
    if (this.active.session !== session || !this.active.grant) return "plan"
    return base === "auto" ? "acceptEdits" : base
  }
}
