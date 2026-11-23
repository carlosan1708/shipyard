import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test as base } from "@playwright/test";
import { parseConfig } from "../src/config.ts";
import { DEMO_APP_DIR } from "../src/eval.ts";
import { git } from "../src/exec.ts";
import { loadRoles } from "../src/roles.ts";
import { DemoRunner } from "../src/ui/demo.ts";
import { RunManager } from "../src/ui/manager.ts";
import { startUiServer } from "../src/ui/server.ts";
import { initRepoWithCommit } from "../src/worktree.ts";

const recording = process.env.SHIPYARD_RECORD_DEMO === "1";

// Pauses give viewers time to read. Assertions drive synchronization in both modes.
async function holdForRecording(ms: number): Promise<void> {
  if (recording) await delay(ms);
}

const test = base.extend<{ demo: { url: string; repo: string; baseCommit: string } }>({
  demo: async ({}, use) => {
    const workspace = await mkdtemp(join(tmpdir(), "shipyard-playwright-"));
    try {
      const repo = join(workspace, "demo-shop");
      await cp(DEMO_APP_DIR, repo, { recursive: true });
      await initRepoWithCommit(repo);
      const baseCommit = await git(["rev-parse", "HEAD"], repo);
      const config = parseConfig({
        worktreeRoot: "worktrees",
        runsDir: "runs",
        targets: { "demo-shop": { path: repo, test: "npm test", e2e: "npm run e2e" } },
      }, workspace);
      const manager = new RunManager({ config, roles: loadRoles(), runner: new DemoRunner(recording ? 320 : 5) });
      const server = await startUiServer({ manager, config, demo: true });
      try {
        await use({ url: server.url, repo, baseCommit });
      } finally {
        await Promise.all([manager.shutdown(), server.close()]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
});

test("ships a health endpoint from request to verified handoff", async ({ demo, page }) => {
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const inbox = page.getByRole("complementary", { name: "Needs you" });
  const statusOnly = inbox.getByRole("radio", { name: /Just the status/ });

  await test.step("Submit a feature request", async () => {
    await page.goto(demo.url);
    const header = page.getByRole("banner");
    await expect(header.getByRole("status")).toHaveText("Live");
    await header.getByRole("button", { name: "New run" }).click();
    const form = page.getByRole("dialog", { name: "New run" });
    await expect(form.getByLabel("Target repo")).toHaveValue("demo-shop");
    await expect(form.getByText(demo.repo, { exact: true })).toBeVisible();
    await form.getByLabel("Feature request").fill('Add a GET /health endpoint that returns {"status": "ok"}.');
    await holdForRecording(1600);
    const startRun = form.getByRole("button", { name: "Start run" });
    if (recording) {
      await startRun.scrollIntoViewIfNeeded();
      await holdForRecording(900);
    }
    await startRun.click();
  });

  await test.step("Answer the planner and approve its plan", async () => {
    await statusOnly.check();
    await holdForRecording(1600);
    await button("Send answer").click();
    await expect(button("Approve the plan")).toBeVisible();
    await holdForRecording(1500);
    await button("Approve the plan").click();
  });

  await test.step("Inspect the implementation and approve its passing gate", async () => {
    await expect(button("Approve")).toBeVisible();
    await inbox.getByText("Changed files (2)", { exact: true }).click();
    await expect(inbox.getByText(/M\s+src\/server\.js/)).toBeVisible();
    await expect(inbox.getByText(/A\s+test\/health\.test\.js/)).toBeVisible();
    await inbox.getByText("Checks (1 passed)", { exact: true }).click();
    await expect(inbox.locator(".gates").getByRole("listitem").filter({ hasText: "npm test" })).toBeVisible();
    await holdForRecording(2400);
    await button("Approve").click();
  });

  await test.step("Approve the revision prompted by the reviewer", async () => {
    await expect(inbox.getByText(/revise passed its gates/)).toBeVisible();
    await expect(inbox.getByText(/added a test that POST \/health is not a route/)).toBeVisible();
    await holdForRecording(1800);
    await button("Approve").click();
  });

  await test.step("Decline optional web access for the E2E tester", async () => {
    await expect(button("Deny")).toBeVisible();
    await holdForRecording(1200);
    await button("Deny").click();
  });

  await test.step("Verify the handoff and the isolated Git branch", async () => {
    await button("View result").click();
    const result = page.getByRole("region", { name: "Run result" });
    await expect(result.getByRole("heading", { name: "Run handoff" })).toBeVisible();
    await expect(result.getByText(/2\/2 checks passed/)).toBeVisible();
    for (const command of ["npm test", "npm run e2e"]) {
      const check = result.getByRole("listitem").filter({ hasText: command });
      await expect(check.getByText("Passed", { exact: true })).toBeVisible();
    }
    const branch = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/shipyard/"], demo.repo);
    expect(branch).toMatch(/^shipyard\/[\w-]+$/);
    await expect(result.getByText(branch, { exact: true })).toBeVisible();
    expect(await git(["show", `${branch}:src/server.js`], demo.repo)).toContain('if (route === "GET /health")');
    expect(await git(["rev-parse", "HEAD"], demo.repo)).toBe(demo.baseCommit);
    expect(await git(["status", "--porcelain"], demo.repo)).toBe("");
    await holdForRecording(3300);
  });

  await test.step("Find the completed run by repository and status", async () => {
    const runs = page.getByRole("complementary", { name: "Runs" });
    const repoFilter = runs.getByRole("combobox", { name: "Filter runs by repository" });
    const statusFilter = runs.getByRole("combobox", { name: "Filter runs by status" });
    await repoFilter.selectOption({ label: "demo-shop" });
    await statusFilter.selectOption("failed");
    await expect(runs.getByText("No matching runs.")).toBeVisible();
    await statusFilter.selectOption("passed");
    await runs.getByRole("searchbox").fill("/health");
    await expect(runs.getByRole("listitem")).toContainText("Add a GET /health endpoint");
    await expect(page.getByRole("main").getByText(await realpath(demo.repo), { exact: true })).toBeVisible();
  });

  await test.step("Ask about the saved run without starting a revision", async () => {
    const result = page.getByRole("region", { name: "Run result", exact: true });
    await result.getByRole("button", { name: "Check live deployment" }).click();
    const dialog = page.getByRole("dialog", { name: "Ask about this run" });
    await expect(dialog.getByRole("heading", { name: "Deployment could not be verified" })).toBeVisible();
    await dialog.getByRole("button", { name: "Which checks passed?" }).click();
    await expect(dialog.getByText("Passed · npm run e2e", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await result.getByRole("button", { name: "Request code changes" }).click();
    const revision = page.getByRole("dialog", { name: "Request code changes" });
    await revision.getByRole("textbox", { name: "What should change?" }).fill("It´s deployed ?");
    await revision.getByRole("button", { name: "Start revision" }).click();
    await expect(dialog.getByRole("heading", { name: "Deployment could not be verified" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Runs" }).getByRole("listitem")).toHaveCount(1);
  });
});
