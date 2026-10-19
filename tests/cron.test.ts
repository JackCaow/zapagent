import { describe, it, expect } from "bun:test";
import { cronTools, type CronFireEvent } from "../zapsdk/builtin-tools/cron.js";

// All tests use an injected `now` so we don't rely on real time or setInterval.
// The scheduler's setInterval still runs (can't disable it without refactor)
// but we never wait on it — we drive fires manually via handle.tick().

function collectFires() {
  const fires: CronFireEvent[] = [];
  return { fires, onFire: (e: CronFireEvent) => fires.push(e) };
}

describe("cron tools — session-only scheduler", () => {
  it("creates a recurring job and fires it on tick", async () => {
    let t = Date.parse("2026-04-24T00:00:00.000Z");
    const { fires, onFire } = collectFires();
    const h = cronTools({ onFire, now: () => t, tickMs: 1_000_000 });

    const res = await h.cronCreate.handler({
      cron: "* * * * *",
      prompt: "ping",
      recurring: true,
    });
    expect(res.success).toBe(true);
    const created = JSON.parse(res.output);
    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    expect(created.recurring).toBe(true);

    // First "next" should be at or after :01:00 UTC.
    const next = Date.parse(created.next);
    expect(next).toBeGreaterThanOrEqual(Date.parse("2026-04-24T00:01:00.000Z"));

    // Advance clock past next, tick, and expect one fire.
    t = next + 1000;
    h.tick();
    expect(fires).toHaveLength(1);
    expect(fires[0].prompt).toBe("ping");
    expect(fires[0].recurring).toBe(true);

    // Job should still be there (recurring) with next advanced.
    const snap = h.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].next).toBeGreaterThan(t);
    expect(snap[0].lastFiredAt).toBe(t);

    h.stop();
  });

  it("auto-deletes one-shot jobs after first fire", async () => {
    let t = Date.parse("2026-04-24T00:00:00.000Z");
    const { fires, onFire } = collectFires();
    const h = cronTools({ onFire, now: () => t, tickMs: 1_000_000 });

    const res = await h.cronCreate.handler({
      cron: "* * * * *",
      prompt: "once",
      recurring: false,
    });
    const { id, next } = JSON.parse(res.output);

    t = Date.parse(next) + 1000;
    h.tick();

    expect(fires).toHaveLength(1);
    expect(fires[0].recurring).toBe(false);
    expect(h.snapshot()).toHaveLength(0);

    // Deleting a now-missing id is an error.
    const del = await h.cronDelete.handler({ id });
    expect(del.success).toBe(false);

    h.stop();
  });

  it("rejects invalid cron expressions", async () => {
    const h = cronTools();
    const res = await h.cronCreate.handler({ cron: "not a cron", prompt: "x" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid cron expression");
    h.stop();
  });

  it("enforces the max-jobs cap", async () => {
    const h = cronTools({ maxJobs: 2, tickMs: 1_000_000 });
    await h.cronCreate.handler({ cron: "* * * * *", prompt: "a" });
    await h.cronCreate.handler({ cron: "* * * * *", prompt: "b" });
    const third = await h.cronCreate.handler({ cron: "* * * * *", prompt: "c" });
    expect(third.success).toBe(false);
    expect(third.error).toContain("limit reached");
    expect(h.snapshot()).toHaveLength(2);
    h.stop();
  });

  it("cron_list reports all active jobs with next + lastFiredAt", async () => {
    let t = Date.parse("2026-04-24T00:00:00.000Z");
    const h = cronTools({ now: () => t, tickMs: 1_000_000 });
    const a = JSON.parse(
      (await h.cronCreate.handler({ cron: "0 9 * * *", prompt: "morning" })).output,
    );
    await h.cronCreate.handler({ cron: "0 18 * * *", prompt: "evening" });

    const listRes = await h.cronList.handler({});
    expect(listRes.success).toBe(true);
    const { jobs } = JSON.parse(listRes.output);
    expect(jobs).toHaveLength(2);
    const entry = jobs.find((j: { id: string }) => j.id === a.id);
    expect(entry.humanSchedule).toBe("Daily at 09:00");
    expect(entry.lastFiredAt).toBeUndefined();

    h.stop();
  });

  it("cron_delete removes a job", async () => {
    const h = cronTools({ tickMs: 1_000_000 });
    const created = JSON.parse(
      (await h.cronCreate.handler({ cron: "* * * * *", prompt: "x" })).output,
    );
    const del = await h.cronDelete.handler({ id: created.id });
    expect(del.success).toBe(true);
    expect(h.snapshot()).toHaveLength(0);
    h.stop();
  });

  it("stamps ownerAgentId on created jobs when agentId is set", async () => {
    const sub = cronTools({ tickMs: 1_000_000, agentId: "sa_X" });
    await sub.cronCreate.handler({ cron: "0 9 * * *", prompt: "morning" });
    expect(sub.snapshot()[0].ownerAgentId).toBe("sa_X");
    const list = JSON.parse((await sub.cronList.handler({})).output);
    expect(list.jobs).toHaveLength(1);
    sub.stop();
  });

  it("leaves ownerAgentId unset when agentId is undefined (team-lead)", async () => {
    const main = cronTools({ tickMs: 1_000_000 });
    await main.cronCreate.handler({ cron: "0 9 * * *", prompt: "x" });
    expect(main.snapshot()[0].ownerAgentId).toBeUndefined();
    main.stop();
  });

  it("fire event carries ownerAgentId", async () => {
    let t = Date.parse("2026-04-24T00:00:00.000Z");
    const fires: Array<{ ownerAgentId?: string }> = [];
    const h = cronTools({
      onFire: (e) => fires.push(e),
      now: () => t,
      tickMs: 1_000_000,
      agentId: "sa_Y",
    });
    const r = JSON.parse(
      (await h.cronCreate.handler({ cron: "* * * * *", prompt: "p" })).output,
    );
    t = Date.parse(r.next) + 1000;
    h.tick();
    expect(fires).toHaveLength(1);
    expect(fires[0].ownerAgentId).toBe("sa_Y");
    h.stop();
  });
});
