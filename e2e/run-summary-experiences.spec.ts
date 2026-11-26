import { mkdir } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import { parseConfig } from "../src/config.ts";
import { loadRoles } from "../src/roles.ts";
import type { GateRecord, RunRecord, RunStatus } from "../src/store.ts";
import { DemoRunner } from "../src/ui/demo.ts";
import { RunManager, type InboxItem, type LiveMessage } from "../src/ui/manager.ts";
import { startUiServer } from "../src/ui/server.ts";

const oldTime = "2025-01-02T10:00:00.000Z";
const finishedTime = "2025-01-02T10:10:00.000Z";
const head = "0123456789abcdef0123456789abcdef01234567";
const gate: GateRecord = {
  command: "npm test", code: 1, durationMs: 1000, timedOut: false,
  outputTail: "AssertionError: expected the delivered version\n    at internalSnippet (fixtures/check.js:14:9)",
};

type Scenario = {
  save: (run: RunRecord) => void;
  emit: (message: LiveMessage) => void;
  record: (id: string, status: RunStatus) => RunRecord;
  open: (runId: string) => Promise<void>;
  snapshot: (active: string[], inbox?: InboxItem[]) => void;
};

const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({ page }, use, info) => {
    const root = info.outputPath("workspace");
    await mkdir(root, { recursive: true });
    const config = parseConfig({
      runsDir: "runs", worktreeRoot: "worktrees",
      targets: { sample: { path: root, test: "npm test" } },
    }, root);
    const manager = new RunManager({ config, roles: loadRoles(), runner: new DemoRunner() });
    const server = await startUiServer({ manager, config, demo: true });
    let active: string[] = [];
    let inbox: InboxItem[] = [];
    try {
      await page.route("**/api/state", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), active, inbox } });
      });
      await use({
        record: (id, status) => ({
          id, status, kind: "feature", target: "sample", request: `Revise the design for ${id}`,
          tags: [], createdAt: oldTime, ...(status !== "running" ? { finishedAt: finishedTime, completionRead: false } : {}),
          repo: root, branch: `shipyard/${id}`, worktree: root, baseSha: head,
          stages: [],
          totals: { costUsd: 0, durationMs: 1000, turns: 1, attempts: 1, reviewWaitMs: 0 },
        }),
        save: (run) => manager.store.save(run),
        emit: (message) => { manager.bus.emit("message", message); },
        open: async (id) => {
          await page.goto(server.url);
          await page.getByRole("complementary", { name: "Runs" }).getByRole("button", { name: new RegExp(`Revise the design for ${id}`) }).click();
          await expect(page.getByRole("banner").getByRole("status")).toHaveText("Live");
        },
        snapshot: (runs, items = []) => {
          active = runs;
          inbox = items;
        },
      });
    } finally {
      await Promise.all([manager.shutdown(), server.close()]);
    }
  },
});

function openRunControls(page: Page) {
  return {
    update: page.getByRole("log", { name: "Conversation" }).getByRole("region", { name: "Run update" }),
    side: page.getByRole("complementary", { name: "Run progress" }),
    composer: page.getByRole("textbox", { name: "Message" }),
    inbox: page.getByRole("banner").getByRole("button", { name: /^Inbox\b/ }),
  };
}

function actionRequests(page: Page): string[] {
  const submissions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/")) {
      submissions.push(new URL(request.url()).pathname);
    }
  });
  return submissions;
}

test("a quiet mobile run explains waiting, without turning an unread result into an approval", async ({ scenario, page }) => {
  test.skip(process.env.SHIPYARD_RECORD_DEMO === "1", "The recording follows the feature workflow.");
  await page.setViewportSize({ width: 390, height: 844 });
  const running = scenario.record("quiet-run", "running");
  const earlier = scenario.record("earlier-run", "passed");
  scenario.save(running);
  scenario.save(earlier);
  scenario.snapshot([running.id]);
  const submissions = actionRequests(page);
  await scenario.open(running.id);
  const { update, composer, inbox } = openRunControls(page);
  await expect(update.getByRole("heading", { name: "Run in progress", exact: true })).toBeVisible();
  await expect(update).toContainText("Shipyard will ask here if the crew needs your input.");
  await expect(composer).toBeEnabled();
  await expect(inbox).toHaveAttribute("title", /^1 completed run updates?$/);
  await composer.fill("Keep this draft while the run works.");
  await inbox.click();
  const drawer = page.getByRole("complementary", { name: "Inbox" });
  await expect(drawer.getByRole("region", { name: "Run results" })).toContainText("earlier-run");
  await expect(drawer.getByRole("button", { name: /Review in chat|Approve/ })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Close", exact: true }).click();

  const item: InboxItem = {
    id: "quiet-run-question", runId: running.id, stage: "implement", role: "backend", kind: "question", createdAt: oldTime,
    questions: [{ question: "Which accent color should the design use?", header: "Palette", multiSelect: false,
      options: [{ label: "Blue", description: "Use blue" }, { label: "Violet", description: "Use violet" }] }],
  };
  scenario.snapshot([running.id], [item]);
  scenario.emit({ type: "inbox", item });
  await expect(update.getByRole("heading", { name: "Waiting for your input", exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Conversation" }).getByRole("region", { name: "Run decisions" }))
    .toContainText("Which accent color should the design use?");
  await expect(inbox).toHaveAttribute("title", /^1 waiting for your input.*1 completed run updates?$/);
  await expect(composer).toHaveValue("Keep this draft while the run works.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(submissions).toEqual([]);
});

test("a failed check points to saved edits and keeps raw output behind technical details", async ({ scenario, page }) => {
  test.skip(process.env.SHIPYARD_RECORD_DEMO === "1", "The recording follows the feature workflow.");
  const failed = scenario.record("failed-check", "failed");
  failed.stages = [{
    name: "implement", role: "backend", status: "failed",
    attempts: [{ attempt: 1, agentOk: true, costUsd: 0, turns: 1, durationMs: 1000, summary: "An edited version is saved.",
      gates: [gate], passed: false }],
  }];
  scenario.save(failed);
  await page.route(`**/api/runs/${failed.id}/result`, (route) => route.fulfill({
    json: { handoff: { uncommittedCount: 1, uncommittedFiles: ["index.html"] }, recheckStage: "implement" },
  }));
  const submissions = actionRequests(page);
  await scenario.open(failed.id);
  const { update, side, composer } = openRunControls(page);
  await expect(update.getByRole("heading", { name: "Run needs attention", exact: true })).toBeVisible();
  await expect(update).toContainText("1 file with saved edits.");
  await expect(update).toContainText("The saved edits still need to be checked.");
  await expect(update).toContainText("Run the checks again on the saved edits.");
  await composer.fill("What do I do now?");
  await composer.press("Enter");
  await expect(page.getByRole("log", { name: "Conversation" })
    .getByText("Run needs attention. Run the checks again on the saved edits.", { exact: true })).toBeVisible();
  expect(submissions).toEqual([]);
  await side.getByRole("button", { name: "Run details", exact: true }).click();
  const details = side.getByRole("region", { name: "Run details" });
  await expect(details).toContainText("Run the checks again on the saved edits.");
  const technical = details.locator("details").filter({ has: page.getByText("Technical details", { exact: true }) }).first();
  await expect(technical).toHaveJSProperty("open", false);
  await expect(details.getByText("Run handoff", { exact: true })).toBeHidden();
  await technical.getByText("Technical details", { exact: true }).click();
  await expect(details.getByText("Run handoff", { exact: true })).toBeVisible();
  const output = details.getByText("View failed check output", { exact: true });
  await output.click();
  await expect(details.getByText(/at internalSnippet/).first()).toBeVisible();
  expect(submissions).toEqual([]);
  await update.getByRole("button", { name: "Check saved edits", exact: true }).click();
  await expect(page.getByRole("region", { name: "Run action" }).getByRole("button", { name: "Check saved edits", exact: true })).toBeVisible();
  expect(submissions).toEqual([]);
});

test("a stopped run shows resume as the next step without starting it", async ({ scenario, page }) => {
  test.skip(process.env.SHIPYARD_RECORD_DEMO === "1", "The recording follows the feature workflow.");
  const stopped = scenario.record("stopped-run", "stopped");
  scenario.save(stopped);
  await page.route(`**/api/runs/${stopped.id}/result`, (route) => route.fulfill({
    json: { handoff: { uncommittedCount: 2, uncommittedFiles: ["index.html", "styles.css"] } },
  }));
  const resumed = scenario.record(stopped.id, "running");
  await page.route(`**/api/runs/${stopped.id}/resume`, async (route) => {
    await route.fulfill({ json: { resumed: true } });
    scenario.snapshot([resumed.id]);
    scenario.save(resumed);
    scenario.emit({ type: "active", runIds: [resumed.id] });
  });
  const submissions = actionRequests(page);
  await scenario.open(stopped.id);
  const { update, side, composer } = openRunControls(page);
  await expect(update.getByRole("heading", { name: "Run stopped", exact: true })).toBeVisible();
  await expect(update).toContainText("2 files with saved edits.");
  await expect(update).toContainText("Continue from the saved worktree.");
  await side.getByRole("button", { name: "Run details", exact: true }).click();
  await expect(side.getByRole("region", { name: "Run details" })).toContainText("Continue from the saved worktree.");
  await expect(composer).toBeEnabled();
  await update.getByRole("button", { name: "Resume run", exact: true }).click();
  const resume = page.getByRole("region", { name: "Run action" }).getByRole("button", { name: "Resume run", exact: true });
  await expect(resume).toBeVisible();
  expect(submissions).toEqual([]);
  await resume.click();
  await expect(update.getByRole("heading", { name: "Run in progress", exact: true })).toBeVisible();
  expect(submissions).toEqual([`/api/runs/${stopped.id}/resume`]);
});

test("an unchanged run explains no-op completion without urging the user to preview", async ({ scenario, page }) => {
  test.skip(process.env.SHIPYARD_RECORD_DEMO === "1", "The recording follows the feature workflow.");
  const unchanged = scenario.record("unchanged-run", "passed");
  unchanged.kind = "deps";
  scenario.save(unchanged);
  await page.route(`**/api/runs/${unchanged.id}/result`, (route) => route.fulfill({
    json: { canPreview: true, handoff: { fileCount: 0, uncommittedCount: 0, files: [] } },
  }));
  const submissions = actionRequests(page);
  await scenario.open(unchanged.id);
  const { update, side } = openRunControls(page);
  await expect(update.getByRole("heading", { name: "Run complete", exact: true })).toBeVisible();
  await expect(update).toContainText("0 files changed.");
  await expect(update).toContainText("No checks recorded.");
  await expect(update).toContainText("Tell Shipyard what you’d like to change.");
  await expect(update.getByRole("button", { name: /Preview/ })).toHaveCount(0);
  await expect(side.getByRole("region", { name: "Run details" })).toBeHidden();
  expect(submissions).toEqual([]);
});
