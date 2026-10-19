import { afterEach, describe, it, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __test,
  parseSessionJsonl,
  parseLatestUsageJsonl,
  parseRecentUsageJsonl,
  resolveRestoredUsageContext,
  resolveUnmeasuredUsageContext,
  setSessionDiagnostics,
  sessionLogsToMessages,
  type SessionLog,
  type SessionDiagnostics,
} from "../src/session.js"

// NOTE: snapshot/rewind-marker JSONL roundtrip is covered by
// zapsdk/checkpoint/integration.test.ts (uses a throwaway tmpdir blobDir).
// We deliberately do NOT exercise the session.ts singleton here because it
// writes into the real ~/.zapcode/projects/<proj>/ directory — leaking test
// fixtures into the user's actual session list.

let restoreDiagnostics: SessionDiagnostics | null | undefined

afterEach(() => {
  if (restoreDiagnostics !== undefined) {
    setSessionDiagnostics(restoreDiagnostics)
    restoreDiagnostics = undefined
  }
})

describe("project session directory resolution", () => {
  it("deletes persisted tool outputs with their owning saved session", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-delete-"))
    try {
      const script = [
        'import { dirname, join } from "node:path";',
        'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
        'import { resolveProjectDataSegment } from "./zapsdk/utils/project-paths.ts";',
        'import { maybePersistToolResult } from "./zapsdk/utils/tool-result-storage.ts";',
        'import { deleteSavedSession } from "./src/session.ts";',
        'const id = "session-delete-test";',
        'const projectDir = join(process.env.ZAPCODE_DATA_DIR, "projects", resolveProjectDataSegment(process.cwd()));',
        'mkdirSync(projectDir, { recursive: true });',
        'const sessionPath = join(projectDir, `${id}.jsonl`);',
        'writeFileSync(sessionPath, "{}\\n");',
        'const output = maybePersistToolResult("tool-1", id, "bash", "full output", { force: true });',
        'const outputDir = dirname(output.persistedPath);',
        'deleteSavedSession(id);',
        'console.log(JSON.stringify({ sessionExists: existsSync(sessionPath), outputExists: existsSync(outputDir) }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        sessionExists: false,
        outputExists: false,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("initializes default session directories with owner-only permissions", () => {
    if (process.platform === "win32") return
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-private-"))
    try {
      const script = [
        'import { statSync } from "node:fs";',
        'import { join } from "node:path";',
        'await import("./src/session.ts");',
        'const dataDir = process.env.ZAPCODE_DATA_DIR;',
        'const result = {',
        '  app: statSync(dataDir).mode & 0o777,',
        '  projects: statSync(join(dataDir, "projects")).mode & 0o777,',
        '  skills: statSync(join(dataDir, "skills")).mode & 0o777,',
        '};',
        'console.log(JSON.stringify(result));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        app: 0o700,
        projects: 0o700,
        skills: 0o700,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("uses git-backed active dir while retaining legacy cwd dir for reads", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-dirs-"))
    const repo = mkdtempSync(join(tmpdir(), "zap-session-repo-"))
    try {
      git(repo, "init")
      git(repo, "remote", "add", "origin", "https://github.com/acme/zapcode.git")

      const dirs = __test.resolveProjectSessionDirs(dataDir, repo)

      expect(dirs).toHaveLength(2)
      expect(dirs[0]).toContain(join(dataDir, "projects", "git-zapcode-"))
      expect(dirs[1]).toBe(join(dataDir, "projects", repo.replace(/[\\/:]/g, "-")))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("keeps a single legacy dir outside git repositories", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-dirs-"))
    try {
      const cwd = "C:\\Users\\foo\\workspace"
      expect(__test.resolveProjectSessionDirs(dataDir, cwd)).toEqual([
        join(dataDir, "projects", "C--Users-foo-workspace"),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe("durable session fork", () => {
  it("flushes the active writer before loading that session", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-active-load-"))
    try {
      const script = [
        'import { appendLog, getCurrentSessionId, loadSavedSession } from "./src/session.ts";',
        'appendLog("user", "latest buffered row");',
        'const logs = loadSavedSession(getCurrentSessionId());',
        'console.log(JSON.stringify(logs.map((log) => [log.type, log.text])));',
      ].join("\n")
      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      expect(JSON.parse(raw.trim())).toEqual([["user", "latest buffered row"]])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("persists checkpoints, todos, and usage into the new fork", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-durable-fork-"))
    try {
      const script = [
        'import { appendLog, appendSnapshot, appendTodoUpdate, appendUsage, getCurrentSessionId, readCheckpointJournal, readRecentUsages, readTodoUpdates, setActiveSession, startNewSession } from "./src/session.ts";',
        'appendLog("user", "source turn");',
        'const source = getCurrentSessionId();',
        'appendSnapshot({ id: "snap-source", turnStartIndex: 0, logIndex: 0, journalLogIndex: 0, uiLogIndex: 99, sessionId: source, timestamp: new Date().toISOString(), trackedFiles: { "a.ts": { kind: "absent" } }, parentId: null });',
        'appendTodoUpdate("main", [{ content: "keep", status: "pending" }]);',
        'appendUsage(42, 30, 4, { inputTokens: 40 });',
        'startNewSession();',
        'const { loadSessionForDialog } = await import("./src/ui/dialog-sessions.tsx");',
        'const loaded = await loadSessionForDialog(source);',
        'setActiveSession(loaded.sessionLogs, { sourceSessionId: loaded.sourceSessionId, metadata: loaded.metadata });',
        'const fork = getCurrentSessionId();',
        'startNewSession();',
        'const checkpoints = readCheckpointJournal(fork);',
        'console.log(JSON.stringify({ fork, source, checkpoints, todos: Array.from(readTodoUpdates(fork)), usage: readRecentUsages(fork) }));',
      ].join("\n")
      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())
      expect(result.fork).not.toBe(result.source)
      expect(result.checkpoints).toHaveLength(1)
      expect(result.checkpoints[0].snapshot).toMatchObject({
        id: "snap-source",
        sessionId: result.fork,
        parentId: null,
      })
      expect(result.checkpoints[0].snapshot.uiLogIndex).toBeUndefined()
      expect(result.todos).toEqual([["main", [{ content: "keep", status: "pending" }]]])
      expect(result.usage).toHaveLength(1)
      expect(result.usage[0]).toMatchObject({ total: 42, inputTokens: 40 })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("removes failed durable snapshot metadata from the retry buffer", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-snapshot-failure-"))
    const writer = new __test.SessionWriter({ filePath: join(dataDir, "missing", "session.jsonl"), sessionId: "snapshot-failure", registerExitHandler: false })
    try {
      expect(() => writer.appendSnapshot({ id: "fixture" }, true)).toThrow("failed to persist checkpoint metadata")
      expect(writer.getPendingWriteCount()).toBe(0)
    } finally { writer.dispose(); rmSync(dataDir, { recursive: true, force: true }) }
  })

  it("removes a failed durable rewind marker from the retry buffer", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-marker-failure-"))
    const writer = new __test.SessionWriter({
      filePath: join(dataDir, "missing", "session.jsonl"),
      sessionId: "marker-failure",
      registerExitHandler: false,
    })
    try {
      expect(() => writer.appendRewindMarkerDurable(2, 4)).toThrow("failed to persist rewind marker")
      expect(writer.getPendingWriteCount()).toBe(0)
    } finally {
      writer.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("resets the writer's logical journal position after a durable rewind", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-marker-position-"))
    const writer = new __test.SessionWriter({
      filePath: join(dataDir, "session.jsonl"),
      sessionId: "marker-position",
      registerExitHandler: false,
    })
    try {
      writer.appendLog("user", "one")
      writer.appendLog("agent", "reply")
      expect(writer.getLogCount()).toBe(2)
      writer.appendRewindMarkerDurable(1, 1, "snap-1")
      expect(writer.getLogCount()).toBe(1)
      writer.appendLog("user", "replacement")
      expect(writer.getLogCount()).toBe(2)
    } finally {
      writer.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe("session restore safety and pagination", () => {
  it("rejects traversal ids and never trusts an embedded sessionId as a file locator", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-id-boundary-"))
    try {
      const script = [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { resolveProjectDataSegment } from "./zapsdk/utils/project-paths.ts";',
        'import { listSavedSessionsPage, loadSavedSession } from "./src/session.ts";',
        'const projectDir = join(process.env.ZAPCODE_DATA_DIR, "projects", resolveProjectDataSegment(process.cwd()));',
        'mkdirSync(projectDir, { recursive: true });',
        'const row = { type: "user", sessionId: "../../outside", timestamp: new Date().toISOString(), message: { role: "user", content: "safe prompt" } };',
        'writeFileSync(join(projectDir, "safe-session.jsonl"), JSON.stringify(row) + "\\n" + JSON.stringify({ type: "last-prompt", lastPrompt: "safe prompt" }) + "\\n");',
        'let traversalCode = null;',
        'try { loadSavedSession("../../outside"); } catch (error) { traversalCode = error.code; }',
        'const page = await listSavedSessionsPage({ limit: 10 });',
        'console.log(JSON.stringify({ traversalCode, ids: page.sessions.map(session => session.id) }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      expect(JSON.parse(raw.trim())).toEqual({
        traversalCode: "invalid_id",
        ids: ["safe-session"],
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("titles a session by its first real prompt, and omits one that only ran slash commands", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-titles-"))
    try {
      const script = [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { resolveProjectDataSegment } from "./zapsdk/utils/project-paths.ts";',
        'import { appendLog, getCurrentSessionId, listSavedSessionsPage, setActiveSession } from "./src/session.ts";',
        // Session A: a slash command first, then a real prompt.
        'appendLog("user", "/model", undefined, undefined, undefined, { restore: false });',
        'appendLog("user", "draw a pelican on a bike");',
        'appendLog("agent", "ok");',
        'const a = getCurrentSessionId();',
        // Session B: nothing but slash commands.
        'setActiveSession([]);',
        'appendLog("user", "/sessions", undefined, undefined, undefined, { restore: false });',
        'const b = getCurrentSessionId();',
        // Session C: a file written by an older build whose last-prompt is a command.
        'const dir = join(process.env.ZAPCODE_DATA_DIR, "projects", resolveProjectDataSegment(process.cwd()));',
        'mkdirSync(dir, { recursive: true });',
        'const row = (content) => JSON.stringify({ type: "user", sessionId: "legacy-c", timestamp: new Date().toISOString(), message: { role: "user", content } });',
        'writeFileSync(join(dir, "legacy-c.jsonl"), row("fix the build") + "\\n" + row("/sessions") + "\\n" + JSON.stringify({ type: "last-prompt", lastPrompt: "/sessions" }) + "\\n");',
        'const page = await listSavedSessionsPage({ limit: 10 });',
        'console.log(JSON.stringify({ a, b, rows: page.sessions.map(x => [x.id, x.preview]) }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())
      const byId = new Map<string, string>(result.rows)
      expect(byId.get(result.a)).toBe("draw a pelican on a bike")
      expect(byId.has(result.b)).toBe(false)
      expect(byId.get("legacy-c")).toBe("fix the build")
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("keeps the active session untouched when a selected file is missing or corrupt", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-load-errors-"))
    try {
      const script = [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { resolveProjectDataSegment } from "./zapsdk/utils/project-paths.ts";',
        'import { appendLog, getCurrentSessionId, prepareSavedSession } from "./src/session.ts";',
        'appendLog("user", "keep current");',
        'const before = getCurrentSessionId();',
        'const projectDir = join(process.env.ZAPCODE_DATA_DIR, "projects", resolveProjectDataSegment(process.cwd()));',
        'mkdirSync(projectDir, { recursive: true });',
        'writeFileSync(join(projectDir, "broken-session.jsonl"), "{not-json}");',
        'const codes = [];',
        'for (const id of ["missing-session", "broken-session"]) {',
        '  try { await prepareSavedSession(id); } catch (error) { codes.push(error.code); }',
        '}',
        'console.log(JSON.stringify({ before, after: getCurrentSessionId(), codes }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())
      expect(result.after).toBe(result.before)
      expect(result.codes).toEqual(["not_found", "corrupt"])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("recovers a valid session whose final JSONL append was torn", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-torn-tail-"))
    try {
      const script = [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { resolveProjectDataSegment } from "./zapsdk/utils/project-paths.ts";',
        'import { prepareSavedSession } from "./src/session.ts";',
        'const projectDir = join(process.env.ZAPCODE_DATA_DIR, "projects", resolveProjectDataSegment(process.cwd()));',
        'mkdirSync(projectDir, { recursive: true });',
        'const valid = { type: "user", message: { role: "user", content: "durable" } };',
        'writeFileSync(join(projectDir, "torn-session.jsonl"), JSON.stringify(valid) + "\\n{not-json");',
        'const restored = await prepareSavedSession("torn-session");',
        'console.log(JSON.stringify(restored.sessionLogs.map(log => [log.type, log.text])));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      expect(JSON.parse(raw.trim())).toEqual([["user", "durable"]])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("rolls conversation back when the durable commit fails", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-commit-rollback-"))
    try {
      const script = [
        'import { appendLog, getCurrentSessionId, startNewSession } from "./src/session.ts";',
        'appendLog("user", "restored");',
        'const source = getCurrentSessionId();',
        'startNewSession();',
        'const before = getCurrentSessionId();',
        'const { commitSessionForDialog, loadSessionForDialog } = await import("./src/ui/dialog-sessions.tsx");',
        'const loaded = await loadSessionForDialog(source);',
        'const target = {',
        '  messages: [{ role: "user", content: "original" }],',
        '  getAllMessages() { return [...this.messages]; },',
        '  mutateInPlace(fn) { return fn(this.messages); },',
        '};',
        'let error = null;',
        'try { commitSessionForDialog(loaded, target, () => { throw new Error("persist failed"); }); } catch (caught) { error = caught.message; }',
        'console.log(JSON.stringify({ before, after: getCurrentSessionId(), messages: target.messages, error }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())
      expect(result.after).toBe(result.before)
      expect(result.messages).toEqual([{ role: "user", content: "original" }])
      expect(result.error).toBe("persist failed")
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("pages sessions by recent activity without rereading every transcript", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-page-"))
    try {
      const script = [
        'import { mkdirSync, utimesSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { resolveProjectDataSegment } from "./zapsdk/utils/project-paths.ts";',
        'import { listSavedSessionsPage } from "./src/session.ts";',
        'const projectDir = join(process.env.ZAPCODE_DATA_DIR, "projects", resolveProjectDataSegment(process.cwd()));',
        'mkdirSync(projectDir, { recursive: true });',
        'const base = Date.now() - 100_000;',
        'for (let i = 0; i < 55; i++) {',
        '  const id = `paged-${String(i).padStart(2, "0")}`;',
        '  const path = join(projectDir, `${id}.jsonl`);',
        '  const user = { type: "user", timestamp: "2000-01-01T00:00:00.000Z", message: { role: "user", content: `prompt ${i}` } };',
        '  writeFileSync(path, JSON.stringify(user) + "\\n" + JSON.stringify({ type: "last-prompt", lastPrompt: `prompt ${i}` }) + "\\n");',
        '  const time = new Date(base + i * 1000);',
        '  utimesSync(path, time, time);',
        '}',
        'const first = await listSavedSessionsPage({ limit: 10 });',
        'const second = await listSavedSessionsPage({ offset: first.nextOffset, limit: 10 });',
        'console.log(JSON.stringify({',
        '  first: first.sessions.map(session => session.id),',
        '  second: second.sessions.map(session => session.id),',
        '  next: second.nextOffset,',
        '}));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())
      expect(result.first).toHaveLength(10)
      expect(result.first[0]).toBe("paged-54")
      expect(result.second).toHaveLength(10)
      expect(new Set([...result.first, ...result.second]).size).toBe(20)
      expect(typeof result.next).toBe("number")
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe("session git metadata", () => {
  it("reads branch names from .git/HEAD without invoking git", () => {
    const repo = mkdtempSync(join(tmpdir(), "zap-session-branch-"))
    try {
      mkdirSync(join(repo, ".git"), { recursive: true })
      writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/session\n")
      const subdir = join(repo, "packages", "cli")
      mkdirSync(subdir, { recursive: true })

      expect(__test.detectGitBranch(subdir)).toBe("feature/session")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("renders detached HEADs as short hashes", () => {
    const repo = mkdtempSync(join(tmpdir(), "zap-session-detached-"))
    try {
      mkdirSync(join(repo, ".git"), { recursive: true })
      writeFileSync(join(repo, ".git", "HEAD"), "1234567890abcdef1234567890abcdef12345678\n")

      expect(__test.detectGitBranch(repo)).toBe("1234567890ab")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("supports worktree-style .git files", () => {
    const repo = mkdtempSync(join(tmpdir(), "zap-session-worktree-"))
    const gitDir = mkdtempSync(join(tmpdir(), "zap-session-gitdir-"))
    try {
      writeFileSync(join(repo, ".git"), `gitdir: ${gitDir}\n`)
      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/worktree/topic\n")

      expect(__test.detectGitBranch(repo)).toBe("worktree/topic")
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(gitDir, { recursive: true, force: true })
    }
  })
})

describe("sessionLogsToMessages: consecutive-user merge", () => {
  it("folds orphan 'continue' prods into the latest user intent", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "开始做 ppt" },
      { type: "tool", text: "bash", tool: { id: "t1", name: "bash", arguments: { command: "pip install python-pptx" } } },
      { type: "result", text: "ok", tool: { id: "t1", name: "bash", output: "Requirement already satisfied", success: true } },
      // Pre-fix abort left the step-2 assistant missing. User pressed 继续 three times.
      { type: "user", text: "继续" },
      { type: "user", text: "继续" },
      { type: "user", text: "做成 ppt 用户行业分析" },
    ]

    const msgs = sessionLogsToMessages(logs)

    const userMessages = msgs.filter((m) => m.role === "user")
    expect(userMessages.length).toBe(2)
    expect(userMessages[0].content).toBe("开始做 ppt")
    expect(userMessages[1].content).toContain("继续")
    expect(userMessages[1].content).toContain("做成 ppt 用户行业分析")

    // Tool pair still intact in the middle
    expect(msgs.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "bash")).toBe(true)
    expect(msgs.some((m) => m.role === "tool_result")).toBe(true)
  })

  it("synthesizes assistant(tool_call) from result-only logs (writer collapses tool→result)", () => {
    // Regression: the session writer's replaceLog chain overwrites the initial "tool" log
    // with a "result" log, so on restore the JSONL only contains result entries. Without
    // synthesis, sessionLogsToMessages emitted only orphan tool_results → pruneOrphanedToolCalls
    // stripped them → model saw a degenerate history and returned empty on the next turn.
    const logs: SessionLog[] = [
      { type: "user", text: "open the video" },
      { type: "agent", text: "I'll open it." },
      {
        type: "result",
        text: "",
        tool: {
          id: "call_abc123",
          name: "bash",
          arguments: { command: "open foo.mp4" },
          output: "",
          success: true,
        },
      },
      { type: "agent", text: "Done." },
      { type: "user", text: "now extract audio" },
    ]

    const msgs = sessionLogsToMessages(logs)

    // Assistant(tool_call) should have been synthesized before the tool_result
    const toolCallMsg = msgs.find((m) => m.role === "assistant" && m.toolCalls?.length)
    expect(toolCallMsg).toBeDefined()
    expect(toolCallMsg!.toolCalls![0].id).toBe("call_abc123")
    expect(toolCallMsg!.toolCalls![0].name).toBe("bash")

    const toolResult = msgs.find((m) => m.role === "tool_result")
    expect(toolResult).toBeDefined()
    expect(toolResult!.toolCallId).toBe("call_abc123")

    // tool_call must appear BEFORE its tool_result — providers reject the opposite order.
    const callIdx = msgs.indexOf(toolCallMsg!)
    const resultIdx = msgs.indexOf(toolResult!)
    expect(callIdx).toBeLessThan(resultIdx)
  })

  it("leaves sessions without orphan patterns untouched", () => {
    const logs: SessionLog[] = [
      { type: "user", text: "hello" },
      { type: "agent", text: "hi" },
      { type: "user", text: "bye" },
    ]
    const msgs = sessionLogsToMessages(logs)
    expect(msgs).toHaveLength(3)
    expect(msgs[0].content).toBe("hello")
    expect(msgs[1].content).toBe("hi")
    expect(msgs[2].content).toBe("bye")
  })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] })
}

describe("parseSessionJsonl: restore metadata", () => {
  it("preserves zapRestore:false for display-only user rows", () => {
    const raw = JSON.stringify({
      uuid: "u1",
      type: "user",
      zapRestore: false,
      message: { role: "user", content: "/review src" },
    })
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ type: "user", text: "/review src", restore: false })
  })

  it("preserves zapRestoreText for compact long-paste display rows", () => {
    const raw = JSON.stringify({
      uuid: "u1",
      type: "user",
      zapRestoreText: "full\n  pasted\ntext",
      message: { role: "user", content: "[Pasted #1 · 3 lines · 19 chars]" },
    })
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      type: "user",
      text: "[Pasted #1 · 3 lines · 19 chars]",
      restoreText: "full\n  pasted\ntext",
    })
  })

  it("preserves zapRestoreText from legacy log rows", () => {
    const raw = JSON.stringify({
      uuid: "u1",
      type: "log",
      logType: "user",
      text: "[Pasted #1 · 3 lines · 42 chars]",
      zapRestoreText: "first line\nsecond line\nthird line",
    })
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      type: "user",
      text: "[Pasted #1 · 3 lines · 42 chars]",
      restoreText: "first line\nsecond line\nthird line",
    })
  })

  it("parses CCB array content defensively while preserving valid blocks", () => {
    const raw = JSON.stringify({
      uuid: "u1",
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "please continue" },
          { type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] },
          { type: "text", text: 123 },
          null,
          "bad block",
        ],
      },
    })

    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({
      type: "result",
      text: "line 1\nline 2",
      tool: { id: "tool_1", success: true },
    })
    expect(logs[1]).toMatchObject({ type: "user", text: "please continue" })
  })
})

describe("parseLatestUsageJsonl", () => {
  it("returns the latest usage row with cache accounting fields", () => {
    const raw = [
      JSON.stringify({
        type: "usage",
        total: 10,
        localEstimateAtTime: 6,
        output: 1,
        inputTokens: 10,
      }),
      "not json",
      JSON.stringify({
        type: "usage",
        total: 100,
        localEstimateAtTime: 20,
        output: 7,
        inputTokens: 10,
        providerUsageReported: true,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        totalPromptInputTokens: 100,
        cacheHitRatio: 0.8,
        cacheReuseRatio: 80 / 90,
        cacheWriteRatio: 0.1,
        step: 3,
        finishReason: "stop",
        cacheScope: {
          providerId: "provider_1",
          model: "model-a",
        },
        contextDiagnostics: {
          totalChars: 400,
          estimatedTokens: 100,
          hash: "ctx_hash",
          segments: [
            {
              name: "memory_index",
              chars: 360,
              estimatedTokens: 90,
              hash: "mem_hash",
              meta: { included: ["MEMORY.md"] },
            },
          ],
        },
        promptCacheDiagnostics: {
          boundaryPresent: true,
          staticPrefix: {
            chars: 40000,
            estimatedTokens: 10000,
            hash: "promptstatic",
          },
          dynamicSuffix: {
            chars: 600,
            estimatedTokens: 150,
            hash: "promptdyn123",
          },
          toolSchemas: {
            count: 4,
            hash: "toolsabc1234",
            names: ["bash", "read_file", "write_file", "agent"],
          },
        },
      }),
    ].join("\n")

    expect(parseLatestUsageJsonl(raw)).toEqual({
      total: 100,
      localEstimateAtTime: 20,
      output: 7,
      inputTokens: 10,
      providerUsageReported: true,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      totalPromptInputTokens: 100,
      cacheHitRatio: 0.8,
      cacheReuseRatio: 80 / 90,
      cacheWriteRatio: 0.1,
      step: 3,
      finishReason: "stop",
      cacheScope: {
        providerId: "provider_1",
        model: "model-a",
      },
      contextDiagnostics: {
        totalChars: 400,
        estimatedTokens: 100,
        hash: "ctx_hash",
        segments: [
          {
            name: "memory_index",
            chars: 360,
            estimatedTokens: 90,
            hash: "mem_hash",
            meta: { included: ["MEMORY.md"] },
          },
        ],
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: {
          chars: 40000,
          estimatedTokens: 10000,
          hash: "promptstatic",
        },
        dynamicSuffix: {
          chars: 600,
          estimatedTokens: 150,
          hash: "promptdyn123",
        },
        toolSchemas: {
          count: 4,
          hash: "toolsabc1234",
          names: ["bash", "read_file", "write_file", "agent"],
        },
      },
    })
  })

  it("keeps legacy usage rows readable", () => {
    const raw = JSON.stringify({
      type: "usage",
      total: 42,
      localEstimateAtTime: 20,
    })

    expect(parseLatestUsageJsonl(raw)).toEqual({
      total: 42,
      localEstimateAtTime: 20,
      output: 0,
    })
  })

  it("sanitizes cache scope without rejecting an otherwise valid usage row", () => {
    const valid = JSON.stringify({
      type: "usage",
      total: 42,
      localEstimateAtTime: 20,
      cacheScope: { providerId: " provider_1 ", model: " model-a " },
    })
    const malformed = JSON.stringify({
      type: "usage",
      total: 43,
      localEstimateAtTime: 21,
      cacheScope: { providerId: 123, model: "model-b" },
    })

    expect(parseRecentUsageJsonl([valid, malformed].join("\n"))).toEqual([
      {
        total: 42,
        localEstimateAtTime: 20,
        output: 0,
        cacheScope: { providerId: "provider_1", model: "model-a" },
      },
      {
        total: 43,
        localEstimateAtTime: 21,
        output: 0,
      },
    ])
  })

  it("sanitizes malformed numeric usage fields from legacy session rows", () => {
    const raw = JSON.stringify({
      type: "usage",
      total: -42,
      localEstimateAtTime: -20,
      output: -7,
      inputTokens: -10,
      cacheReadInputTokens: -80,
      cacheCreationInputTokens: 10,
      totalPromptInputTokens: -100,
      cacheHitRatio: 2,
      cacheReuseRatio: -0.5,
      cacheWriteRatio: null,
      step: -3,
      finishReason: "stop",
      contextDiagnostics: {
        totalChars: -400,
        estimatedTokens: Number.POSITIVE_INFINITY,
        hash: "ctx_hash",
        segments: [
          {
            name: "memory_index",
            chars: -360,
            estimatedTokens: Number.NaN,
            hash: "mem_hash",
          },
          {
            name: 123,
            chars: 10,
            estimatedTokens: 2,
            hash: "bad",
          },
        ],
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: {
          chars: -40000,
          estimatedTokens: Number.NaN,
          hash: "promptstatic",
        },
        dynamicSuffix: {
          chars: Number.POSITIVE_INFINITY,
          estimatedTokens: -150,
          hash: "promptdyn123",
        },
      },
    })

    expect(parseLatestUsageJsonl(raw)).toEqual({
      total: 0,
      localEstimateAtTime: 0,
      output: 0,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 10,
      totalPromptInputTokens: 0,
      cacheHitRatio: 1,
      cacheReuseRatio: 0,
      cacheWriteRatio: null,
      finishReason: "stop",
      contextDiagnostics: {
        totalChars: 0,
        estimatedTokens: 0,
        hash: "ctx_hash",
        segments: [
          {
            name: "memory_index",
            chars: 0,
            estimatedTokens: 0,
            hash: "mem_hash",
          },
        ],
      },
      promptCacheDiagnostics: {
        boundaryPresent: true,
        staticPrefix: {
          chars: 0,
          estimatedTokens: 0,
          hash: "promptstatic",
        },
        dynamicSuffix: {
          chars: 0,
          estimatedTokens: 0,
          hash: "promptdyn123",
        },
      },
    })
  })

  it("returns null when no valid usage row exists", () => {
    expect(parseLatestUsageJsonl("bad\n" + JSON.stringify({ type: "usage", total: 1 }))).toBeNull()
  })

  it("returns recent usage rows in order while skipping malformed entries", () => {
    const raw = [
      JSON.stringify({ type: "usage", total: 10, localEstimateAtTime: 5, output: 1, inputTokens: 10 }),
      "not json",
      JSON.stringify({ type: "usage", total: 20, localEstimateAtTime: 6, output: 2, inputTokens: 8, cacheReadInputTokens: 12 }),
      JSON.stringify({ type: "usage", total: 30 }),
      JSON.stringify({ type: "usage", total: 40, localEstimateAtTime: 7, output: 3, inputTokens: 4, cacheReadInputTokens: 36 }),
    ].join("\n")

    expect(parseRecentUsageJsonl(raw, 2)).toEqual([
      {
        total: 20,
        localEstimateAtTime: 6,
        output: 2,
        inputTokens: 8,
        cacheReadInputTokens: 12,
      },
      {
        total: 40,
        localEstimateAtTime: 7,
        output: 3,
        inputTokens: 4,
        cacheReadInputTokens: 36,
      },
    ])
  })

  it("keeps the latest twelve usage rows by default for status trends", () => {
    const raw = Array.from({ length: 14 }, (_, i) => JSON.stringify({
      type: "usage",
      total: i + 1,
      localEstimateAtTime: i,
      output: 1,
    })).join("\n")

    expect(parseRecentUsageJsonl(raw).map((usage) => usage.total)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 3),
    )
  })

  it("returns no recent usage rows when the requested limit is zero", () => {
    const raw = JSON.stringify({ type: "usage", total: 10, localEstimateAtTime: 5, output: 1 })

    expect(parseRecentUsageJsonl(raw, 0)).toEqual([])
  })

  it("drops positioned usage rows from the abandoned rewind branch", () => {
    const raw = [
      { type: "usage", total: 10, localEstimateAtTime: 5, output: 1, journalLogIndex: 1 },
      { type: "usage", total: 99, localEstimateAtTime: 90, output: 9, journalLogIndex: 4 },
      { type: "rewind-marker", targetTurnStartIndex: 2, logIndex: 2 },
      { type: "usage", total: 20, localEstimateAtTime: 8, output: 2, journalLogIndex: 3 },
    ].map(entry => JSON.stringify(entry)).join("\n")

    expect(parseRecentUsageJsonl(raw).map(usage => usage.total)).toEqual([10, 20])
  })
})

describe("resolveRestoredUsageContext", () => {
  it("uses persisted API prompt truth and recovers prompt overhead when available", () => {
    const restored = resolveRestoredUsageContext({
      total: 100,
      localEstimateAtTime: 20,
      output: 7,
      inputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
    }, 30, 5)

    expect(restored).toEqual({
      contextTokens: 110,
      promptOverhead: 80,
      contextPending: false,
    })
  })

  it("falls back to local conversation estimate when the latest usage row has no prompt accounting", () => {
    const restored = resolveRestoredUsageContext({
      total: 0,
      localEstimateAtTime: 120,
      output: 42,
      inputTokens: 0,
    }, 160, 25)

    expect(restored).toEqual({
      contextTokens: 185,
      promptOverhead: 25,
      contextPending: false,
    })
  })

  it("sanitizes direct numeric inputs before resolving restored usage", () => {
    const restored = resolveRestoredUsageContext({
      total: -100,
      localEstimateAtTime: Number.NaN,
      output: 0,
    }, Number.POSITIVE_INFINITY, -25)

    expect(restored).toEqual({
      contextTokens: 0,
      promptOverhead: 0,
      contextPending: false,
    })
  })
})

describe("resolveUnmeasuredUsageContext", () => {
  it("uses only the restored conversation estimate and resets prompt overhead", () => {
    expect(resolveUnmeasuredUsageContext(160)).toEqual({
      contextTokens: 160,
      promptOverhead: 0,
      contextPending: true,
    })
  })

  it("sanitizes invalid local estimates", () => {
    expect(resolveUnmeasuredUsageContext(Number.POSITIVE_INFINITY)).toEqual({
      contextTokens: 0,
      promptOverhead: 0,
      contextPending: true,
    })
    expect(resolveUnmeasuredUsageContext(-10)).toEqual({
      contextTokens: 0,
      promptOverhead: 0,
      contextPending: true,
    })
  })
})

describe("SessionWriter diagnostics", () => {
  it("does not materialize or count UI-only log types", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-session-writer-ui-only-"))
    try {
      const filePath = join(tmp, "session.jsonl")
      const writer = new __test.SessionWriter({
        filePath,
        sessionId: "session-test",
        registerExitHandler: false,
      })

      expect(writer.appendLog("approval", "proposed")).toBe(false)
      expect(writer.appendLog("divider", "")).toBe(false)
      expect(writer.isMaterialized()).toBe(false)
      expect(writer.getLogCount()).toBe(0)
      expect(writer.getPendingWriteCount()).toBe(0)

      expect(writer.appendLog("tool", "bash", {
        id: "t1",
        name: "bash",
        arguments: { command: "echo hi" },
      })).toBe(true)
      writer.appendReplace(0, "result", "hi", {
        id: "t1",
        name: "bash",
        arguments: { command: "echo hi" },
        output: "hi",
        success: true,
      })
      __test.flushWriter(writer)

      const logs = parseSessionJsonl(readFileSync(filePath, "utf-8"))
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        type: "result",
        text: "hi",
        tool: { id: "t1", output: "hi", success: true },
      })
      writer.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("exported appendLog does not consume journal indexes for UI-only rows", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-ui-only-index-"))
    try {
      const script = [
        'import { appendLog, peekJournalLogIndex } from "./src/session.ts";',
        'const before = peekJournalLogIndex();',
        'const approval = appendLog("approval", "proposed");',
        'const afterApproval = peekJournalLogIndex();',
        'const tool = appendLog("tool", "bash", { id: "t1", name: "bash", arguments: {} });',
        'const afterTool = peekJournalLogIndex();',
        'console.log(JSON.stringify({ before, approval, afterApproval, tool, afterTool }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        before: 0,
        approval: null,
        afterApproval: 0,
        tool: 0,
        afterTool: 1,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("readCurrentSessionLogs flushes buffered active-session writes before parsing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-read-current-"))
    try {
      const script = [
        'import { appendLog, readCurrentSessionLogs } from "./src/session.ts";',
        'appendLog("user", "[Pasted #1 · 3 lines · 42 chars]", undefined, undefined, undefined, { restoreText: "full\\ntext" });',
        'const logs = readCurrentSessionLogs();',
        'console.log(JSON.stringify(logs));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual([
        {
          type: "user",
          text: "[Pasted #1 · 3 lines · 42 chars]",
          restoreText: "full\ntext",
        },
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("stores oversized restoreText in a sidecar while preserving session restore", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-restore-sidecar-"))
    try {
      const script = [
        'import { appDataDir, appendLog, readCurrentSessionLogs } from "./src/session.ts";',
        'import { existsSync, readFileSync, readdirSync } from "node:fs";',
        'import { isAbsolute, join } from "node:path";',
        'const large = "first line\\n" + "x".repeat(70 * 1024);',
        'appendLog("user", "[Pasted #1 · 2 lines · 71691 chars]", undefined, undefined, undefined, { restoreText: large });',
        'const logs = readCurrentSessionLogs();',
        'function jsonlFiles(dir) {',
        '  const out = [];',
        '  for (const entry of readdirSync(dir, { withFileTypes: true })) {',
        '    const path = join(dir, entry.name);',
        '    if (entry.isDirectory()) out.push(...jsonlFiles(path));',
        '    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);',
        '  }',
        '  return out;',
        '}',
        'const files = jsonlFiles(join(appDataDir, "projects"));',
        'const raw = files.map((file) => readFileSync(file, "utf-8")).join("\\n");',
        'const entry = raw.split("\\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "user");',
        'const restoreRef = entry?.zapRestoreTextRef;',
        'const restorePath = typeof restoreRef === "string" ? (isAbsolute(restoreRef) ? restoreRef : join(appDataDir, restoreRef)) : undefined;',
        'console.log(JSON.stringify({',
        '  restored: logs[0]?.restoreText === large,',
        '  inlineLarge: raw.includes(large),',
        '  hasInlineRestoreText: typeof entry?.zapRestoreText === "string",',
        '  refExists: typeof restorePath === "string" && existsSync(restorePath),',
        '  portableRef: typeof restoreRef === "string" && !isAbsolute(restoreRef),',
        '}));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        restored: true,
        inlineLarge: false,
        hasInlineRestoreText: false,
        refExists: true,
        portableRef: true,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("restores oversized Unicode input after moving the complete data directory", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-portable-sidecar-"))
    const movedDataDir = `${dataDir}-moved`
    try {
      const writeScript = [
        'import { appendLog, readCurrentSessionLogs } from "./src/session.ts";',
        'const full = "\\nLONG_HEAD\\r\\n" + "界🧪".repeat(40_000) + "\\rLONG_TAIL\\n";',
        'appendLog("user", "[Pasted #1 · 4 lines · 80024 chars]", undefined, undefined, undefined, { restoreText: full });',
        'readCurrentSessionLogs();',
      ].join("\n")

      execFileSync(process.execPath, ["--eval", writeScript], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      renameSync(dataDir, movedDataDir)

      const readScript = [
        'import { listSavedSessions, loadSavedSession, sessionLogsToTurns } from "./src/session.ts";',
        'const expected = "\\nLONG_HEAD\\r\\n" + "界🧪".repeat(40_000) + "\\rLONG_TAIL\\n";',
        'const session = listSavedSessions()[0];',
        'const logs = session ? loadSavedSession(session.id) : [];',
        'const turns = sessionLogsToTurns(logs);',
        'console.log(JSON.stringify({',
        '  logExact: logs[0]?.restoreText === expected,',
        '  turnExact: turns[0]?.kind === "user" && turns[0].content === expected,',
        '  startsWithWhitespace: turns[0]?.kind === "user" && turns[0].content.startsWith("\\n"),',
        '  endsWithWhitespace: turns[0]?.kind === "user" && turns[0].content.endsWith("\\n"),',
        '}));',
      ].join("\n")
      const raw = execFileSync(process.execPath, ["--eval", readScript], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: movedDataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        logExact: true,
        turnExact: true,
        startsWithWhitespace: true,
        endsWithWhitespace: true,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(movedDataDir, { recursive: true, force: true })
    }
  })

  it("marks missing restoreText sidecars unavailable in transcript and model restore", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-missing-restore-sidecar-"))
    try {
      const script = [
        'import { appendLog, appDataDir, readCurrentSessionLogs, sessionLogsToMessages } from "./src/session.ts";',
        'import { readdirSync, readFileSync, unlinkSync } from "node:fs";',
        'import { isAbsolute, join } from "node:path";',
        'const large = "first line\\n" + "x".repeat(70 * 1024);',
        'appendLog("user", "[Pasted #1 · 2 lines · 71691 chars]", undefined, undefined, undefined, { restoreText: large });',
        'readCurrentSessionLogs();',
        'function jsonlFiles(dir) {',
        '  const out = [];',
        '  for (const entry of readdirSync(dir, { withFileTypes: true })) {',
        '    const path = join(dir, entry.name);',
        '    if (entry.isDirectory()) out.push(...jsonlFiles(path));',
        '    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);',
        '  }',
        '  return out;',
        '}',
        'const raw = jsonlFiles(join(appDataDir, "projects")).map((file) => readFileSync(file, "utf-8")).join("\\n");',
        'const entry = raw.split("\\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.type === "user");',
        'const restorePath = isAbsolute(entry.zapRestoreTextRef) ? entry.zapRestoreTextRef : join(appDataDir, entry.zapRestoreTextRef);',
        'unlinkSync(restorePath);',
        'const logs = readCurrentSessionLogs();',
        'const messages = sessionLogsToMessages(logs);',
        'console.log(JSON.stringify({',
        '  text: logs[0]?.text,',
        '  hasRestoreText: typeof logs[0]?.restoreText === "string",',
        '  modelContent: messages[0]?.content,',
        '}));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      const unavailable = "[Pasted #1 unavailable in history; paste again to resend full text]"
      expect(JSON.parse(raw.trim())).toEqual({
        text: unavailable,
        hasRestoreText: false,
        modelContent: unavailable,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("lists and restores a session whose first row contains a long inline paste", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-long-inline-list-"))
    try {
      const writeScript = [
        'import { appendLog, readCurrentSessionLogs } from "./src/session.ts";',
        'const full = "LONG_HEAD\\n" + "x".repeat(32 * 1024) + "\\nLONG_TAIL";',
        'appendLog("user", "[Pasted #1 · 3 lines · 32790 chars]", undefined, undefined, undefined, { restoreText: full });',
        'readCurrentSessionLogs();',
      ].join("\n")

      execFileSync(process.execPath, ["--eval", writeScript], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      const readScript = [
        'import { listSavedSessions, loadSavedSession } from "./src/session.ts";',
        'const sessions = listSavedSessions();',
        'const logs = sessions[0] ? loadSavedSession(sessions[0].id) : [];',
        'console.log(JSON.stringify({',
        '  count: sessions.length,',
        '  preview: sessions[0]?.preview,',
        '  restoreLength: logs[0]?.restoreText?.length,',
        '  restoreHead: logs[0]?.restoreText?.startsWith("LONG_HEAD\\n"),',
        '  restoreTail: logs[0]?.restoreText?.endsWith("\\nLONG_TAIL"),',
        '}));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", readScript], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      expect(JSON.parse(raw.trim())).toEqual({
        count: 1,
        preview: "[Pasted #1 · 3 lines · 32790 chars]",
        restoreLength: 32 * 1024 + 20,
        restoreHead: true,
        restoreTail: true,
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("setActiveSession skips restored dividers when rebuilding journal indexes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-restore-divider-index-"))
    try {
      const script = [
        'import { appendLog, getCurrentSessionId, loadSavedSession, peekJournalLogIndex, replaceLog, setActiveSession, startNewSession } from "./src/session.ts";',
        'setActiveSession([',
        '  { type: "user", text: "first" },',
        '  { type: "agent", text: "reply" },',
        '  { type: "divider", text: "" },',
        '  { type: "user", text: "second" },',
        ']);',
        'const afterRestore = peekJournalLogIndex();',
        'const toolIndex = appendLog("tool", "bash", { id: "t1", name: "bash", arguments: { command: "echo hi" } });',
        'replaceLog(toolIndex, "result", "hi", { id: "t1", name: "bash", arguments: { command: "echo hi" }, output: "hi", success: true });',
        'const sessionId = getCurrentSessionId();',
        'startNewSession();',
        'const logs = loadSavedSession(sessionId);',
        'const toolRows = logs.filter((log) => log.type === "tool" || log.type === "result");',
        'console.log(JSON.stringify({ afterRestore, toolIndex, toolRows }));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())

      expect(result.afterRestore).toBe(3)
      expect(result.toolIndex).toBe(3)
      expect(result.toolRows).toHaveLength(1)
      expect(result.toolRows[0]).toMatchObject({
        type: "result",
        text: "hi",
        tool: { id: "t1", output: "hi", success: true },
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("dialog session prepares without mutation and commits conversation with the durable fork", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-dialog-fork-"))
    try {
      const script = [
        'import { appendLog, getCurrentSessionId, startNewSession } from "./src/session.ts";',
        'appendLog("user", "resume me");',
        'const sourceId = getCurrentSessionId();',
        'startNewSession();',
        'const beforeLoad = getCurrentSessionId();',
        'const { commitSessionForDialog, loadSessionForDialog } = await import("./src/ui/dialog-sessions.tsx");',
        'const loaded = await loadSessionForDialog(sourceId);',
        'const afterPrepare = getCurrentSessionId();',
        'const target = {',
        '  messages: [{ role: "user", content: "old" }],',
        '  getAllMessages() { return [...this.messages]; },',
        '  mutateInPlace(fn) { return fn(this.messages); },',
        '};',
        'commitSessionForDialog(loaded, target);',
        'const afterLoad = getCurrentSessionId();',
        'console.log(JSON.stringify({',
        '  sourceId,',
        '  beforeLoad,',
        '  afterPrepare,',
        '  afterLoad,',
        '  loadedSessionId: loaded.loadedSessionId,',
        '  logTypes: loaded.logs.map((log) => log.type),',
        '  messageRoles: loaded.messages.map((msg) => msg.role),',
        '  committedRoles: target.messages.map((msg) => msg.role),',
        '}));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const result = JSON.parse(raw.trim())

      expect(result.loadedSessionId).toBe(result.sourceId)
      expect(result.afterPrepare).toBe(result.beforeLoad)
      expect(result.afterLoad).not.toBe(result.sourceId)
      expect(result.afterLoad).not.toBe(result.beforeLoad)
      expect(result.logTypes).toEqual(["user"])
      expect(result.messageRoles).toEqual(["user"])
      expect(result.committedRoles).toEqual(["user"])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("dialog session loads preserve restorable pasted user metadata", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-dialog-restore-text-"))
    try {
      const script = [
        'import { appendLog, getCurrentSessionId, startNewSession } from "./src/session.ts";',
        'appendLog(',
        '  "user",',
        '  "[Pasted #1 · 3 lines · 42 chars]",',
        '  undefined,',
        '  [{ filePath: "/tmp/image.png", source: "file", mediaType: "image/png" }],',
        '  undefined,',
        '  { restoreText: "first line\\nsecond line\\nthird line" },',
        ');',
        'const sourceId = getCurrentSessionId();',
        'startNewSession();',
        'const { loadSessionForDialog } = await import("./src/ui/dialog-sessions.tsx");',
        'const loaded = await loadSessionForDialog(sourceId);',
        'console.log(JSON.stringify(loaded.logs[0]));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })
      const log = JSON.parse(raw.trim())

      expect(log).toMatchObject({
        type: "user",
        text: "[Pasted #1 · 3 lines · 42 chars]",
        restoreText: "first line\nsecond line\nthird line",
        images: [{ filePath: "/tmp/image.png", source: "file", mediaType: "image/png" }],
      })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("reports persistence failures and keeps buffered entries for a later retry", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-session-writer-"))
    try {
      const events: Array<{ event: string; fields?: Record<string, unknown> }> = []
      restoreDiagnostics = setSessionDiagnostics({
        warn: (event, fields) => events.push({ event, fields }),
      })
      const missingParent = join(tmp, "missing")
      const filePath = join(missingParent, "session.jsonl")
      const writer = new __test.SessionWriter({
        filePath,
        sessionId: "session-test",
        registerExitHandler: false,
      })

      writer.appendLog("user", "hello")
      __test.flushWriter(writer)

      expect(events.some((e) =>
        e.event === "session_persistence_failed" &&
        e.fields?.operation === "flush" &&
        e.fields?.path === filePath,
      )).toBe(true)
      expect(writer.getPendingWriteCount()).toBe(1)
      expect(writer.getPersistenceStatus().lastFailure).toMatchObject({
        operation: "flush",
        path: filePath,
        pendingEntries: 1,
      })

      mkdirSync(missingParent, { recursive: true })
      __test.flushWriter(writer)

      expect(writer.getPendingWriteCount()).toBe(0)
      expect(writer.getPersistenceStatus().lastFailure).toBeUndefined()
      const raw = readFileSync(filePath, "utf-8")
      expect(raw).toContain('"type":"user"')
      expect(raw).toContain("hello")
      writer.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("exported persistence status reflects the active writer backlog", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zap-session-persistence-status-"))
    try {
      const script = [
        'import { appendLog, getSessionPersistenceStatus } from "./src/session.ts";',
        'appendLog("user", "persist me");',
        'console.log(JSON.stringify(getSessionPersistenceStatus()));',
      ].join("\n")

      const raw = execFileSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ZAPCODE_DATA_DIR: dataDir },
        encoding: "utf-8",
      })

      const status = JSON.parse(raw.trim())
      expect(status.pendingWrites).toBe(1)
      expect(status.lastFailure).toBeUndefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it("tightens permissions when appending to an existing broad session file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-session-writer-"))
    try {
      const filePath = join(tmp, "session.jsonl")
      writeFileSync(filePath, "", { mode: 0o666 })
      chmodSync(filePath, 0o666)
      const writer = new __test.SessionWriter({
        filePath,
        sessionId: "session-test",
        registerExitHandler: false,
      })

      writer.appendLog("user", "secret prompt")
      __test.flushWriter(writer)

      expect(statSync(filePath).mode & 0o777).toBe(0o600)
      expect(readFileSync(filePath, "utf-8")).toContain("secret prompt")
      writer.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("last output persistence", () => {
  it("writes atomically with owner-only permissions and tightens existing files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-last-output-"))
    try {
      const filePath = join(tmp, "last-output.md")
      writeFileSync(filePath, "old", { mode: 0o666 })
      chmodSync(filePath, 0o666)

      __test.saveLastOutputFile(filePath, "new secret output")

      expect(statSync(filePath).mode & 0o777).toBe(0o600)
      expect(readFileSync(filePath, "utf-8")).toBe("new secret output")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("parseSessionJsonl: rewind-marker truncation", () => {
  function userEntry(text: string): string {
    return JSON.stringify({ type: "user", message: { content: text } })
  }
  function assistantEntry(text: string): string {
    return JSON.stringify({ type: "assistant", message: { content: text } })
  }
  function rewindMarker(targetTurnStartIndex: number, logIndex?: number): string {
    return JSON.stringify({ type: "rewind-marker", targetTurnStartIndex, logIndex })
  }

  it("slices accumulated logs back when marker with logIndex is encountered", () => {
    const raw = [
      userEntry("turn 1"),      // logs[0]
      assistantEntry("reply 1"),// logs[1]
      userEntry("turn 2"),      // logs[2]
      assistantEntry("reply 2"),// logs[3]
      rewindMarker(3, 2),       // slice logs to length 2 — drop turn 2 + reply 2
      userEntry("turn 2-new"),  // logs[2]
      assistantEntry("reply 2-new"), // logs[3]
    ].join("\n")

    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(4)
    expect(logs.map(l => l.text)).toEqual([
      "turn 1", "reply 1", "turn 2-new", "reply 2-new",
    ])
  })

  it("multiple markers in sequence each truncate", () => {
    const raw = [
      userEntry("a"),
      assistantEntry("A"),
      rewindMarker(1, 1),       // drop "A"
      userEntry("b"),
      assistantEntry("B"),
      rewindMarker(1, 1),       // drop "b" and "B" — logs back to length 1
      userEntry("c"),
    ].join("\n")

    const logs = parseSessionJsonl(raw)
    expect(logs.map(l => l.text)).toEqual(["a", "c"])
  })

  it("marker without logIndex is a no-op (legacy JSONL compat)", () => {
    const raw = [
      userEntry("kept"),
      assistantEntry("kept2"),
      JSON.stringify({ type: "rewind-marker", targetTurnStartIndex: 1 }), // no logIndex
      userEntry("also kept"),
    ].join("\n")

    const logs = parseSessionJsonl(raw)
    expect(logs.map(l => l.text)).toEqual(["kept", "kept2", "also kept"])
  })

  it("marker with logIndex >= current length is a no-op", () => {
    const raw = [
      userEntry("a"),
      rewindMarker(5, 10),  // logIndex way past current length
      userEntry("b"),
    ].join("\n")

    const logs = parseSessionJsonl(raw)
    expect(logs.map(l => l.text)).toEqual(["a", "b"])
  })

  it("snapshot entries are skipped (no effect on logs)", () => {
    const raw = [
      userEntry("a"),
      JSON.stringify({ type: "snapshot", snapshot: { id: "s1" } }),
      userEntry("b"),
    ].join("\n")

    const logs = parseSessionJsonl(raw)
    expect(logs.map(l => l.text)).toEqual(["a", "b"])
  })
})

describe("parseSessionJsonl: subagent agentPath back-compat", () => {
  function progressEntry(data: Record<string, unknown>): string {
    return JSON.stringify({ type: "progress", data })
  }

  it("legacy toolName format `[sa_xxx] real_tool` is peeled into agentPath + clean name", () => {
    // Written by the pre-grouping useAgentRunner: `[sa_xxx]` was baked
    // into toolName and no separate agentPath field existed.
    const raw = progressEntry({
      logType: "result",
      toolCallId: "call_1",
      toolName: "[sa_explore_mo8ol48l_tk6w] web_search",
      arguments: { query: "OpenAI" },
      output: "...",
      success: true,
    })
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0].tool?.name).toBe("web_search")
    expect(logs[0].agentPath).toEqual(["sa_explore_mo8ol48l_tk6w"])
  })

  it("explicit data.agentPath wins — toolName is not re-stripped", () => {
    // New-format entry with a separate agentPath field. The toolName may
    // still coincidentally start with something bracketed (e.g. the tool
    // literally uses brackets); we must NOT strip that away.
    const raw = progressEntry({
      logType: "tool",
      toolCallId: "call_2",
      toolName: "[sa_manual] not_actually_an_id",
      agentPath: ["sa_explore_real"],
      arguments: {},
    })
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0].agentPath).toEqual(["sa_explore_real"])
    // toolName kept verbatim because explicit agentPath took precedence
    expect(logs[0].tool?.name).toBe("[sa_manual] not_actually_an_id")
  })

  it("malformed or empty toolName is a no-op (no spurious agentPath)", () => {
    const raw = [
      progressEntry({ logType: "result", toolName: "", output: "" }),
      progressEntry({ logType: "tool", toolName: "bash", arguments: { command: "ls" } }),
      progressEntry({ logType: "tool", toolName: "[not_sa_prefix] web_search" }),
    ].join("\n")
    const logs = parseSessionJsonl(raw)
    // Empty toolName → no tool object is built (existing behavior), so just
    // the later two must be present.
    expect(logs.length).toBeGreaterThanOrEqual(2)
    const bash = logs.find((l) => l.tool?.name === "bash")
    expect(bash?.agentPath).toBeUndefined()
    // `[not_sa_...]` prefix does NOT match /^\[sa_.../ — left untouched
    const weird = logs.find((l) => l.tool?.name === "[not_sa_prefix] web_search")
    expect(weird?.agentPath).toBeUndefined()
  })
})

describe("parseSessionJsonl: replacesUuid supersession", () => {
  // Regression: SessionWriter is append-only, but `replaceLog` (tool_call_pending
  // placeholder → argsPreview → final args → result) used to leave every
  // intermediate snapshot on disk. On restore the UI then rendered 3+ pending
  // rows per tool call. Fix: later entries carry `replacesUuid`; parser drops
  // superseded entries so only the final state is replayed.
  function entry(uuid: string, body: Record<string, unknown>, replacesUuid?: string): string {
    return JSON.stringify({ uuid, ...body, ...(replacesUuid ? { replacesUuid } : {}) })
  }
  function progressBody(data: Record<string, unknown>) {
    return { type: "progress", data }
  }

  it("later entry with replacesUuid drops the earlier entry", () => {
    const raw = [
      entry("A", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: {}, meta: { pending: true } })),
      entry("B", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: { path: "a.py" } }), "A"),
    ].join("\n")
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0].tool?.arguments).toEqual({ path: "a.py" })
    expect((logs[0].tool?.meta as any)?.pending).toBeUndefined()
  })

  it("A → B → C chain keeps only C (intermediate B is also pruned)", () => {
    const raw = [
      entry("A", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: {} })),
      entry("B", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: { path: "a" } }), "A"),
      entry("C", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: { path: "a.py" } }), "B"),
    ].join("\n")
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0].tool?.arguments).toEqual({ path: "a.py" })
  })

  it("result replaces its own tool row (type flip preserved)", () => {
    const raw = [
      entry("A", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: { path: "a.py" } })),
      entry("B", progressBody({ logType: "result", toolCallId: "t1", toolName: "read_file", arguments: { path: "a.py" }, output: "content", success: true }), "A"),
    ].join("\n")
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(1)
    expect(logs[0].type).toBe("result")
    expect(logs[0].tool?.output).toBe("content")
  })

  it("legacy sessions without replacesUuid are unchanged", () => {
    // Entries produced by the pre-fix writer: every replaceLog appended a
    // standalone row. Parser must still return all of them (no silent data
    // loss on existing on-disk sessions).
    const raw = [
      entry("A", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: {} })),
      entry("B", progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: { path: "a.py" } })),
      entry("C", progressBody({ logType: "result", toolCallId: "t1", toolName: "read_file", output: "content", success: true })),
    ].join("\n")
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(3)
  })

  it("entries without a uuid (malformed/legacy) are never treated as replaced", () => {
    // Defensive: replacesUuid could in theory reference a uuid that never
    // existed (corrupt file, partial write). We should ignore the dangling
    // pointer and emit whatever valid entries we do see.
    const raw = [
      JSON.stringify(progressBody({ logType: "tool", toolCallId: "t1", toolName: "read_file", arguments: { path: "a.py" } })),
      entry("B", progressBody({ logType: "tool", toolCallId: "t2", toolName: "bash", arguments: { command: "ls" } }), "NONEXISTENT"),
    ].join("\n")
    const logs = parseSessionJsonl(raw)
    expect(logs).toHaveLength(2)
  })

  it("writer starts a replace chain even when the first replace has no prior uuid", () => {
    const tmp = mkdtempSync(join(tmpdir(), "zap-session-replace-chain-"))
    try {
      const filePath = join(tmp, "session.jsonl")
      const writer = new __test.SessionWriter({
        filePath,
        sessionId: "session-test",
        registerExitHandler: false,
      })

      writer.appendReplace(3, "tool", "", {
        id: "t1",
        name: "read_file",
        arguments: {},
        meta: { pending: true },
      })
      writer.appendReplace(3, "tool", "", {
        id: "t1",
        name: "read_file",
        arguments: { path: "a.py" },
      })
      __test.flushWriter(writer)

      const logs = parseSessionJsonl(readFileSync(filePath, "utf-8"))

      expect(logs).toHaveLength(1)
      expect(logs[0].tool?.arguments).toEqual({ path: "a.py" })
      expect((logs[0].tool?.meta as any)?.pending).toBeUndefined()
      writer.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
