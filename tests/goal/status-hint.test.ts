import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

for (const otherChat of [false, true]) it(`targets the pinned Goal in diagnostic hints (other chat=${otherChat})`, () => {
  const data = mkdtempSync(join(tmpdir(), "goal-status-hint-"))
  try {
    const script = `
      import { goalCommand, goalDatabasePath } from ${JSON.stringify(resolve("src/goal-command.ts"))};
      import { goalActionText, readSessionGoalView } from ${JSON.stringify(resolve("src/goal-view.ts"))};
      import { GoalStore } from ${JSON.stringify(resolve("zapsdk/goal/store.ts"))};
      let older, newer, selected;
      const cwd = process.cwd(), session = "current-chat";
      const command = (args, chat = session, foreground = () => {}) =>
        goalCommand(args, cwd, "default", "linux", chat, foreground, true, goal => { selected = goal });
      command(["Older Goal"], ${otherChat ? '"other-chat"' : 'session'}, goal => { older = goal });
      command(["Newer Goal"], session, goal => { newer = goal });
      command(["resume", older.id]);
      const store = new GoalStore(goalDatabasePath());
      const claimed = store.claim(older.id, "fixture", process.pid);
      store.release(older.id, claimed.ownerEpoch, "fixture", "blocked", "FIXTURE_BLOCKED");
      store.close();
      const view = readSessionGoalView(cwd, session, selected.id);
      const statuses = ["blocked", "failed"].map(status => {
        const hint = goalActionText({ ...view, status }, false);
        const id = hint.match(/\\/goal status (goal_[a-z0-9-]+)/)?.[1];
        return { status, id, output: command(id ? ["status", id] : ["status"]).split("\\n")[1] };
      });
      console.log(JSON.stringify({ selected: view.id, older: older.id,
        bare: command(["status"]).split("\\n")[1], statuses }));
    `
    const child = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, ZAPCODE_DATA_DIR: data, ZAP_DISABLE_UPDATE_CHECK: "1" },
      encoding: "utf8", timeout: 15_000,
    })
    expect(child.error).toBeUndefined()
    if (child.status !== 0) throw new Error(child.stderr || `Child exited ${child.status}`)
    const result = JSON.parse(child.stdout)
    expect(result.selected).toBe(result.older)
    expect(result.bare).toBe("Newer Goal") // Preserve existing bare-command semantics.
    for (const status of result.statuses) {
      expect(status.id).toBe(result.older)
      expect(status.output).toBe("Older Goal")
    }
  } finally { rmSync(data, { recursive: true, force: true }) }
}, 20_000)
