import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlRuntimeEventStore,
  RuntimeEventStoreCorruptionError,
} from "../../runtime/event-store.js";
import type { RuntimeEvent } from "../../runtime/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempStore(): Promise<JsonlRuntimeEventStore> {
  const directory = await mkdtemp(join(tmpdir(), "zap-runtime-events-"));
  tempDirs.push(directory);
  return new JsonlRuntimeEventStore({ directory });
}

function event(sequence: number, threadId = "thread/unsafe", text = "test"): RuntimeEvent {
  const time = 1_000 + sequence;
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    timestamp: time,
    threadId,
    turnId: "turn-1",
    runId: "run-1",
    payload: {
      type: "turn_started",
      thread: { threadId, status: "running", createdAt: 1_000, updatedAt: time, activeTurnId: "turn-1" },
      turn: {
        turnId: "turn-1",
        threadId,
        rootRunId: "run-1",
        status: "running",
        createdAt: time,
        updatedAt: time,
      },
      run: {
        runId: "run-1",
        threadId,
        turnId: "turn-1",
        agentType: "root",
        task: text,
        status: "running",
        sequence: 1,
        createdAt: time,
        updatedAt: time,
      },
      item: {
        itemId: `item-${sequence}`,
        threadId,
        turnId: "turn-1",
        runId: "run-1",
        type: "message",
        role: "user",
        text,
        createdAt: time,
      },
    },
  };
}

describe("JsonlRuntimeEventStore", () => {
  it("coalesces chunks arriving during I/O and keeps read, close and append acknowledgements ordered", async () => {
    const store = await tempStore();
    const internals = store as any;
    const index = await internals.getEventIndex();
    const appended = spyOn(index, "append");
    const prepare = internals.prepareThread.bind(store);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    internals.prepareThread = async (threadId: string) => { await gate; return prepare(threadId); };
    const writes = [store.append(event(1))];
    await Promise.resolve(); await Promise.resolve();
    for (let i = 2; i <= 256; i++) {
      writes.push(store.append(event(i)));
      await Promise.resolve();
    }
    let acknowledged = false;
    void writes.at(-1)!.then(() => { acknowledged = true; });
    const read = store.page("thread/unsafe", { direction: "backward", limit: 2 });
    expect(acknowledged).toBe(false);
    release();
    await Promise.all(writes);
    expect((await read).items.map(item => item.sequence)).toEqual([255, 256]);
    expect(appended.mock.calls).toHaveLength(1); // Initial replace, then one accumulated batch.
    const directory = store.directory;
    await store.close();
    const reopened = new JsonlRuntimeEventStore({ directory });
    expect((await reopened.list("thread/unsafe")).map(item => item.sequence)).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
    await reopened.close();
  });

  it("rejects every queued append and reader when an in-flight write fails", async () => {
    const store = await tempStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (store as any).prepareThread = async () => { await gate; throw new Error("injected disk failure"); };
    const pending: Promise<unknown>[] = [];
    for (let i = 1; i <= 128; i++) {
      pending.push(store.append(event(i)).catch(error => error));
      await Promise.resolve();
    }
    const read = store.latestSequence("thread/unsafe").catch(error => error);
    release();
    expect((await Promise.all(pending)).every(error => error instanceof Error && error.message === "injected disk failure")).toBe(true);
    expect(await read).toMatchObject({ message: "injected disk failure" });
    await expect(store.append(event(129))).rejects.toThrow("injected disk failure");
    await expect(store.close()).rejects.toThrow("injected disk failure");
  });

  it("persists ordered events in a hashed private thread file", async () => {
    const store = await tempStore();
    await Promise.all([store.append(event(1)), store.append(event(2))]);

    expect(store.filePath("thread/unsafe")).not.toContain("thread/unsafe");
    expect(await store.latestSequence("thread/unsafe")).toBe(2);
    expect((await store.list("thread/unsafe", { afterSequence: 1 })).map((item) => item.sequence)).toEqual([2]);
    expect((await readFile(store.filePath("thread/unsafe"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("deduplicates both prior history and the current batch without losing old IDs", async () => {
    const store = await tempStore();
    await store.append(event(1));
    await Promise.all([store.append(event(1)), store.append(event(2)), store.append(event(2))]);
    await Promise.all([store.append(event(1)), store.append(event(3))]);
    expect((await store.list("thread/unsafe")).map(item => item.sequence)).toEqual([1, 2, 3]);
    await expect(store.append(event(1, "thread/unsafe", "conflicting payload"))).rejects.toThrow("ID conflict");
    const rows = (await readFile(store.filePath("thread/unsafe"), "utf8")).trim().split("\n");
    expect(rows).toHaveLength(3);
  });

  it("rejects non-monotonic event sequences", async () => {
    const store = await tempStore();
    await store.append(event(2));
    await expect(store.append({ ...event(2), eventId: "different-event" })).rejects.toThrow("must increase");
  });

  it("pages older and newer windows with exclusive cursors", async () => {
    const store = await tempStore();
    await Promise.all(Array.from({ length: 6 }, (_, index) => store.append(event(index + 1))));

    const newest = await store.page("thread/unsafe", { direction: "backward", limit: 2 });
    expect(newest.items.map((item) => item.sequence)).toEqual([5, 6]);
    expect(newest.firstSequence).toBe(5);
    expect(newest.lastSequence).toBe(6);
    expect(newest.hasMoreBefore).toBe(true);
    expect(newest.hasMoreAfter).toBe(false);

    const older = await store.page("thread/unsafe", {
      direction: "backward",
      beforeSequence: newest.firstSequence,
      limit: 2,
    });
    expect(older.items.map((item) => item.sequence)).toEqual([3, 4]);
    expect(older.hasMoreBefore).toBe(true);
    expect(older.hasMoreAfter).toBe(true);

    const resumed = await store.page("thread/unsafe", {
      afterSequence: 4,
      direction: "forward",
      limit: 1,
    });
    expect(resumed.items.map((item) => item.sequence)).toEqual([5]);
    expect(resumed.hasMoreAfter).toBe(true);
  });

  it("maintains a private content-free index and lists threads by recent activity", async () => {
    const store = await tempStore();
    await store.append(event(1, "thread-old", "TOP_SECRET_PROMPT"));
    await store.append(event(1, "thread-new", "another secret"));
    await store.append({ ...event(2, "thread-new"), timestamp: 9_999 });

    const summaries = await store.listThreads();
    expect(summaries.map((summary) => summary.threadId)).toEqual(["thread-new", "thread-old"]);
    expect(summaries[0]).toMatchObject({ latestSequence: 2, eventCount: 2 });
    expect(store.indexFile).not.toBe(false);
    const indexPath = store.indexFile as string;
    expect((await readFile(indexPath)).includes(Buffer.from("TOP_SECRET_PROMPT"))).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rebuilds a missing or corrupt index from authoritative JSONL", async () => {
    const store = await tempStore();
    await store.append(event(1));
    await store.append(event(2));
    const indexPath = store.indexFile as string;
    const directory = store.directory;
    await store.close();

    await rm(indexPath, { force: true });
    const missing = new JsonlRuntimeEventStore({ directory });
    expect((await missing.listThreads())[0]).toMatchObject({
      threadId: "thread/unsafe",
      latestSequence: 2,
      eventCount: 2,
    });
    await missing.close();

    await writeFile(indexPath, "not a sqlite database", "utf8");
    const errors: string[] = [];
    const corrupt = new JsonlRuntimeEventStore({
      directory,
      onIndexError: (error) => { errors.push(error.message); },
    });
    expect((await corrupt.listThreads())[0]?.latestSequence).toBe(2);
    expect(errors.length).toBe(1);
    expect((await readdir(directory)).some((name) => name.startsWith("index.sqlite.corrupt-"))).toBe(true);
    await corrupt.close();
  });

  it("rejects invalid cursor ranges and v2 events without correlation identity", async () => {
    const store = await tempStore();
    await store.append(event(1));
    await expect(store.page("thread/unsafe", {
      afterSequence: 2,
      beforeSequence: 2,
    })).rejects.toThrow("less than");

    const path = store.filePath("thread/unsafe");
    const invalidV2 = { ...event(2), schemaVersion: 2 };
    await writeFile(path, `${JSON.stringify(event(1))}\n${JSON.stringify(invalidV2)}\n`, "utf8");
    const reopened = new JsonlRuntimeEventStore({ directory: store.directory });
    await expect(reopened.list("thread/unsafe")).rejects.toBeInstanceOf(RuntimeEventStoreCorruptionError);
  });

  it("ignores a partial crash tail but rejects corruption in completed lines", async () => {
    const store = await tempStore();
    await store.append(event(1));
    const path = store.filePath("thread/unsafe");
    const valid = await readFile(path, "utf8");
    await writeFile(path, `${valid}{\"schemaVersion\":1`, "utf8");
    expect((await store.list("thread/unsafe")).map((item) => item.sequence)).toEqual([1]);

    const recovered = new JsonlRuntimeEventStore({ directory: store.directory });
    await recovered.append(event(2));
    expect((await recovered.list("thread/unsafe")).map((item) => item.sequence)).toEqual([1, 2]);

    await writeFile(path, `${valid}not-json\n`, "utf8");
    await expect(recovered.list("thread/unsafe")).rejects.toBeInstanceOf(RuntimeEventStoreCorruptionError);
  });
});
