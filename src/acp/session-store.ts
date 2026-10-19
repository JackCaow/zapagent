import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { RequestError, type SessionUpdate, type McpServer } from "@agentclientprotocol/sdk"
import { getAppDataDir } from "../../zapsdk/utils/platform.js"
import { writeFileAtomic } from "../utils/secure-write.js"
import type { PermissionMode } from "../config.js"

export interface AcpSession {
  version: 1
  id: string
  cwd: string
  providerId: string
  model: string
  mode: PermissionMode
  updatedAt: string
  title: string
  runtimeSessionId?: string
  history: SessionUpdate[]
}

export async function workspacePath(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw RequestError.invalidParams(null, "cwd must be absolute")
  try {
    const path = await realpath(cwd)
    if (!(await stat(path)).isDirectory()) throw new Error()
    return path
  } catch { throw RequestError.invalidParams(null, "cwd must be an existing directory") }
}

/** Only public session state is stored here. Provider secrets and MCP
 * credentials remain connection-scoped and are never copied into manifests. */
export class AcpSessionStore {
  constructor(readonly root = join(getAppDataDir(), "acp", "sessions")) {}

  create(cwd: string, providerId: string, model: string): AcpSession {
    const session: AcpSession = { version: 1, id: randomUUID(), cwd, providerId, model,
      mode: "default", updatedAt: new Date().toISOString(), title: "New session", history: [] }
    this.save(session)
    return session
  }

  save(session: AcpSession): void {
    session.updatedAt = new Date().toISOString()
    writeFileAtomic(this.path(session.id), JSON.stringify(session))
  }

  async load(id: string): Promise<AcpSession> {
    const path = this.path(id)
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as AcpSession
      if (value.version !== 1 || value.id !== id || !isAbsolute(value.cwd)
        || typeof value.model !== "string" || typeof value.providerId !== "string"
        || typeof value.title !== "string" || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
        || (value.runtimeSessionId !== undefined && typeof value.runtimeSessionId !== "string")
        || !["default", "plan", "acceptEdits"].includes(value.mode) || !Array.isArray(value.history)) throw new Error()
      return value
    } catch { throw RequestError.resourceNotFound(id) }
  }

  async list(): Promise<AcpSession[]> {
    await mkdir(this.root, { recursive: true })
    const sessions: AcpSession[] = []
    for (const file of await readdir(this.root)) {
      if (!file.endsWith(".json")) continue
      try { sessions.push(await this.load(file.slice(0, -5))) } catch { /* Corrupt entries are not selectable. */ }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw RequestError.invalidParams(null, "invalid session ID")
    return join(this.root, `${id}.json`)
  }
}

export interface LoadedAcpSession { state: AcpSession; mcpServers: McpServer[] }
