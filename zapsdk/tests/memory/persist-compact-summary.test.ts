import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistCompactSummary } from "../../memory/persist-compact-summary.js";
import { parseMdFile } from "../../memory/md-frontmatter.js";
import { AutoMemory } from "../../memory/auto-memory.js";
import { getAppDataDir } from "../../utils/platform.js";
import { openMdStore } from "../../memory/md-store.js";
import { buildMdIndex } from "../../memory/md-pack.js";
import { countCodePoints } from "../../utils/logical-lines.js";

describe("persistCompactSummary", () => {
  it("writes compact state using the current markdown memory frontmatter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- keep memory out of the system prompt",
        "",
        "# Errors encountered and their resolution",
        "- cache usage was under-counted; normalized provider accounting",
        "",
        "# Files read / modified",
        "- zapsdk/core/providers/openai-compatible.ts",
      ].join("\n");

      const memPath = await persistCompactSummary(
        summary,
        { memoryDir: dir } as AutoMemory,
      );

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      const parsed = parseMdFile(readFileSync(memPath!, "utf-8"));
      expect(parsed?.frontmatter).toMatchObject({
        name: "project_compact_state",
        description: "Durable snapshot from the most recent compact pass — intent, user messages, status, facts, decisions, next steps, files, commands.",
        type: "project",
        tags: ["compact", "files", "pinned", "status", "summary"],
        source: "compact summary",
        lifecycle: {
          version: 1,
          confidence: "medium",
        },
        provenance: {
          updated: {
            origin: "compact_summary",
          },
        },
      });
      expect(parsed?.frontmatter.description).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(parsed?.body).toContain("keep memory out of the system prompt");
      const diskIndex = readFileSync(join(dir, "MEMORY.md"), "utf-8");
      const transientIndex = buildMdIndex(openMdStore(dir), { tokenBudget: 4000, query: "compact" }).text;
      expect(diskIndex).toContain("[project_compact_state](project_compact_state.md)");
      expect(diskIndex).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(transientIndex).toContain("[project_compact_state](project_compact_state.md)");
      expect(transientIndex).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy memory before writing compact summaries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-data-"));
    const prevDataDir = process.env.ZAPCODE_DATA_DIR;
    process.env.ZAPCODE_DATA_DIR = dataDir;
    const repo = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-repo-"));
    try {
      git(repo, "init");
      git(repo, "remote", "add", "origin", "https://github.com/acme/zapcode.git");

      const legacyDir = join(getAppDataDir(), "projects", repo.replace(/[\\/:]/g, "-"), "memory");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "MEMORY.md"), "- [old](old.md) — legacy memory\n");
      writeFileSync(join(legacyDir, "old.md"), "---\nname: old\ndescription: legacy memory\ntype: project\n---\n\nbody\n");

      const autoMemory = new AutoMemory(repo);
      expect(autoMemory.memoryDir).not.toBe(legacyDir);

      const memPath = await persistCompactSummary(
        "# Decisions made\n- keep compact memories durable",
        autoMemory,
      );

      expect(memPath).toBe(join(autoMemory.memoryDir, "project_compact_state.md"));
      expect(existsSync(join(autoMemory.memoryDir, "old.md"))).toBe(true);
      const index = readFileSync(join(autoMemory.memoryDir, "MEMORY.md"), "utf-8");
      expect(index).toContain("legacy memory");
      expect(index).toContain("[project_compact_state](project_compact_state.md)");
    } finally {
      if (prevDataDir === undefined) delete process.env.ZAPCODE_DATA_DIR;
      else process.env.ZAPCODE_DATA_DIR = prevDataDir;
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves createdAt across compact overwrites", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- first",
      ].join("\n");
      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const first = readFileSync(memPath!, "utf-8").match(/^createdAt:\s*(.+)$/m)?.[1];

      await persistCompactSummary("# Decisions made\n- second", { memoryDir: dir } as AutoMemory);
      const second = readFileSync(memPath!, "utf-8").match(/^createdAt:\s*(.+)$/m)?.[1];

      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a bounded recent compact timeline alongside the latest snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      await persistCompactSummary("# Decisions made\n- first decision", { memoryDir: dir } as AutoMemory);
      await persistCompactSummary("# Decisions made\n- second decision", { memoryDir: dir } as AutoMemory);

      const latest = parseMdFile(readFileSync(join(dir, "project_compact_state.md"), "utf-8"));
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const secondIndex = timeline?.body.indexOf("second decision") ?? -1;
      const firstIndex = timeline?.body.indexOf("first decision") ?? -1;

      expect(latest?.body).toContain("second decision");
      expect(latest?.body).not.toContain("first decision");
      expect(timeline?.frontmatter).toMatchObject({
        name: "project_compact_timeline",
        description: "Bounded recent compact history for recovering multi-stage task decisions.",
        type: "project",
        tags: ["compact", "history", "pinned", "status", "summary"],
        source: "compact summary",
      });
      expect(timeline?.frontmatter.description).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(secondIndex).toBeGreaterThanOrEqual(0);
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeLessThan(firstIndex);
      const diskIndex = readFileSync(join(dir, "MEMORY.md"), "utf-8");
      const transientIndex = buildMdIndex(openMdStore(dir), { tokenBudget: 4000, query: "compact" }).text;
      expect(diskIndex).toContain("[project_compact_timeline](project_compact_timeline.md)");
      expect(diskIndex).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(transientIndex).toContain("[project_compact_timeline](project_compact_timeline.md)");
      expect(transientIndex).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rewrite compact memory or duplicate timeline entries when extracted sections are unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Current task status",
        "- cache diagnostics are wired and passing",
        "",
        "# Decisions made",
        "- avoid rewriting compact memory when content is unchanged",
        "",
        "# Next steps",
        "- run focused tests",
      ].join("\n");

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateBefore = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateAfter = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const entries = timeline?.body.match(/<!-- zap-compact-snapshot:start -->/g) ?? [];

      expect(stateAfter).toBe(stateBefore);
      expect(entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recreates a missing compact timeline without rewriting unchanged compact state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- compact timeline should be repaired if missing",
        "",
        "# Next steps",
        "- continue memory-layer hardening",
      ].join("\n");

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateBefore = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      rmSync(join(dir, "project_compact_timeline.md"), { force: true });

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);

      const stateAfter = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      expect(stateAfter).toBe(stateBefore);
      expect(timeline?.body).toContain("compact timeline should be repaired if missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs a compact timeline that exists but has lost its snapshot entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- repair parseable but empty compact timeline",
        "",
        "# Next steps",
        "- continue memory-layer hardening",
      ].join("\n");

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateBefore = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      openMdStore(dir).save({
        name: "project_compact_timeline",
        description: "Bounded recent compact history for recovering multi-stage task decisions.",
        type: "project",
        tags: ["compact", "summary", "history", "status", "pinned"],
        source: "compact summary",
        body: "Recent compact snapshots, but snapshot markers were lost.\n",
      });

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);

      const stateAfter = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const entries = timeline?.body.match(/<!-- zap-compact-snapshot:start -->/g) ?? [];
      expect(stateAfter).toBe(stateBefore);
      expect(entries).toHaveLength(1);
      expect(timeline?.body).toContain("repair parseable but empty compact timeline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs a compact timeline that has entries but lost the latest snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Current task status",
        "- latest compact state should stay recoverable from timeline",
        "",
        "# Decisions made",
        "- repair stale compact timeline entries",
        "",
        "# Next steps",
        "- continue memory-layer hardening",
      ].join("\n");

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateBefore = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      openMdStore(dir).save({
        name: "project_compact_timeline",
        description: "Bounded recent compact history for recovering multi-stage task decisions.",
        type: "project",
        tags: ["compact", "summary", "history", "status", "pinned"],
        source: "compact summary",
        body: [
          "Recent compact snapshots, but only an older entry survived.",
          "",
          "<!-- zap-compact-snapshot:start -->",
          "## Snapshot 2026-07-01T00:00:00.000Z",
          "",
          "### Decisions made",
          "- old compact timeline entry",
          "<!-- zap-compact-snapshot:end -->",
          "",
        ].join("\n"),
      });

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);

      const stateAfter = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const latestIndex = timeline?.body.indexOf("latest compact state should stay recoverable from timeline") ?? -1;
      const oldIndex = timeline?.body.indexOf("old compact timeline entry") ?? -1;
      const entries = timeline?.body.match(/<!-- zap-compact-snapshot:start -->/g) ?? [];
      expect(stateAfter).toBe(stateBefore);
      expect(entries).toHaveLength(2);
      expect(latestIndex).toBeGreaterThanOrEqual(0);
      expect(oldIndex).toBeGreaterThanOrEqual(0);
      expect(latestIndex).toBeLessThan(oldIndex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate legacy timeline entries that already match the latest compact state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- preserve latest timeline entry without fingerprint",
        "",
        "# Next steps",
        "- continue memory-layer hardening",
      ].join("\n");

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateBefore = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      openMdStore(dir).save({
        name: "project_compact_timeline",
        description: "Bounded recent compact history for recovering multi-stage task decisions.",
        type: "project",
        tags: ["compact", "summary", "history", "status", "pinned"],
        source: "compact summary",
        body: [
          "Recent compact snapshots from a pre-fingerprint Zap version.",
          "",
          "<!-- zap-compact-snapshot:start -->",
          "## Snapshot 2026-07-01T00:00:00.000Z",
          "",
          "### Decisions made",
          "- preserve latest timeline entry without fingerprint",
          "",
          "### Next steps",
          "- continue memory-layer hardening",
          "<!-- zap-compact-snapshot:end -->",
          "",
        ].join("\n"),
      });

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);

      const stateAfter = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const entries = timeline?.body.match(/<!-- zap-compact-snapshot:start -->/g) ?? [];
      expect(stateAfter).toBe(stateBefore);
      expect(entries).toHaveLength(1);
      expect(timeline?.body).toContain("pre-fingerprint Zap version");
      expect(timeline?.body).not.toContain("zap-compact-snapshot:fingerprint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate legacy timeline entries that already match user messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Primary Request and Intent",
        "- keep long pasted inputs restorable",
        "",
        "# All user messages (verbatim)",
        "- \"复制长文本到输入粘贴\"",
        "",
        "# Current task status",
        "- preserving compact history without duplicate snapshots",
      ].join("\n");

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const stateBefore = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      openMdStore(dir).save({
        name: "project_compact_timeline",
        description: "Bounded recent compact history for recovering multi-stage task decisions.",
        type: "project",
        tags: ["compact", "summary", "history", "status", "pinned"],
        source: "compact summary",
        body: [
          "Recent compact snapshots from a pre-fingerprint Zap version.",
          "",
          "<!-- zap-compact-snapshot:start -->",
          "## Snapshot 2026-07-01T00:00:00.000Z",
          "",
          "### Primary request and intent",
          "- keep long pasted inputs restorable",
          "",
          "### User messages",
          "- \"复制长文本到输入粘贴\"",
          "",
          "### Current task status",
          "- preserving compact history without duplicate snapshots",
          "<!-- zap-compact-snapshot:end -->",
          "",
        ].join("\n"),
      });

      await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);

      const stateAfter = readFileSync(join(dir, "project_compact_state.md"), "utf-8");
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const entries = timeline?.body.match(/<!-- zap-compact-snapshot:start -->/g) ?? [];
      expect(stateAfter).toBe(stateBefore);
      expect(entries).toHaveLength(1);
      expect(timeline?.body).toContain("pre-fingerprint Zap version");
      expect(timeline?.body).not.toContain("zap-compact-snapshot:fingerprint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps compact timeline history to the latest eight snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      for (let i = 1; i <= 10; i++) {
        await persistCompactSummary(`# Decisions made\n- decision ${i}`, { memoryDir: dir } as AutoMemory);
      }

      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));
      const entries = timeline?.body.match(/<!-- zap-compact-snapshot:start -->/g) ?? [];

      expect(entries).toHaveLength(8);
      expect(timeline?.body).toContain("decision 10");
      expect(timeline?.body).toContain("decision 3");
      expect(timeline?.body).not.toMatch(/^- decision 2$/m);
      expect(timeline?.body).not.toMatch(/^- decision 1$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps nested headings inside extracted compact sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- cache-stable system prompt prefix is required",
        "## Provider details",
        "- Anthropic gets cache_control only before the dynamic boundary",
        "",
        "# Errors encountered and their resolution",
        "- output-only usage must not reset context accounting",
        "### Regression test",
        "- restore falls back to local estimate when prompt usage is zero",
        "",
        "# Files read / modified",
        "- src/config.ts",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const parsed = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(parsed?.body).toContain("## Provider details");
      expect(parsed?.body).toContain("Anthropic gets cache_control only before the dynamic boundary");
      expect(parsed?.body).toContain("### Regression test");
      expect(parsed?.body).toContain("restore falls back to local estimate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates punctuation and emphasis around compact section headings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# **Decisions made:**",
        "- preserve cache boundary before dynamic context",
        "",
        "# _Errors encountered and their resolution_:",
        "- compact parser used exact heading matching",
        "",
        "# Files read / modified：",
        "- zapsdk/memory/persist-compact-summary.ts",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const parsed = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      expect(parsed?.body).toContain("preserve cache boundary before dynamic context");
      expect(parsed?.body).toContain("compact parser used exact heading matching");
      expect(parsed?.body).toContain("zapsdk/memory/persist-compact-summary.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches compact section headings case-insensitively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# decisions made",
        "- keep transient memory out of the cacheable prompt prefix",
        "",
        "# ERRORS ENCOUNTERED AND THEIR RESOLUTION",
        "- status cache diagnostics used stale context history",
        "",
        "# Files Read / Modified",
        "- src/commands/status.ts",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const parsed = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      expect(parsed?.body).toContain("keep transient memory out of the cacheable prompt prefix");
      expect(parsed?.body).toContain("status cache diagnostics used stale context history");
      expect(parsed?.body).toContain("src/commands/status.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches compact section headings with slash spacing variants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Decisions made",
        "- keep compact headings tolerant but specific",
        "",
        "# Files read/modified",
        "- zapsdk/context/autocompact.ts",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const parsed = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      expect(parsed?.body).toContain("keep compact headings tolerant but specific");
      expect(parsed?.body).toContain("zapsdk/context/autocompact.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts durable sections from Chinese compact headings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# 主要请求和意图",
        "- 用户要继续修复 bug 并补齐记忆层短板。",
        "",
        "# 所有用户消息（原文）",
        "- \"继续推进\"",
        "",
        "# 当前任务状态",
        "- 正在优化 compact summary 的中文兼容性。",
        "",
        "# 关键事实",
        "- 中文标题以前无法被 durable memory 提取。",
        "",
        "# 已做决定",
        "- 复用 compact heading 归一化。",
        "",
        "# 后续步骤",
        "- 使用 tmux 运行全量检查。",
        "",
        "# 读取/修改的文件",
        "- zapsdk/context/autocompact.ts",
        "",
        "# 运行的命令",
        "- bun test zapsdk/tests/context/autocompact.test.ts",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      expect(latest?.body).toContain("用户要继续修复 bug");
      expect(latest?.body).toContain("正在优化 compact summary");
      expect(latest?.body).toContain("中文标题以前无法被 durable memory 提取");
      expect(latest?.body).toContain("使用 tmux 运行全量检查");
      expect(latest?.body).toContain("zapsdk/context/autocompact.ts");
      expect(timeline?.body).toContain("复用 compact heading 归一化");
      expect(timeline?.body).toContain("bun test zapsdk/tests/context/autocompact.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists task status, facts, code changes, next steps, and commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Current task status",
        "- cache diagnostics are wired and passing",
        "",
        "# Commands run",
        "- bun test tests/commands/status.test.ts",
        "",
        "# Key facts discovered",
        "- provider usage may report only total_tokens",
        "",
        "# Code changes summary",
        "- normalized total token fallback",
        "",
        "# Next steps",
        "- run tmux full check and commit",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const parsed = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      expect(parsed?.body).toContain("## Current task status");
      expect(parsed?.body).toContain("cache diagnostics are wired and passing");
      expect(parsed?.body).toContain("## Key facts discovered");
      expect(parsed?.body).toContain("provider usage may report only total_tokens");
      expect(parsed?.body).toContain("## Code changes summary");
      expect(parsed?.body).toContain("normalized total token fallback");
      expect(parsed?.body).toContain("## Next steps");
      expect(parsed?.body).toContain("run tmux full check and commit");
      expect(parsed?.body).toContain("## Commands run");
      expect(parsed?.body).toContain("bun test tests/commands/status.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists primary request and user messages into compact memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# Primary Request and Intent",
        "- User wants the memory layer optimized and cache hit rate investigated.",
        "",
        "# All user messages (verbatim)",
        "- \"我发现现在的Agent缓存命中率很低\"",
        "- \"评估一下整个记忆层的设计\"",
        "",
        "# Current task status",
        "- implementing durable compact-memory persistence",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));

      expect(memPath).toBe(join(dir, "project_compact_state.md"));
      expect(latest?.frontmatter.description).toContain("intent");
      expect(latest?.body).toContain("## Primary request and intent");
      expect(latest?.body).toContain("memory layer optimized");
      expect(latest?.body).toContain("## User messages");
      expect(latest?.body).toContain("Agent缓存命中率很低");
      expect(timeline?.body).toContain("### Primary request and intent");
      expect(timeline?.body).toContain("### User messages");
      expect(timeline?.body).toContain("评估一下整个记忆层的设计");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts credentials again at the durable persistence boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const summary = [
        "# All user messages (verbatim)",
        "- api_key = sk-live-secret-value",
        "- Authorization: Bearer bearer-secret-value",
        "",
        "# Current task status",
        "- preserve the operational request without credentials",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = readFileSync(memPath!, "utf-8");
      const timeline = readFileSync(join(dir, "project_compact_timeline.md"), "utf-8");

      for (const persisted of [latest, timeline]) {
        expect(persisted).toContain("[REDACTED]");
        expect(persisted).not.toContain("sk-live-secret-value");
        expect(persisted).not.toContain("bearer-secret-value");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds aggregate durable compact state while preserving every section edge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const sections = [
        "Primary Request and Intent",
        "All user messages (verbatim)",
        "Current task status",
        "Files read / modified",
        "Commands run",
        "Key facts discovered",
        "Decisions made",
        "Errors encountered and their resolution",
        "Code changes summary",
        "Next steps",
      ];
      const summary = sections.flatMap((title, index) => [
        `# ${title}`,
        `section-${index}-head\n${"x".repeat(26_000)}\nsection-${index}-tail`,
        "",
      ]).join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));

      expect(countCodePoints(latest?.body ?? "")).toBeLessThanOrEqual(64_000);
      expect(countCodePoints(timeline?.body ?? "")).toBeLessThanOrEqual(64_000);
      expect(latest?.body).toContain("durable compact memory folded by chars");
      for (let index = 0; index < sections.length; index++) {
        expect(latest?.body).toContain(`section-${index}-head`);
        expect(latest?.body).toContain(`section-${index}-tail`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds oversized compact sections before writing durable memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const longUserMessages = Array.from({ length: 140 }, (_, i) => `- user pasted line ${i + 1}`).join("\n");
      const summary = [
        "# Primary Request and Intent",
        "- Preserve long pasted input without polluting durable memory.",
        "",
        "# All user messages (verbatim)",
        longUserMessages,
        "",
        "# Current task status",
        "- compact summary persistence is being hardened",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));

      expect(latest?.body).toContain("durable compact memory folded");
      expect(latest?.body).toContain("full 140 lines");
      expect(latest?.body).toContain("remains in the session JSONL");
      expect(latest?.body).toContain("user pasted line 1");
      expect(latest?.body).toContain("user pasted line 140");
      expect(latest?.body).not.toContain("user pasted line 90");
      expect(timeline?.body).toContain("durable compact memory folded");
      expect(timeline?.body).not.toContain("user pasted line 90");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts and folds CR-only compact summaries as logical lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const longUserMessages = Array.from({ length: 140 }, (_, i) => `- cr-only pasted line ${i + 1}`);
      const summary = [
        "# All user messages (verbatim)",
        ...longUserMessages,
        "",
        "# Current task status",
        "- compact summary persistence is normalizing line endings",
      ].join("\r");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));
      const timeline = parseMdFile(readFileSync(join(dir, "project_compact_timeline.md"), "utf-8"));

      expect(latest?.body).toContain("durable compact memory folded");
      expect(latest?.body).toContain("full 140 lines");
      expect(latest?.body).toContain("cr-only pasted line 1");
      expect(latest?.body).toContain("cr-only pasted line 140");
      expect(latest?.body).not.toContain("cr-only pasted line 90");
      expect(latest?.body).not.toContain("\r");
      expect(timeline?.body).toContain("compact summary persistence is normalizing line endings");
      expect(timeline?.body).not.toContain("\r");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rewrite compact memory when only folded-away section content changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const buildSummary = (middle: string) => [
        "# All user messages (verbatim)",
        ...Array.from({ length: 80 }, (_, i) => `- stable head line ${i + 1}`),
        ...Array.from({ length: 30 }, (_, i) => `- ${middle} ${i + 1}`),
        ...Array.from({ length: 30 }, (_, i) => `- stable tail line ${i + 1}`),
        "",
        "# Current task status",
        "- continue memory layer hardening",
      ].join("\n");

      const memPath = await persistCompactSummary(buildSummary("first omitted middle"), { memoryDir: dir } as AutoMemory);
      const firstBody = readFileSync(memPath!, "utf-8");
      await persistCompactSummary(buildSummary("second omitted middle"), { memoryDir: dir } as AutoMemory);
      const secondBody = readFileSync(memPath!, "utf-8");

      expect(secondBody).toBe(firstBody);
      expect(secondBody).toContain("durable compact memory folded");
      expect(secondBody).not.toContain("first omitted middle");
      expect(secondBody).not.toContain("second omitted middle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rewrite compact memory when only char-folded section content changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const stableHead = "head-".repeat(2_600);
      const stableTail = "tail-".repeat(1_400);
      const buildSummary = (middle: string) => [
        "# All user messages (verbatim)",
        `${stableHead}${middle}${stableTail}`,
        "",
        "# Current task status",
        "- continue memory layer hardening",
      ].join("\n");

      const memPath = await persistCompactSummary(buildSummary("first-omitted-middle-".repeat(600)), { memoryDir: dir } as AutoMemory);
      const firstBody = readFileSync(memPath!, "utf-8");
      await persistCompactSummary(buildSummary("second-omitted-middle-longer-".repeat(700)), { memoryDir: dir } as AutoMemory);
      const secondBody = readFileSync(memPath!, "utf-8");

      expect(secondBody).toBe(firstBody);
      expect(secondBody).toContain("durable compact memory folded by chars");
      expect(secondBody).toContain("full section remains in the session JSONL");
      expect(secondBody).not.toContain("first-omitted-middle");
      expect(secondBody).not.toContain("second-omitted-middle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not char-fold durable compact sections that fit by Unicode character count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const exactBudget = "😀".repeat(24_000);
      const summary = [
        "# All user messages (verbatim)",
        exactBudget,
        "",
        "# Current task status",
        "- continue memory layer hardening",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(latest?.body).not.toContain("durable compact memory folded by chars");
      expect(countOccurrences(latest?.body ?? "", "😀")).toBe(24_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves char-folded durable compact memory budgets by Unicode character count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const overBudget = "😀".repeat(24_001);
      const summary = [
        "# All user messages (verbatim)",
        overBudget,
        "",
        "# Current task status",
        "- continue memory layer hardening",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(latest?.body).toContain("durable compact memory folded by chars");
      expect(countOccurrences(latest?.body ?? "", "😀")).toBe(18_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps char-folded compact memory valid at surrogate boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    try {
      const boundaryEmoji = "🧪";
      const summary = [
        "# All user messages (verbatim)",
        `${"head".repeat(4_625)}${boundaryEmoji}${"tail".repeat(1_499)}tai`,
        "",
        "# Current task status",
        "- continue memory layer hardening",
      ].join("\n");

      const memPath = await persistCompactSummary(summary, { memoryDir: dir } as AutoMemory);
      const latest = parseMdFile(readFileSync(memPath!, "utf-8"));

      expect(latest?.body).toContain("durable compact memory folded by chars");
      expect(latest?.body).toContain("tailtailtail");
      expect(countOccurrences(latest?.body ?? "", boundaryEmoji)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not warn when the compact summary has no durable sections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    try {
      const result = await persistCompactSummary(
        "# Current work\n- nothing durable yet",
        { memoryDir: dir } as AutoMemory,
        { warn: (event, fields) => { warnings.push({ event, fields }); } },
      );

      expect(result).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports write failures to diagnostics without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zapcode-compact-memory-"));
    const memoryDir = join(dir, "not-a-directory");
    writeFileSync(memoryDir, "occupied");
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    try {
      const result = await persistCompactSummary(
        "# Decisions made\n- preserve memory diagnostics",
        { memoryDir } as AutoMemory,
        { warn: (event, fields) => { warnings.push({ event, fields }); } },
      );

      expect(result).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.event).toBe("memory_operation_failed");
      expect(warnings[0]?.fields?.operation).toBe("compact_summary");
      expect(String(warnings[0]?.fields?.error)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === needle) count++;
  }
  return count;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}
