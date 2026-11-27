import { readFileSync, realpathSync, statSync, unlinkSync, unwatchFile, watchFile } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { canonicalizeWithNearestExistingAncestorSync } from "../zapsdk/builtin-tools/filesystem.js"
import type { PermissionMode } from "./config.js"
import { getProjectAuthorizationSettingsPath } from "./permissions.js"
import { writeFileAtomic } from "./utils/secure-write.js"

export type WorkspaceChoice = "task" | "project" | "analyze" | "revoke"

/** Only the interactive host issues these grants. A checkout cannot supply its own. */
export class WorkspaceAccess {
  private readonly root: string
  private readonly record: string
  private nextTask?: { session: string; prompt?: string; entryId?: string }
  private onGrantChange?: () => void
  private active?: { session: string; run: string; write: boolean; project: boolean }

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

  choose(choice: WorkspaceChoice, session: string, prompt?: string): void {
    if (choice === "project") {
      if (!this.recordOutsideWorkspace()) throw new Error("Project access must be saved outside the workspace. Use access for this task.")
      writeFileAtomic(this.record, JSON.stringify(this.identity()) + "\n")
    }
    if (choice === "revoke" && this.recordOutsideWorkspace()) {
      try { unlinkSync(this.record) }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err }
    }
    const write = choice === "project" || choice === "task"
    if (this.active?.session === session) this.active.write = write
    this.nextTask = !this.active && choice === "task" ? { session, prompt } : undefined
  }

  bindSubmission(session: string, entryId: string, text: string, display: string): void {
    const next = this.nextTask
    if (next?.session === session && !next.entryId && (!next.prompt || next.prompt === text || next.prompt === display)) {
      this.nextTask = { session, prompt: text, entryId }
    }
  }

  begin(session: string, run: string, userInitiated: boolean, prompt: string, entryId?: string, onProjectRevoked?: () => void): void {
    if (this.active) throw new Error("Another workspace task is still running")
    const next = this.nextTask
    const matches = userInitiated && !!entryId && next?.session === session && next.entryId === entryId && next.prompt === prompt
    const project = userInitiated && !matches && this.remembered()
    const active = this.active = { session, run, write: project || matches, project }
    if (project && onProjectRevoked) {
      this.onGrantChange = () => {
        if (this.active !== active || !active.write || this.remembered()) return
        active.write = false
        onProjectRevoked()
      }
      watchFile(this.record, { persistent: false, interval: 250 }, this.onGrantChange)
      this.onGrantChange()
    }
    if (matches || next?.session !== session) this.nextTask = undefined
  }

  get activeRun(): string | undefined { return this.active?.run }

  assertProjectCommandAllowed(base: PermissionMode, session: string, run: string): void {
    const active = this.active
    if (!active || active.run !== run || active.session !== session || this.mode(base, session, run) !== "acceptEdits"
      || (base === "default" && active.project && !this.remembered())) {
      throw new Error("This task no longer has project command access")
    }
  }

  approvePlan(session: string): void {
    if (this.active?.session === session) this.active.write = true
  }

  end(run: string): void {
    if (this.active?.run !== run) return
    if (this.onGrantChange) unwatchFile(this.record, this.onGrantChange)
    this.onGrantChange = undefined
    this.active = undefined
  }

  canWork(session: string, remembered: boolean): boolean {
    return this.active ? this.active.session === session && this.active.write : this.nextTask?.session === session || remembered
  }

  mode(base: PermissionMode, session: string, actorRun?: string): PermissionMode {
    if (actorRun && (actorRun !== this.active?.run || session !== this.active?.session)) return "plan"
    if (base !== "default" || !this.active) return base
    return this.active.session === session && this.active.write ? "acceptEdits" : "plan"
  }
}
