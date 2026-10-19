#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const required = [
  "ZAPVM_E2E_WEB_URL",
  "ZAPVM_E2E_ACCESS_TOKEN",
  "ZAPVM_E2E_PROVIDER_BASE_URL",
  "ZAPVM_E2E_MODEL",
  "ZAPVM_E2E_EVIDENCE_DIR",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`missing ${name}`);
}

const webURL = process.env.ZAPVM_E2E_WEB_URL;
const evidenceDir = process.env.ZAPVM_E2E_EVIDENCE_DIR;
const chromePath = process.env.ZAPVM_E2E_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const result = { schema_version: 1, browser: "chromium", tasks: {} };

async function taskID(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("zapvm.workspace.v1") || "{}").task || "");
}

async function waitTaskState(page, states, timeout = 420000) {
  const observable = [...new Set([...states, "succeeded", "failed", "canceled"])];
  await page.waitForFunction(
    (expected) => expected.includes(document.getElementById("task-state")?.dataset.state || ""),
    observable,
    { timeout },
  );
  const current = await page.locator("#task-state").getAttribute("data-state");
  if (!states.includes(current)) throw new Error(`Task reached unexpected terminal state ${current}`);
  return current;
}

async function submit(page, prompt, previousID = "") {
  await page.locator("#prompt").fill(prompt);
  await page.locator("#submit-button").click();
  await page.waitForFunction(
    (oldID) => {
      const saved = JSON.parse(localStorage.getItem("zapvm.workspace.v1") || "{}");
      return Boolean(saved.task && saved.task !== oldID);
    },
    previousID,
    { timeout: 30000 },
  );
  return taskID(page);
}

async function waitFeed(page, marker, timeout = 420000) {
  await page.locator("#event-feed").filter({ hasText: marker }).waitFor({ state: "visible", timeout });
}

async function verifyMobileWorkspace(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto(webURL, { waitUntil: "domcontentloaded" });
    await page.locator("#access-token").fill(process.env.ZAPVM_E2E_ACCESS_TOKEN);
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#workspace-view").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("#prompt").waitFor({ state: "visible" });
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      composerBottom: document.getElementById("prompt-form")?.getBoundingClientRect().bottom || 0,
    }));
    if (layout.document > layout.viewport || layout.body > layout.viewport || layout.composerBottom > 844) {
      throw new Error(`mobile layout overflow: ${JSON.stringify(layout)}`);
    }
    await page.locator("#conversation-toggle").click();
    await page.waitForFunction(() => document.getElementById("workspace-view")?.classList.contains("sidebar-open"));
    await page.locator("#sidebar-close").click();
    await page.waitForFunction(() => !document.getElementById("workspace-view")?.classList.contains("sidebar-open"));
    await page.locator("#outcome-toggle").click();
    await page.waitForFunction(() => document.getElementById("workspace-view")?.classList.contains("outcome-open"));
    await page.locator("#outcome-close").click();
    await page.waitForFunction(() => !document.getElementById("workspace-view")?.classList.contains("outcome-open"));
    await page.screenshot({ path: path.join(evidenceDir, "mobile-workspace.png"), fullPage: true });
    return { state: "passed", viewport: "390x844", horizontal_overflow: false, drawers: "passed" };
  } finally {
    await context.close();
  }
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error("Google Chrome is required for the real browser acceptance");
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.goto(webURL, { waitUntil: "domcontentloaded" });
    await page.locator("#access-token").fill(process.env.ZAPVM_E2E_ACCESS_TOKEN);
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#workspace-view").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("#computer-select").selectOption("computer-e2e");

    const firstPrompt = "Use the Bash tool to run exactly: if touch .git/zapvm-e2e-forbidden 2>/dev/null; then exit 41; fi; if touch .zapcode/zapvm-e2e-forbidden 2>/dev/null; then exit 42; fi; printf 'E2E_FIRST_FILE\\n' > README.md; printf 'E2E_DOWNLOAD_FILE\\n' > artifact.txt. Then reply with exactly WEB_AGENT_FIRST_OK.";
    const firstID = await submit(page, firstPrompt);
    result.tasks.first = firstID;
    await context.setOffline(true);
    await page.locator("#connection-state").filter({ hasText: "网络离线" }).waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(1500);
    await context.setOffline(false);
    await waitTaskState(page, ["succeeded"]);
    await waitFeed(page, "WEB_AGENT_FIRST_OK");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#workspace-view").waitFor({ state: "visible", timeout: 30000 });
    await waitTaskState(page, ["succeeded"]);
    await waitFeed(page, "WEB_AGENT_FIRST_OK");
    if (await taskID(page) !== firstID) throw new Error("refresh restored a different Task");
    const secondPrompt = "Read README.md, then reply with the file content followed by exactly WEB_AGENT_CONTINUE_OK.";
    const secondID = await submit(page, secondPrompt, firstID);
    result.tasks.continue = secondID;
    await waitTaskState(page, ["succeeded"]);
    await waitFeed(page, "E2E_FIRST_FILE");
    await waitFeed(page, "WEB_AGENT_CONTINUE_OK");
    await waitFeed(page, firstPrompt);
    await waitFeed(page, secondPrompt);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#workspace-view").waitFor({ state: "visible", timeout: 30000 });
    await waitTaskState(page, ["succeeded"]);
    for (const marker of [firstPrompt, "WEB_AGENT_FIRST_OK", secondPrompt, "WEB_AGENT_CONTINUE_OK"]) {
      await waitFeed(page, marker);
    }
    if (await taskID(page) !== secondID) throw new Error("refresh restored a different continuation Task");

    await page.locator("#workspace-refresh").click();
    await page.getByRole("button", { name: /artifact\.txt/ }).waitFor({ state: "visible", timeout: 60000 });
    await page.getByRole("button", { name: /README\.md/ }).click();
    await page.locator("#workspace-preview").filter({ hasText: "E2E_FIRST_FILE" }).waitFor({ state: "visible", timeout: 60000 });
    await page.locator("#workspace-diff").click();
    await page.locator("#workspace-preview").filter({ hasText: "E2E_FIRST_FILE" }).waitFor({ state: "visible", timeout: 60000 });
    await page.locator("#workspace-refresh").click();
    await page.getByRole("button", { name: /artifact\.txt/ }).click();
    await page.locator("#workspace-preview").filter({ hasText: "E2E_DOWNLOAD_FILE" }).waitFor({ state: "visible", timeout: 60000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await page.locator("#workspace-download").click();
    const download = await downloadPromise;
    const downloadPath = path.join(evidenceDir, "downloaded-artifact.txt");
    await download.saveAs(downloadPath);
    if (fs.readFileSync(downloadPath, "utf8") !== "E2E_DOWNLOAD_FILE\n") throw new Error("downloaded artifact content mismatch");

    const cancelPrompt = "Use the Bash tool to run exactly: sleep 300. Do not run it in the background and do not reply until it exits.";
    const cancelID = await submit(page, cancelPrompt, secondID);
    result.tasks.cancel = cancelID;
    await waitFeed(page, "sleep 300", 120000);
    await page.locator("#cancel-button").click();
    await waitTaskState(page, ["canceled"], 120000);

    result.mobile = await verifyMobileWorkspace(browser);

    result.final_state = "passed";
    fs.writeFileSync(path.join(evidenceDir, "browser-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    result.final_state = "failed";
    result.error = String(error && error.message ? error.message : error);
    fs.writeFileSync(path.join(evidenceDir, "browser-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const feed = await page.locator("#event-feed").innerText().catch(() => "");
    fs.writeFileSync(path.join(evidenceDir, "browser-feed.txt"), `${feed}\n`, { mode: 0o600 });
    await page.screenshot({ path: path.join(evidenceDir, "browser-failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`browser acceptance failed: ${error.message}\n`);
  process.exitCode = 1;
});
