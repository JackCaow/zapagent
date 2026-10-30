import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Keep module mocks in a subprocess: React/SDK singletons must not leak into
// unrelated app tests. Execute the actual hook with deferred MCP resolution.
const fixture = `
  import { mock } from "bun:test";
  import * as react from "react";
  const realSubmit = await import("./src/commands/submit.ts");
  const mode = process.env.QUEUE_FIXTURE;
  const recovery = ["recovery", "model", "missing-model"].includes(mode);
  const histories = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mock.module("react", () => ({ ...react, useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: () => {} }));
  mock.module("./src/ui/prompt.tsx", () => ({ pushHistory: (...args) => histories.push(args) }));
  mock.module("./src/commands/submit.ts", () => ({ ...realSubmit,
    resolveMCPReferences: () => mode === "resource" ? gate : Promise.resolve([]) }));
  mock.module("./src/singletons.ts", () => ({ getMCPManager: () => ({ renderPrompt: () => gate }) }));
  const { useTurnDispatcher, blockedPastedInputLabels } = await import("./src/hooks/useTurnDispatcher.ts");
  const { getMessageQueue } = await import("./src/queue/inputQueue.ts");
  const queue = getMessageQueue();
  let goalStore, ownGoal, otherGoal;
  if (mode === "goal") {
    const { GoalStore } = await import("./zapsdk/goal/store.ts");
    const { goalDatabasePath } = await import("./src/goal-command.ts");
    goalStore = new GoalStore(goalDatabasePath());
    ownGoal = goalStore.create({ objective: "mine", cwd: process.cwd(), sessionId: queue.getSessionId() });
    otherGoal = goalStore.create({ objective: "other", cwd: process.cwd(), sessionId: "another-chat" });
  }
  const markers = "[Pasted #1 · 1 lines · 7 chars] [Image #1]";
  const raw = mode === "recovery" ? "/connect" : recovery ? "/model [Pasted #1 · 1 lines · 7 chars]" : mode === "prompt" ? "/mcp.demo.ask " + markers : markers + " @demo:resource";
  let input = raw;
  const pasteStore = { current: new Map([[1, "  code\\n"]]) };
  if (mode === "missing-model") pasteStore.current.clear();
  let images = [{ id: 1, content: { type: "image", filePath: "/tmp/review-fixture.png", mediaType: "image/png", source: "file", base64: "AQ==" } }];
  const commands = [], errors = [], logs = [];
  if (recovery) { const a = queue.enqueue({ text: "hi", displayForm: "hi" }); queue.fail(a.id, "provider missing"); }
  const opts = {
    isRunning: !recovery, inputQueue: queue.getSnapshot(), systemInboxSize: 0, followUpMode: "queue",
    addLog: (type, text) => { logs.push([type, text]); if (type === "error") errors.push(text); }, addToast: () => {},
    dispatchUserTurn: async () => { throw new Error("must not call provider"); },
    dispatchCommand: async text => { commands.push(text); return true; }, precheckProvider: () => false,
    slashOpen: false, slashEntries: [], slashIdx: 0, expandPastes: value => value,
    pasteStoreRef: pasteStore, pasteCounterRef: { current: 1 }, imageCounterRef: { current: 1 }, attachImageWithPlaceholder: () => {},
    setInputValue: next => { input = typeof next === "function" ? next(input) : next; }, getInputValue: () => input,
    pendingImages: images, setPendingImages: next => { images = typeof next === "function" ? next(images) : next; }
  };
  const { handleSubmit } = useTurnDispatcher(opts);
  const pending = handleSubmit(raw);
  if (!recovery) input = raw + " continued draft";
  release(mode === "prompt" ? [{ content: "rendered task" }] : []);
  await pending;
  const before = { input, pasteIds: [...pasteStore.current.keys()], imageIds: images.map(image => image.id),
    blocked: blockedPastedInputLabels(input, pasteStore.current), queue: queue.getSnapshot(), commands: [...commands], errors: [...errors], histories, logs };
  if (!recovery) await handleSubmit(input);
  console.log(JSON.stringify({ before, after: { input, queue: queue.getSnapshot(), errors },
    goalStates: goalStore ? [goalStore.get(ownGoal.id).status, goalStore.get(otherGoal.id).status] : undefined }));
  goalStore?.close();
`

describe("background wake-up dispatch", () => {
  for (const mode of ["human-first", "blocked", "unavailable", "failure", "during-turn"]) {
    it(`${mode} preserves delivery ownership`, () => {
      const directory = mkdtempSync(join(tmpdir(), "zap-event-dispatch-"))
      const script = `
        import { mock } from "bun:test";
        import * as react from "react";
        const effects = [];
        mock.module("react", () => ({ ...react, useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => effects.push(fn) }));
        mock.module("./src/singletons.ts", () => ({ getMCPManager: () => undefined }));
        const { useTurnDispatcher } = await import("./src/hooks/useTurnDispatcher.ts");
        const { getMessageQueue } = await import("./src/queue/inputQueue.ts");
        const { pushSystemEvent, getSystemInboxLength } = await import("./src/queue/systemInbox.ts");
        const mode = process.env.EVENT_DISPATCH_MODE, calls = [], errors = [];
        const queue = getMessageQueue();
        if (mode === "human-first") queue.enqueue({ text: "human steering", displayForm: "human steering" });
        let delivered = 0;
        const event = { kind: "task-notification", payload: "exit notification", ts: 1, taskId: "t1", onDelivered: () => { delivered++; } };
        pushSystemEvent(event);
        const opts = { isRunning: false, inputQueue: queue.getSnapshot(), systemInboxSize: 1,
          getTodos: () => mode === "blocked" ? [{ content: "work", activeForm: "working", status: "blocked", blocked: { reason: "needs reply", waitingFor: "user" } }] : [],
          addLog: (type, text) => { if (type === "error") errors.push(text); }, addToast: () => {}, precheckProvider: () => mode !== "unavailable",
          dispatchCommand: async () => true,
          dispatchUserTurn: async (text, _system, _images, _display, silent, _restore, _query, accept) => {
            calls.push(silent ? "event" : "human");
            if (mode === "failure") throw new Error("not accepted");
            accept();
            if (mode === "during-turn" && calls.length === 1) pushSystemEvent({ ...event, taskId: "t2" });
            return { stopped: "end_turn" };
          },
          slashOpen: false, slashEntries: [], slashIdx: 0, expandPastes: x => x, pasteStoreRef: { current: new Map() }, pasteCounterRef: { current: 0 }, imageCounterRef: { current: 0 },
          attachImageWithPlaceholder: () => {}, setInputValue: () => {}, pendingImages: [], setPendingImages: () => {}
        };
        useTurnDispatcher(opts); effects.pop()(); await new Promise(resolve => setTimeout(resolve, 25));
        console.log(JSON.stringify({ calls, delivered, pending: getSystemInboxLength(), errors }));
      `
      try {
        const child = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ZAPCODE_DATA_DIR: directory, EVENT_DISPATCH_MODE: mode } })
        expect(child.status).toBe(0)
        const result = JSON.parse(child.stdout)
        if (mode === "human-first") expect(result).toEqual({ calls: ["human", "event"], delivered: 1, pending: 0, errors: [] })
        else if (mode === "during-turn") expect(result).toEqual({ calls: ["event", "event"], delivered: 2, pending: 0, errors: [] })
        else if (mode === "failure") { expect(result.calls).toEqual(["event"]); expect(result.pending).toBe(1); expect(result.delivered).toBe(0) }
        else expect(result).toEqual({ calls: [], delivered: 0, pending: 1, errors: [] })
      } finally { rmSync(directory, { recursive: true, force: true }) }
    })
  }
})

describe("queued input resolution through the real submit hook", () => {
  for (const mode of ["resource", "prompt", "recovery", "model", "missing-model", "goal"]) {
    it(`${mode} preserves draft ownership or permits provider repair`, () => {
      const directory = mkdtempSync(join(tmpdir(), "zap-queue-hook-"))
      try {
        const child = spawnSync(process.execPath, ["-e", fixture], { cwd: process.cwd(), encoding: "utf8",
          env: { ...process.env, ZAPCODE_DATA_DIR: directory, QUEUE_FIXTURE: mode } })
        expect(child.stderr).toBe("")
        expect(child.status).toBe(0)
        const result = JSON.parse(child.stdout)
        if (mode === "goal") expect(result.goalStates).toEqual(["paused", "created"])
        if (["recovery", "model", "missing-model"].includes(mode)) {
          expect(result.before.queue.map((entry: { text: string; state: string }) => [entry.text, entry.state])).toEqual([["hi", "failed"]])
          if (mode === "missing-model") {
            expect(result.before.errors).toHaveLength(1)
            expect(result.before.errors[0]).toContain("no longer available")
            expect(result.before.commands).toEqual([])
            expect(result.before.histories).toEqual([])
            expect(result.before.input).toContain("[Pasted #1")
          } else {
            expect(result.before.errors).toEqual([])
            expect(result.before.input).toBe("")
            expect(result.before.commands).toEqual([mode === "model" ? "/model   code\n" : "/connect"])
            expect(result.before.histories).toHaveLength(1)
            expect(result.before.logs[0][0]).toBe("user")
            if (mode === "model") {
              expect(result.before.histories[0][1]).toEqual({ "1": "  code\n" })
              expect(result.before.pasteIds).toEqual([])
            }
          }
        } else {
          expect(result.before.errors).toEqual([])
          expect(result.before.input).toContain("continued draft")
          expect(result.before.pasteIds).toEqual([1])
          expect(result.before.imageIds).toEqual([1])
          expect(result.before.blocked).toEqual([])
          expect(result.before.queue[0].images[0].id).toBe(1)
          expect(result.after.queue).toHaveLength(2)
          expect(result.after.errors).toEqual([])
        }
      } finally { rmSync(directory, { recursive: true, force: true }) }
    })
  }
})

describe("rewind owns queue delivery until its dialog closes", () => {
  for (const mode of ["paused", "open-command"]) {
    it(`${mode} keeps the follow-up queued and resumes after close`, () => {
      const directory = mkdtempSync(join(tmpdir(), "zap-rewind-queue-"))
      const script = `
        import { mock } from "bun:test";
        import * as react from "react";
        const effects = [];
        mock.module("react", () => ({ ...react, useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => effects.push(fn) }));
        mock.module("./src/singletons.ts", () => ({ getMCPManager: () => undefined }));
        const { useTurnDispatcher } = await import("./src/hooks/useTurnDispatcher.ts");
        const { getMessageQueue } = await import("./src/queue/inputQueue.ts");
        const queue = getMessageQueue(), calls = [];
        const mode = process.env.REWIND_QUEUE_MODE;
        if (mode === "open-command") queue.enqueue({ text: "/rewind", displayForm: "/rewind" });
        queue.enqueue({ text: "follow up", displayForm: "follow up" });
        const opts = { isRunning: false, paused: mode === "paused", inputQueue: queue.getSnapshot(), systemInboxSize: 0,
          addLog: () => {}, addToast: () => {}, precheckProvider: () => true,
          dispatchCommand: async () => true,
          dispatchUserTurn: async (_text, _system, _images, _display, _silent, _restore, _query, accept) => { calls.push("model"); accept(); return { stopped: "end_turn" }; },
          slashOpen: false, slashEntries: [], slashIdx: 0, expandPastes: x => x, pasteStoreRef: { current: new Map() }, pasteCounterRef: { current: 0 }, imageCounterRef: { current: 0 },
          attachImageWithPlaceholder: () => {}, setInputValue: () => {}, pendingImages: [], setPendingImages: () => {}
        };
        useTurnDispatcher(opts); effects.pop()(); await new Promise(resolve => setTimeout(resolve, 25));
        const before = { calls: [...calls], queued: queue.getSnapshot().map(entry => entry.text) };
        useTurnDispatcher({ ...opts, paused: false }); effects.pop()(); await new Promise(resolve => setTimeout(resolve, 25));
        console.log(JSON.stringify({ before, calls, remaining: queue.getSnapshot().length }));
      `
      try {
        const child = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ZAPCODE_DATA_DIR: directory, REWIND_QUEUE_MODE: mode } })
        expect(child.status).toBe(0)
        const result = JSON.parse(child.stdout)
        expect(result.before).toEqual({ calls: [], queued: ["follow up"] })
        expect(result.calls).toEqual(["model"])
        expect(result.remaining).toBe(0)
      } finally { rmSync(directory, { recursive: true, force: true }) }
    })
  }
})

for (const action of ["status", "pause", "cancel", "background"]) {
  it(`dispatches Goal ${action} immediately while the normal turn queue is busy`, () => {
    const directory = mkdtempSync(join(tmpdir(), "zap-goal-control-"))
    const script = `
      import { mock } from "bun:test";
      import * as react from "react";
      mock.module("react", () => ({ ...react, useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: () => {} }));
      mock.module("./src/ui/prompt.tsx", () => ({ pushHistory() {} }));
      mock.module("./src/singletons.ts", () => ({ getMCPManager: () => undefined }));
      const { useTurnDispatcher } = await import("./src/hooks/useTurnDispatcher.ts");
      const { getMessageQueue } = await import("./src/queue/inputQueue.ts");
      const queue = getMessageQueue(), commands = [];
      queue.enqueue({text:"waiting ordinary message",displayForm:"waiting ordinary message"});
      let input = "/goal " + process.env.GOAL_CONTROL;
      const options = { isRunning: true, inputQueue: queue.getSnapshot(), systemInboxSize: 0,
        addLog() {}, addToast() {}, precheckProvider: () => false,
        dispatchCommand: async text => { commands.push(text); return true; }, dispatchUserTurn: async () => { throw Error("Must remain queued"); },
        slashOpen: false, slashEntries: [], slashIdx: 0, expandPastes: x => x,
        pasteStoreRef: {current:new Map()}, pasteCounterRef:{current:0}, imageCounterRef:{current:0}, attachImageWithPlaceholder() {},
        setInputValue: next => {input=typeof next==="function"?next(input):next}, pendingImages:[], setPendingImages() {}
      };
      await useTurnDispatcher(options).handleSubmit(input);
      console.log(JSON.stringify({commands,input,queue:queue.getSnapshot().map(x=>x.text)}));
    `
    try {
      const child = spawnSync(process.execPath, ["-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ZAPCODE_DATA_DIR: directory, GOAL_CONTROL: action } })
      if (child.status !== 0) throw new Error(child.stderr)
      expect(JSON.parse(child.stdout)).toEqual({ commands: [`/goal ${action}`], input: "", queue: ["waiting ordinary message"] })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}
