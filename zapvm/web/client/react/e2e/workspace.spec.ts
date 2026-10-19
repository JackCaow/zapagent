import { expect, test } from "@playwright/test";

const existingTask = {
  id: "task-existing",
  computer_id: "cloud-smoke",
  session_id: "session-existing",
  title: "已有会话",
  state: "succeeded",
  created_at: "2026-08-09T09:00:00Z",
  updated_at: "2026-08-09T09:01:00Z",
};

async function mockWorkspace(page: import("@playwright/test").Page, transcript: "empty" | "long" | "loop" = "empty") {
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    authenticated: true,
    csrf_token: "test-csrf",
    display_name: "E2E Tester",
    role: "admin",
    runtime_profile: { id: "deepseek-v4-flash", model: "DeepSeek V4 Flash" },
  } }));
  await page.route("**/api/agent/computers", (route) => route.fulfill({ json: {
    computers: [{ id: "cloud-smoke", state: "online" }],
  } }));
  await page.route("**/api/agent/sessions?*", (route) => route.fulfill({ json: { sessions: [existingTask] } }));
  await page.route("**/api/agent/sessions/*/artifacts?*", (route) => route.fulfill({ json: { artifacts: [] } }));
  await page.route("**/api/agent/sessions/task-existing/transcript?*", (route) => route.fulfill({ json: {
    session: existingTask,
    prompt: "这是历史任务的输入",
    events: transcript === "long" ? [{
      cursor: 1,
      type: "exec.output",
      data: `${JSON.stringify({ type: "assistant", content: "用于验证长会话滚动的内容。".repeat(1_000) })}\n`,
    }] : transcript === "loop" ? [{
      cursor: 1,
      type: "exec.output",
      data: [
        { type: "system", subtype: "init", model: "DeepSeek V4 Flash" },
        { type: "context", step: 1, messageCount: 4 },
        { type: "tool_use", id: "call-list", name: "Bash", args: { command: "ls" } },
        { type: "tool_result", id: "call-list", name: "Bash", ok: true, preview: "README.md" },
        { type: "assistant", delta: "已完成目录检查。\n\n入口文件：`README.md`" },
        { type: "result", ok: true, text: "已完成目录检查。" },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    }] : [],
    next_cursor: 0,
  } }));
  await page.route("**/api/admin/platform/me", (route) => route.fulfill({ json: { user_id: "e2e-admin", display_name: "E2E Tester", role: "admin", status: "active" } }));
  await page.route("**/api/admin/platform/members", (route) => route.fulfill({ json: { members: [{ user_id: "e2e-admin", display_name: "E2E Tester", role: "admin", status: "active" }] } }));
  await page.route("**/api/admin/platform/host-pools", (route) => route.fulfill({ json: { host_pools: [{ id: "tokyo", display_name: "Tokyo Pool", region: "jp-east", enabled: true, max_computers: 20, node_ids: ["node-tokyo-a"] }] } }));
  await page.route("**/api/admin/platform/nodes", (route) => route.fulfill({ json: { nodes: [{ id: "node-tokyo-a", state: "online", daemon_state: "healthy", capacity: 4, in_flight: 1 }] } }));
  await page.route("**/api/admin/platform/models", (route) => route.fulfill({ json: { models: [{ id: "model-managed", display_name: "Managed Model", provider_url: "https://api.example.test/v1", provider_model: "model-managed", credential_id: "model-key", enabled: true }] } }));
  await page.route("**/api/admin/platform/agents", (route) => route.fulfill({ json: { agents: [{ id: "zapcode", display_name: "ZapCode", runtime_ref: "zapcode@2.0.0", model_id: "model-managed", enabled: true, configuration: {} }] } }));
  await page.route("**/api/admin/platform/computers", (route) => route.fulfill({ json: { computers: [{ id: "computer-a", display_name: "Computer A", pool_id: "tokyo", agent_id: "zapcode", vcpu: 2, memory_bytes: 4294967296, browser_enabled: false, created_by: "e2e-admin" }] } }));
  await page.route("**/api/admin/platform/credentials", (route) => route.fulfill({ json: { credentials: [{ id: "model-key", state: "active", version: 1 }] } }));
  await page.route("**/api/admin/platform/quota", (route) => route.fulfill({ json: { max_computers: 10, max_concurrent_tasks: 5, monthly_task_seconds: 360000, artifact_bytes: 107374182400 } }));
  await page.route("**/api/admin/platform/usage", (route) => route.fulfill({ json: { task_count: 12, task_seconds: 7200, artifact_bytes: 1048576, computer_count: 1, running_tasks: 1 } }));
}

test.describe("Agent Workspace interaction", () => {
  test.beforeEach(async ({ page }) => {
    await mockWorkspace(page);
  });

  test("new task clears the selected history and keeps the composer in view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "已有会话" })).toBeVisible();
    await page.getByRole("button", { name: "新任务" }).click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("heading", { name: "今天想完成什么？" })).toBeVisible();
    await expect(page.getByText("这是历史任务的输入")).toHaveCount(0);

    const composer = page.getByPlaceholder("给 Agent 发送任务…");
    await expect(composer).toBeVisible();
    const box = await composer.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900);
  });

  test("Workspace administration uses an isolated shell and can return to Agent work", async ({ page }) => {
    let lifecycleBody = "";
    await page.route("**/api/admin/computers", (route) => route.fulfill({ json: {
      computers: [{
        id: "computer-a", state: "online", desired_state: "running", observed_state: "ready",
        assigned_node_id: "node-tokyo-a", placement_epoch: 4, last_activity_at: "2026-08-15T07:00:00Z",
      }],
    } }));
    await page.route("**/api/admin/computers/computer-a/lifecycle", async (route) => {
      lifecycleBody = route.request().postData() ?? "";
      await route.fulfill({ status: 202, json: { action: "release", accepted: true, operation_id: "stop-a" } });
    });
    await page.goto("/new");
    await page.getByRole("button", { name: "Workspace 管理" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Workspace 管理" })).toBeVisible();
    await expect(page.getByRole("banner", { name: "Workspace 管理导航" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "历史会话" })).toHaveCount(0);
    await expect(page.getByText("已有会话", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Computer" }).click();
    await expect(page.getByText("Computer A")).toBeVisible();
    await expect(page.getByText("node-tokyo-a")).toBeVisible();
    await page.getByRole("button", { name: "释放" }).click();
    await expect(page.getByText("computer-a 已提交释放操作。")).toBeVisible();
    expect(JSON.parse(lifecycleBody)).toEqual({ action: "release" });
    await page.getByRole("button", { name: "返回 Agent 工作区" }).click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("complementary", { name: "会话列表" })).toBeVisible();
  });

  test("direct admin routes do not fetch or render conversation data", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const agentRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/agent/")) agentRequests.push(path);
    });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Workspace 管理" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "返回 Agent 工作区" })).toBeVisible();
    await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
    expect(agentRequests).toEqual([]);
  });

  test("uses the zapVM design system and suggestion actions populate the composer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "zapVM Agent Computer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开侧栏" })).toBeHidden();
    await page.getByRole("button", { name: "新任务" }).click();

    await expect(page.getByText("YOUR AGENT COMPUTER")).toBeVisible();
    await expect(page.locator(".brand-symbol").first()).toBeVisible();
    const suggestion = page.getByRole("button", { name: /分析这个仓库并提出可执行的优化方案/ });
    await suggestion.click();
    const composerInput = page.getByPlaceholder("给 Agent 发送任务…");
    await expect(composerInput).toHaveValue("分析这个仓库并提出可执行的优化方案");
    await composerInput.focus();

    const focusTreatment = await composerInput.evaluate((textarea) => ({
      inputShadow: getComputedStyle(textarea).boxShadow,
      containerShadow: getComputedStyle(textarea.closest(".composer")!).boxShadow,
    }));
    expect(focusTreatment.inputShadow).toBe("none");
    expect(focusTreatment.containerShadow).not.toBe("none");

    const tokens = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        accent: styles.getPropertyValue("--z-color-accent").trim(),
        canvas: styles.getPropertyValue("--z-color-canvas").trim(),
        contentWidth: styles.getPropertyValue("--z-content-width").trim(),
      };
    });
    expect(tokens).toEqual({ accent: "#b8f85b", canvas: "#080b0e", contentWidth: "880px" });
  });

  test("session URLs survive refresh and browser navigation keeps drafts alive", async ({ page }) => {
    await page.goto("/sessions/session-existing");
    await expect(page.getByRole("heading", { name: "已有会话" })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/sessions\/session-existing$/);
    await expect(page.getByText("这是历史任务的输入")).toBeVisible();

    await page.getByRole("button", { name: "新任务" }).click();
    await page.getByPlaceholder("给 Agent 发送任务…").fill("保留这段未发送内容");
    await page.getByRole("button", { name: "已有会话" }).click();
    await expect(page).toHaveURL(/\/sessions\/session-existing$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByPlaceholder("给 Agent 发送任务…")).toHaveValue("保留这段未发送内容");
  });

  test("first message stays optimistic and never enters history restoration", async ({ page }) => {
    const newTask = {
      id: "task-new",
      computer_id: "cloud-smoke",
      session_id: "session-new",
      title: "完成商业级交互检查",
      state: "pending",
      created_at: "2026-08-09T10:00:00Z",
      updated_at: "2026-08-09T10:00:00Z",
    };
    let created = false;
    let newTranscriptRequests = 0;
    await page.addInitScript((task) => {
      class MockAgentWebSocket {
        static readonly OPEN = 1;
        readonly url: string;
        readonly protocol = "zapvm.agent-stream.v1";
        readyState = 0;
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor(url: string) {
          this.url = url;
          window.setTimeout(() => {
            this.readyState = MockAgentWebSocket.OPEN;
            this.onopen?.();
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "task-event", cursor: 1, data: { cursor: 1, type: "exec.result", ok: true } }) }));
          }, 20);
          window.setTimeout(() => {
            if (this.readyState !== MockAgentWebSocket.OPEN) return;
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
              type: "task-event",
              cursor: 2,
              data: { cursor: 2, type: "artifact.collect_completed", data: btoa('{"count":1}') },
            }) }));
          }, 100);
          window.setTimeout(() => {
            if (this.readyState !== MockAgentWebSocket.OPEN) return;
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "session", data: { ...task, state: "succeeded" } }) }));
          }, 180);
        }
        close() { this.readyState = 3; this.onclose?.(); }
      }
      Object.defineProperty(window, "WebSocket", { configurable: true, value: MockAgentWebSocket });
    }, newTask);
    page.on("request", (request) => { if (request.url().includes("/task-new/transcript")) newTranscriptRequests += 1; });
    await page.route("**/api/agent/sessions?*", (route) => route.fulfill({ json: { sessions: created ? [existingTask, newTask] : [existingTask] } }));
    await page.route("**/api/agent/sessions", async (route) => {
      created = true;
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ json: newTask });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "新任务" }).click();
    await page.getByPlaceholder("给 Agent 发送任务…").fill("完成商业级交互检查");
    await page.getByRole("button", { name: "发送任务" }).click();

    await expect(page.getByText("完成商业级交互检查").last()).toBeVisible();
    await expect(page.getByText("任务已提交")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await expect(page.getByLabel("正在加载对话记录")).toHaveCount(0);
    await expect(page.getByText("交付文件已就绪")).toBeVisible();
    await expect(page.getByText("任务已完成")).toBeVisible();
    await expect(page.getByLabel("Agent 执行过程").locator(".loop-lifecycle.running, .loop-tool.running")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    await expect(page.getByPlaceholder("给 Agent 发送任务…")).toBeEnabled();
    await expect(page).toHaveURL(/\/sessions\/session-new$/);
    await expect(page.getByLabel("正在加载对话记录")).toHaveCount(0);
    expect(newTranscriptRequests).toBe(0);
  });

  test("composer remains visible on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "打开侧栏" }).click();
    await page.getByRole("button", { name: "新任务" }).click();
    const composer = page.getByPlaceholder("给 Agent 发送任务…");
    await expect(composer).toBeVisible();
    const box = await composer.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
  });

  test("long transcripts scroll independently and can return to the live edge", async ({ page }) => {
    await mockWorkspace(page, "long");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByText("用于验证长会话滚动的内容。").first()).toBeVisible();

    const feed = page.locator(".feed");
    await feed.evaluate((element) => { element.scrollTop = 0; });
    await feed.dispatchEvent("scroll");
    await expect(page.getByRole("button", { name: "回到最新进度" })).toBeVisible();
    await page.getByRole("button", { name: "回到最新进度" }).click();
    const atLiveEdge = await feed.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2);
    expect(atLiveEdge).toBe(true);
    await expect(page.getByPlaceholder("给 Agent 发送任务…")).toBeVisible();
  });

  test("renders Agent system, loop, tool and answer in stream order", async ({ page }) => {
    await mockWorkspace(page, "loop");
    await page.goto("/");
    const timeline = page.getByLabel("Agent 执行过程");
    await expect(timeline.getByText("Agent 已启动")).toBeVisible();
    await expect(timeline.getByText("Bash", { exact: true })).toBeVisible();
    await expect(timeline.getByText("已完成目录检查。")).toBeVisible();
    await expect(timeline.getByText("第 1 轮")).toHaveCount(0);
    await expect(timeline.locator(".loop-lifecycle.running")).toHaveCount(0);
    await expect(page.locator(".user-avatar, .agent-avatar")).toHaveCount(0);
    const inlineCode = timeline.locator('[data-streamdown="inline-code"]');
    await expect(inlineCode).toHaveText("README.md");
    const inlineCodeStyle = await inlineCode.evaluate((element) => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    expect(inlineCodeStyle).toEqual({ color: "rgb(199, 207, 213)", background: "rgba(167, 176, 185, 0.08)" });
    const content = await timeline.innerText();
    expect(content.indexOf("Agent 已启动")).toBeLessThan(content.indexOf("Bash"));
    expect(content.indexOf("Bash")).toBeLessThan(content.indexOf("已完成目录检查。"));
  });

  test("shows registered output as a downloadable file inside the completed message", async ({ page }) => {
    await page.route("**/api/agent/sessions/task-existing/artifacts?*", (route) => route.fulfill({ json: { artifacts: [{
      id: "artifact-output",
      task_id: "task-existing",
      name: "认识钟表.pptx",
      path: "认识钟表.pptx",
      size: 24_576,
      content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      state: "available",
    }] } }));
    await page.route("**/api/agent/artifacts/artifact-output/download", (route) => route.fulfill({ json: {
      artifact_id: "artifact-output",
      url: "https://objects.example.test/download/artifact-output?signature=test",
      filename: "认识钟表.pptx",
    } }));
    await page.route("https://objects.example.test/download/**", (route) => route.fulfill({
      status: 200,
      headers: { "content-disposition": "attachment; filename=clock.pptx", "content-type": "application/octet-stream" },
      body: "presentation",
    }));

    await page.goto("/");
    const files = page.getByLabel("本轮生成的文件");
    await expect(files.getByText("认识钟表.pptx")).toBeVisible();
    await expect(files.getByText("24.0 KiB · PowerPoint")).toBeVisible();
    const downloadRequest = page.waitForRequest("**/api/agent/artifacts/artifact-output/download");
    await files.getByRole("button", { name: /认识钟表.pptx/ }).click();
    await downloadRequest;
  });
});
