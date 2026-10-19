import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreRecentFiles } from "../../context/restore-files.js";
import { turnToMessages, buildToolTurn } from "../../core/turn.js";
import { TokenCounter } from "../../context/token-counter.js";
import { ConversationManager } from "../../memory/conversation.js";
function read(path: string, output: string, success = true) {
  return turnToMessages(buildToolTurn({ text: "", completed: [{ id: "read-1", name: "read_file", arguments: { path }, result: { success, output } }] }));
}
describe("restoreRecentFiles", () => {
  it("reuses successful snapshots without reading changed host files or symlink targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zap-read-snapshot-"));
    try {
      const path = join(dir, "read.txt"), secret = join(dir, "unread.txt");
      await writeFile(path, "CURRENT_UNREAD_CONTENT"); await writeFile(secret, "NEW_LINK_TARGET");
      const messages = read(path, "RECORDED_AUTHORIZED_CONTENT");
      for (let i = 0; i < 2; i++) {
        const restored = await restoreRecentFiles(messages);
        expect(restored).toContain("RECORDED_AUTHORIZED_CONTENT");
        expect(restored).not.toContain("CURRENT_UNREAD_CONTENT"); expect(restored).not.toContain("NEW_LINK_TARGET");
        if (i === 0) { await unlink(path); await symlink(secret, path); }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not restore denied, failed, missing, or legacy unproven reads", async () => {
    expect(await restoreRecentFiles(read("/virtual/private", "denied", false))).toBeNull();
    const messages = read("/virtual/private", "snapshot");
    expect(await restoreRecentFiles(messages.slice(0, 1))).toBeNull();
    delete messages[1]!.toolResultSuccess;
    expect(await restoreRecentFiles(messages)).toBeNull();
    expect(await restoreRecentFiles([...read("same", "old"), ...read("same", "denied", false)])).toBeNull();
  });
  it("uses recorded backend content for relative and remote paths without resolving host paths", async () => {
    for (const path of ["relative.txt", "/guest/workspace/a.txt"]) {
      expect(await restoreRecentFiles(read(path, "remote snapshot"))).toContain("remote snapshot");
    }
  });
  it("matches reused call IDs only within their own tool group", async () => {
    const denied = read("private", "denied", false), success = read("public", "public snapshot");
    const result = await restoreRecentFiles([...denied, ...success]);
    expect(result).toContain("public snapshot"); expect(result).not.toContain("### private");
  });
  it("preserves denied status through conversation reconstruction", async () => {
    const cm = new ConversationManager({ maxMessages: 100 });
    cm.mutateInPlace(messages => messages.push(...read("private", "denied", false)));
    expect(await restoreRecentFiles(cm.getAllMessages())).toBeNull();
  });
  it("does not promote missing legacy status during conversation reconstruction", async () => {
    const legacy = read("private", "unproven output");
    delete legacy[1]!.toolResultSuccess;
    const cm = new ConversationManager({ maxMessages: 100 });
    legacy.forEach(message => cm.add(message));
    cm.mutateInPlace(() => {});
    expect(cm.getAllMessages()[1]?.toolResultSuccess).toBeUndefined();
    expect(await restoreRecentFiles(cm.getAllMessages())).toBeNull();
  });
  it("bounds the complete attachment and does not split Unicode or Markdown fences", async () => {
    const counter = new TokenCounter();
    const result = await restoreRecentFiles(read("line\nbreak.txt", "```ts\n" + "😀".repeat(10000)), { maxTokens: 100, counter });
    expect(result).toContain("### line break.txt"); expect(result).toContain("````");
    expect(result).toContain("truncated"); expect(counter.countText(result!)).toBeLessThanOrEqual(100);
    expect(Buffer.from(result!).toString()).toBe(result!);
    expect(await restoreRecentFiles(read("file", "content"), { maxTokens: 0 })).toBeNull();
  });
});
