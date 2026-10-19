import { expect, test } from "@playwright/test";

const session = {
  authenticated: true,
  csrf_token: "test-csrf",
  display_name: "邀请用户",
  runtime_profile: { id: "deepseek-v4-flash", model: "DeepSeek V4 Flash" },
};

async function mockUnauthenticated(page: import("@playwright/test").Page, oidc?: { display_name: string; start_url: string }) {
  await page.route("**/api/session", (route) => route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }));
  await page.route("**/auth/options", (route) => route.fulfill({ json: oidc ? { oidc } : {} }));
}

async function mockWorkspace(page: import("@playwright/test").Page) {
  await page.route("**/api/agent/computers", (route) => route.fulfill({ json: { computers: [{ id: "cloud-smoke", state: "online" }] } }));
  await page.route("**/api/agent/sessions?*", (route) => route.fulfill({ json: { sessions: [] } }));
}

test.describe("normal Workspace sign-in", () => {
  test("shows an enterprise login action when OIDC is configured", async ({ page }) => {
    await mockUnauthenticated(page, { display_name: "Google Workspace", start_url: "/auth/oidc/start" });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "使用 Google Workspace 登录" })).toBeVisible();
    await expect(page.getByText("Project access token")).toHaveCount(0);
  });

  test("uses invitation links as the default login path", async ({ page }) => {
    await mockUnauthenticated(page);
    await page.goto("/");
    await expect(page.getByText("使用邀请链接登录")).toBeVisible();
    await expect(page.getByPlaceholder("输入访问密钥")).not.toBeVisible();
    await page.getByText("使用管理员访问密钥").click();
    await expect(page.getByPlaceholder("输入访问密钥")).toBeVisible();
  });

  test("redeems an invitation from the URL fragment without retaining it", async ({ page }) => {
    await mockUnauthenticated(page);
    await mockWorkspace(page);
    await page.route("**/auth/invite", (route) => route.fulfill({ json: session }));
    await page.goto("/#invite=test-invite-token");
    await expect(page.getByRole("heading", { name: "今天想完成什么？" })).toBeVisible();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByText("test-invite-token")).toHaveCount(0);
  });

  test("synchronizes login and logout across open Workspace tabs", async ({ context }) => {
    let authenticated = false;
    const pages = [await context.newPage(), await context.newPage()];
    for (const page of pages) {
      await page.route("**/api/session", (route) => authenticated
        ? route.fulfill({ json: session })
        : route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }));
      await page.route("**/auth/options", (route) => route.fulfill({ json: {} }));
      await page.route("**/auth/login", (route) => {
        authenticated = true;
        return route.fulfill({ json: session });
      });
      await page.route("**/auth/logout", (route) => {
        authenticated = false;
        return route.fulfill({ status: 204, body: "" });
      });
      await mockWorkspace(page);
      await page.goto("/new");
      await expect(page.getByText("使用邀请链接登录")).toBeVisible();
    }

    const [primary, secondary] = pages;
    await primary.getByText("使用管理员访问密钥").click();
    await primary.getByPlaceholder("输入访问密钥").fill("test-workspace-token-0000000000000000");
    await primary.getByRole("button", { name: "管理员登录" }).click();

    await expect(primary.getByRole("heading", { name: "今天想完成什么？" })).toBeVisible();
    await expect(secondary.getByRole("heading", { name: "今天想完成什么？" })).toBeVisible();

    await primary.getByRole("button", { name: /邀请用户.*DeepSeek V4 Flash/ }).click();
    await primary.getByRole("menuitem", { name: "退出登录" }).click();
    await expect(primary.getByText("使用邀请链接登录")).toBeVisible();
    await expect(secondary.getByText("使用邀请链接登录")).toBeVisible();
  });
});
