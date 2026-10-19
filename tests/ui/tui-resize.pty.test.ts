import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

// Opt-in local PTY regression. Uses a private tmux server and disposable data,
// never the user's session or provider credentials.
const ptyTest = process.env.RUN_TUI_PTY_TESTS === "1" ? it : it.skip
ptyTest("keeps chat/input intact across resize, paste, focus and modal transitions", async () => {
  const data = mkdtempSync(join(tmpdir(), "zap-tui-regression-"))
  const socket = `zap-ui-${process.pid}-${Date.now()}`
  const tmux = (...args: string[]) => {
    const result = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr || String(result.error))
    return result.stdout
  }
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  const capture = () => tmux("capture-pane", "-p", "-t", "ui")
  const settle = async (predicate: (screen: string) => boolean) => {
    let screen = ""
    for (let attempt = 0; attempt < 60; attempt++) {
      screen = capture()
      if (predicate(screen)) return screen
      await sleep(50)
    }
    throw new Error(`Terminal did not settle:\n${screen}`)
  }
  const check = async (message: string) => {
    const screen = await settle(text => text.includes(message) && text.includes("FOOTER_READY"))
    expect(screen.split("FOOTER_READY")).toHaveLength(2)
    expect(screen.split("\n").filter(line => /^─{5,}\s*$/.test(line))).toHaveLength(2)
    return screen
  }
  const checkCursor = (screen: string, marker: string) => {
    const [y, x] = tmux("display-message", "-p", "-t", "ui", "#{cursor_y}:#{cursor_x}").trim().split(":").map(Number)
    const lines = screen.split("\n")
    const row = lines.findIndex(line => line.includes(marker))
    expect(y).toBe(row)
    expect(x).toBe(lines[row]!.indexOf(marker) + marker.length)
  }
  try {
    tmux("new-session", "-d", "-s", "ui", "-x", "120", "-y", "32",
      `exec env ZAPCODE_DATA_DIR=${quote(data)} ${quote(process.execPath)} ${quote(resolve("tests/fixtures/tui-resize.tsx"))}`)
    await check("ASSISTANT_VISIBLE")
    tmux("send-keys", "-t", "ui", "-l", "SUBMITTED_VISIBLE")
    await check("SUBMITTED_VISIBLE")
    tmux("send-keys", "-t", "ui", "Enter")
    await settle(text => text.includes("› SUBMITTED_VISIBLE"))
    const paste = "   • 安吉这行包含前后空白 PASTE_VISIBLE   \n"
    tmux("send-keys", "-t", "ui", "-l", `\x1b[200~${paste}\x1b[201~`)
    await check("PASTE_VISIBLE")
    for (const [width, height] of [[82, 32], [150, 40], [60, 28], [120, 32]]) {
      tmux("resize-window", "-t", "ui", "-x", String(width), "-y", String(height))
      await sleep(250)
      const screen = await check("PASTE_VISIBLE")
      // Native terminal resize may move committed rows into scrollback.
      // They must remain there exactly once, rather than be erased/replayed.
      const history = tmux("capture-pane", "-p", "-S", "-100", "-t", "ui")
      expect(history.split("ASSISTANT_VISIBLE")).toHaveLength(2)
      expect(history.split("SUBMITTED_VISIBLE")).toHaveLength(2)
      expect(screen.split("PASTE_VISIBLE")).toHaveLength(2)
    }
    for (let i = 0; i < 2; i++) {
      tmux("send-keys", "-t", "ui", "C-g")
      await sleep(150)
      await check("PASTE_VISIBLE")
    }
    tmux("send-keys", "-t", "ui", "C-o")
    await settle(text => text.includes("DIALOG_VISIBLE") && !text.includes("PASTE_VISIBLE"))
    tmux("resize-window", "-t", "ui", "-x", "90", "-y", "32")
    await sleep(250)
    tmux("send-keys", "-t", "ui", "C-o")
    await check("PASTE_VISIBLE")
    tmux("send-keys", "-t", "ui", "C-s")
    await settle(text => text.includes("STREAM_VISIBLE"))
    tmux("resize-window", "-t", "ui", "-x", "70", "-y", "32")
    await sleep(250)
    await check("STREAM_VISIBLE")
    tmux("send-keys", "-t", "ui", "C-s")
    await settle(text => !text.includes("STREAM_VISIBLE"))
    await check("PASTE_VISIBLE")
    tmux("send-keys", "-t", "ui", "Enter")
    await sleep(150)
    tmux("send-keys", "-t", "ui", "-l", `\x1b[200~${"长行文字 ".repeat(20)}\nWRAPPED_TAIL_VISIBLE\x1b[201~`)
    await sleep(150)
    const multilineScreen = await check("WRAPPED_TAIL_VISIBLE")
    checkCursor(multilineScreen, "WRAPPED_TAIL_VISIBLE")
    for (const width of [100, 55, 110]) {
      tmux("resize-window", "-t", "ui", "-x", String(width))
      await sleep(250)
      checkCursor(await check("WRAPPED_TAIL_VISIBLE"), "WRAPPED_TAIL_VISIBLE")
    }
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"])
    rmSync(data, { recursive: true, force: true })
  }
}, 20000)
