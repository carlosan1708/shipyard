import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test as base, type Response } from "@playwright/test";
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

const test = base.extend<{ recoveryMode: boolean; demo: { url: string; repo: string; baseCommit: string } }>({
  recoveryMode: [false, { option: true }],
  demo: async ({ recoveryMode }, use) => {
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
      const scripted = new DemoRunner(recording ? 320 : 5);
      const runner = recoveryMode ? { run: async () => ({ ok: false, costUsd: 0, turns: 0, durationMs: 0, summary: "",
        error: "Failed to authenticate: OAuth session expired and could not be refreshed" }) } : scripted;
      const configFile = recoveryMode ? join(workspace, "shipyard.config.yaml") : undefined;
      if (configFile) {
        await writeFile(configFile, "targets: {}\n");
        const checkout = join(workspace, ".shipyard", "repos", "local-portfolio");
        await cp(DEMO_APP_DIR, checkout, { recursive: true });
        await initRepoWithCommit(checkout);
      }
      const recoveryCodex = { run: (req: Parameters<DemoRunner["run"]>[0]) => req.role.name === "backend" && req.prompt.includes("Simulate the worktree access failure")
        ? Promise.resolve({ ok: true, costUsd: 0, turns: 1, durationMs: 0, summary: "The read-only sandbox blocked edits to the worktree." })
        : scripted.run(req) };
      const manager = new RunManager({ config, roles: loadRoles(), runner, codexRunner: recoveryMode ? recoveryCodex : undefined,
        configFile, hostedRepositoryLookup: async () => [] });
      const server = await startUiServer({ manager, config, demo: !recoveryMode });
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

test.describe("chat recovery", () => {
  test.use({ recoveryMode: true });

  test("explains a blocked worktree and opens provider recovery from chat", async ({ demo, page }) => {
    test.skip(recording, "The recording follows the feature workflow.");
    await page.goto(demo.url);
    await expect(page.getByRole("banner").getByRole("status")).toHaveText("Live");
    const created = await page.request.post(new URL("/api/runs", demo.url).href, { data: {
      target: "demo-shop", kind: "feature", request: "Simulate the worktree access failure", provider: "codex", crew: [], checkpoints: ["implement"],
    } });
    expect(created.status()).toBe(201);
    await page.getByText("Active run", { exact: true }).click();
    await page.getByRole("button", { name: "demo-shop · Simulate the worktree access failure", exact: true }).click();
    const decision = page.getByRole("log", { name: "Conversation" }).getByRole("region", { name: "Run decisions" });
    await expect(decision.getByText("Worktree access blocked", { exact: true })).toBeVisible();
    await expect(decision.getByRole("button", { name: "Copy recovery handoff" })).toBeVisible();
    await expect(decision.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await decision.getByRole("button", { name: "Switch to Claude", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Switch to Claude" })).toBeVisible();
  });

  test("selects a local checkout from the chat repository dropdown", async ({ demo, page }) => {
    test.skip(recording, "The recording follows the feature workflow.");
    await page.goto(demo.url);
    const repository = page.getByLabel("Repository", { exact: true });
    const local = repository.locator("optgroup").filter({ has: page.locator('option[data-repo]', { hasText: "local-portfolio" }) });
    await expect(local).toHaveAttribute("label", "Local repositories • add to use");
    await repository.selectOption("demo-shop");
    await repository.selectOption({ label: "local-portfolio" });
    const dialog = page.getByRole("dialog", { name: "Add a repo" });
    await expect(dialog.getByLabel("Folder or Git URL")).toHaveValue(/local-portfolio$/);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(repository).toHaveValue("demo-shop");

    await repository.selectOption({ label: "local-portfolio" });
    await expect(dialog.getByLabel("Test command", { exact: true })).toHaveValue("npm test");
    await dialog.getByRole("button", { name: "Add repo", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(repository).toHaveValue("local-portfolio");
    await expect(repository.locator('optgroup[label="Added repositories"] option[value="local-portfolio"]')).toHaveCount(1);
    await expect(local).toHaveCount(0);
  });

  test("guides hosted-site requests and offers a visible recovery when a provider expires", async ({ demo, page }) => {
    test.skip(recording, "The recording follows the feature workflow.");
    await page.goto(demo.url);
    const conversation = page.getByRole("log", { name: "Conversation" });
    const input = page.getByRole("textbox", { name: "Message" });
    const send = async (text: string) => {
      await input.fill(text);
      await input.press("Enter");
    };
    await send("https://carlosan1708-portfolio.web.app/\nfind repo and clone it");
    await expect(conversation.getByText("That link opens a deployed website.", { exact: false })).toBeVisible();
    await expect(conversation.getByRole("alert")).toHaveCount(0);
    await expect(conversation.getByRole("button", { name: "Choose a local repo or enter a Git URL" })).toBeVisible();
    await send("https://github.com/example/site/tree/main");
    await conversation.getByRole("button", { name: "Review clone setup" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a repo" });
    await expect(dialog.getByRole("textbox", { name: "Folder or Git URL" })).toHaveValue("https://github.com/example/site.git");
    await expect(dialog.getByRole("button", { name: "Clone repo" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const request = 'Add a GET /health endpoint that returns {"status": "ok"}.';
    await send(request);
    const alert = conversation.getByRole("alert");
    await expect(alert.getByRole("heading", { name: "Claude needs authentication" })).toBeVisible();
    await expect(alert.getByText("claude auth login", { exact: true })).toBeVisible();
    await expect(input).toHaveValue(request);
    await conversation.getByRole("button", { name: "Retry with Codex" }).click();
    await expect(conversation.getByRole("button", { name: "Review setup for Reviewed change" })).toBeVisible();
    await expect(alert).toHaveCount(0);
    await expect(conversation.getByText(request, { exact: true })).toHaveCount(1);
    await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("codex");
  });
});

test("imports a legacy tab transcript and reopens saved chats in another browser session", async ({ demo, page, browser }) => {
  test.skip(recording, "The recording follows the feature workflow.");
  const opening = "Plan a feature for the checkout flow.";
  await page.addInitScript((text) => {
    if (sessionStorage.getItem("shipyard.chat.v1")) return;
    sessionStorage.setItem("shipyard.chat.v1", JSON.stringify({ messages: [
      { role: "user", content: text }, { role: "assistant", content: "Start with the payment step." },
    ], target: "demo-shop", provider: "claude", runId: null }));
  }, opening);
  await page.goto(demo.url);
  const originalHistory = page.getByRole("region", { name: "Chats" });
  await expect(originalHistory.getByRole("button", { name: opening, exact: true })).toBeVisible();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto(demo.url);
    const conversation = other.getByRole("log", { name: "Conversation" });
    await expect(conversation.getByText("Start with the payment step.")).toBeVisible();
    await other.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(conversation.getByRole("heading", { name: "What do you want to work on?" })).toBeVisible();
    const prompt = "Add a health endpoint in this separate chat.";
    await other.getByRole("textbox", { name: "Message" }).fill(prompt);
    await other.getByRole("textbox", { name: "Message" }).press("Enter");
    const history = other.getByRole("region", { name: "Chats" });
    await expect(history.getByRole("button", { name: prompt, exact: true })).toBeVisible();
    await expect(originalHistory.getByRole("button", { name: prompt, exact: true })).toBeVisible();
    await history.getByRole("button", { name: opening, exact: true }).click();
    await expect(conversation.getByText("Start with the payment step.")).toBeVisible();
    await other.reload();
    await expect(conversation.getByText("Start with the payment step.")).toBeVisible();
  } finally { await otherContext.close(); }
});

test("opens in chat and carries a revised crew into the confirmed run", async ({ demo, page }) => {
  test.skip(recording, "The recording follows the feature workflow.");
  await page.goto(demo.url);
  await expect(page.getByRole("heading", { name: "Shipyard chat" })).toBeVisible();
  await expect(page.locator("#chat-command-menu")).toBeHidden();
  const conversation = page.getByRole("log", { name: "Conversation" });
  const input = page.getByRole("textbox", { name: "Message" });
  const send = async (text: string) => {
    await input.fill(text);
    await input.press("Enter");
  };
  await send("Help me plan a small feature.");
  await expect(conversation.getByText("What should GET /health return?", { exact: false })).toBeVisible();
  await page.locator("#chat-attachment-input").setInputFiles({ name: "expected-response.txt", mimeType: "text/plain", buffer: Buffer.from('Return {"status":"ok"}.') });
  await expect(page.getByRole("button", { name: "Remove expected-response.txt" })).toBeVisible();
  await send('Add a GET /health endpoint that returns {"status": "ok"}.');
  const reviewed = conversation.getByRole("button", { name: "Review setup for Reviewed change" });
  await expect(reviewed).toBeVisible();
  const sequence = reviewed.locator("xpath=ancestor::article[1]").getByRole("list", { name: "Subagents in execution order" });
  await expect(sequence.getByRole("listitem")).toHaveCount(6);
  await expect(sequence.getByRole("listitem").first()).toContainText("planner");
  await expect(sequence.getByRole("listitem").last()).toContainText("Repair if E2E fails");
  await expect(page.getByRole("complementary", { name: "Runs" }).getByText("No runs yet.", { exact: false })).toBeVisible();
  await reviewed.click();
  const settings = page.getByRole("dialog", { name: "New run" });
  await expect(settings.getByLabel("Target repo")).toHaveValue("demo-shop");
  await expect(settings.getByLabel("Run reviewer")).toBeChecked();
  await expect(settings.getByLabel("Run e2e-tester")).toBeChecked();
  await expect(settings.getByRole("button", { name: "Remove expected-response.txt", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();

  await send("Please include code review and security review in parallel.");
  const parallel = conversation.getByRole("button", { name: "Review setup for Parallel reviews" });
  const parallelCrew = parallel.locator("xpath=ancestor::article[1]").getByRole("list", { name: "Subagents in execution order" });
  await expect(parallelCrew).toContainText("Security recheck after code changes");
  await expect(parallelCrew.getByRole("listitem").filter({ hasText: "Parallel reviews" })).toContainText(/reviewer.*security-auditor/);
  await parallel.click();
  await expect(settings.getByLabel("Run code review and security review in parallel", { exact: false })).toBeChecked();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();

  await send("Use the focused option and keep it quick.");
  await expect(conversation.getByText("The focused run keeps the project checks", { exact: false })).toBeVisible();
  await page.reload();
  await expect(conversation.getByText("Use the focused option and keep it quick.", { exact: true })).toBeVisible();
  await conversation.getByRole("button", { name: "Review setup for Focused change" }).last().click();
  await expect(settings.getByLabel("Feature request")).toHaveValue(/Use the focused option/);
  await expect(settings.getByLabel("Run reviewer")).not.toBeChecked();
  await settings.getByLabel("Run reviewer").check();
  const started = page.waitForResponse((response) => response.url().endsWith("/api/runs") && response.request().method() === "POST");
  await settings.getByRole("button", { name: "Start run" }).click();
  const response = await started;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ target: "demo-shop", kind: "feature", crew: ["review"] });
  expect(response.request().postDataJSON().chatAttachmentIds).toHaveLength(1);
  await expect(conversation.getByText("Run started for demo-shop.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shipyard chat" })).toBeVisible();
  await expect(conversation.getByText("Run proposal", { exact: true })).toBeVisible();
  const runProgress = page.getByRole("complementary", { name: "Run progress" });
  const [progressBox, threadBox] = await Promise.all([runProgress.boundingBox(), conversation.boundingBox()]);
  expect(progressBox!.x).toBeGreaterThanOrEqual(threadBox!.x + threadBox!.width);
  const runInSidebar = page.getByRole("complementary", { name: "Runs" }).getByRole("listitem").filter({ hasText: /Add a GET \/health endpoint/ });
  await input.fill("Keep this draft while I inspect the run.");
  await runInSidebar.getByRole("button").click();
  await runProgress.getByRole("button", { name: "Run details", exact: true }).click();
  const details = runProgress.getByRole("region", { name: "Run details" });
  await expect(details).toBeVisible();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Keep this draft while I inspect the run.");
  await expect(page.getByRole("region", { name: "Chats" })).toBeVisible();
  await expect(conversation.getByText("Run started for demo-shop.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(conversation.getByText("Run started for demo-shop.", { exact: true })).toHaveCount(0);
  await runInSidebar.getByRole("button").click();
  await expect(conversation.getByText("Run started for demo-shop.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Keep this draft while I inspect the run.");
});

test("chat distinguishes independent runs from the subagents queued within each run", async ({ demo, page }) => {
  test.skip(recording, "The recording follows the feature workflow.");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(demo.url);
  await expect(page.getByRole("banner").getByRole("status")).toHaveText("Live");
  const start = (request: string) => page.request.post(new URL("/api/runs", demo.url).href, { data: {
    target: "demo-shop", kind: "feature", request, crew: ["plan"], checkpoints: ["plan"],
  } });
  const longRequest = `Add a status endpoint for ${"an exceptionally long workspace request ".repeat(12)}the catalog`;
  const responses = await Promise.all([start("Add a health endpoint"), start(longRequest)]);
  expect(responses.map((response) => response.status())).toEqual([201, 201]);
  await page.getByText("2 runs in parallel", { exact: true }).click();
  await page.getByRole("button", { name: `demo-shop · ${longRequest}`, exact: true }).click();
  const progress = page.getByRole("complementary", { name: "Run progress" });
  const sequence = progress.getByRole("list", { name: "Subagents in execution order" });
  await expect(sequence.getByRole("listitem")).toHaveCount(2);
  await expect(sequence.getByRole("listitem").first()).toContainText("Needs you");
  await expect(sequence.getByRole("listitem").last()).toContainText("Queued");
  const chat = page.getByRole("textbox", { name: "Message" });
  await expect(chat).toBeInViewport();
  await chat.fill("Search the web for the Node.js test runner documentation.");
  await chat.press("Enter");
  const sources = page.getByRole("region", { name: "Web sources" });
  await sources.getByText("Searched the web · 1 source", { exact: true }).click();
  await expect(sources.getByRole("link", { name: "Node.js test runner documentation" })).toHaveAttribute("href", "https://nodejs.org/api/test.html");
  const conversation = page.getByRole("log", { name: "Conversation" });
  const decisions = conversation.getByRole("region", { name: "Run decisions" });
  const update = conversation.getByRole("region", { name: "Run update" });
  await expect(decisions.getByRole("group", { name: /Should the health check also report how many products the catalog has\?/ })).toHaveCount(1);
  await expect(decisions.getByRole("button", { name: "Send answer" })).toBeVisible();
  await expect(update.getByRole("heading", { name: /complete/i })).toHaveCount(0);
  await expect(update.getByRole("button", { name: "Preview the changes" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await progress.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);

  await page.getByRole("banner").getByRole("button", { name: /^Inbox/ }).click();
  const inbox = page.getByRole("complementary", { name: "Inbox" });
  const otherQuestion = inbox.getByRole("article").filter({ hasText: "Add a health endpoint" });
  await otherQuestion.getByRole("button", { name: "Review in chat" }).click();
  await expect(inbox).toBeHidden();
  await expect(progress.getByRole("heading", { name: "Add a health endpoint", exact: true })).toBeVisible();
  await expect(decisions.getByRole("article", { name: "Question" })).toBeFocused();
  await expect(sources).toHaveCount(0);
});

test("shows the approved bug behavior, both test outcomes, and the fix diff", async ({ demo, page }) => {
  test.skip(recording, "The recording follows the feature workflow.");
  await page.goto(demo.url);
  await page.getByRole("banner").getByRole("button", { name: "New run", exact: true }).click();
  const form = page.getByRole("dialog", { name: "New run" });
  await form.getByRole("radio", { name: "Fix a bug" }).check();
  await form.getByLabel("Bug report").fill("Fix GET /health returning 404 for uptime monitors.");
  for (const stage of ["plan", "implement"]) await form.getByLabel(`Pause after ${stage}`, { exact: true }).uncheck();
  for (const stage of ["plan", "review", "e2e"]) {
    await form.locator(`tr[data-stage="${stage}"] input[name="run"]`).uncheck();
  }
  await form.getByRole("button", { name: "Start run" }).click();
  const conversation = page.getByRole("log", { name: "Conversation" });
  const decisions = conversation.getByRole("region", { name: "Run decisions" });
  await expect(decisions.getByText("Expected behavior", { exact: true })).toBeVisible();
  await decisions.getByRole("button", { name: "Approve expected behavior" }).click();
  const run = page.getByRole("complementary", { name: "Run progress" });
  await expect(run.getByText("Passed", { exact: true }).first()).toBeVisible();
  await run.getByRole("button", { name: "Run details", exact: true }).click();
  const regression = run.getByRole("region", { name: "Bug verification" });
  await expect(regression).toBeHidden();
  await run.getByText("Technical details", { exact: true }).click();
  await expect(regression.getByRole("heading")).toHaveText("Bug verification · Verified");
  await expect(regression.getByText("uptime monitors can poll GET /health", { exact: true })).toBeVisible();
  await expect(regression.getByText(/failed with the approved assertion/)).toBeVisible();
  await expect(regression.getByText(/named test passed/)).toBeVisible();
  await regression.getByText("Fix diff", { exact: true }).click();
  await expect(regression.getByText("diff --git a/src/server.js b/src/server.js", { exact: true })).toBeVisible();

  const worktrees = await git(["worktree", "list", "--porcelain"], demo.repo);
  const worktree = worktrees.split("\n").filter((line) => line.startsWith("worktree ")).at(-1)!.slice("worktree ".length);
  await git(["-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "--allow-empty", "-m", "Advance the run branch"], worktree);
  const newHead = await git(["rev-parse", "HEAD"], worktree);
  await expect(regression.getByRole("heading")).toHaveText("Bug verification · Out of date");
  await expect(regression.getByRole("button", { name: "Recheck regression" })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Recheck regression");
  await composer.press("Enter");
  const recheck = conversation.getByRole("region", { name: "Run action" }).getByRole("button", { name: "Recheck regression", exact: true });
  await expect(recheck).toBeVisible();
  await expect(regression.getByRole("heading")).toHaveText("Bug verification · Out of date");
  const verification = page.waitForResponse((response) => /\/api\/runs\/[^/]+\/verify$/.test(new URL(response.url()).pathname) &&
    response.request().method() === "POST");
  await recheck.click();
  expect((await verification).ok()).toBe(true);
  await expect(regression.getByRole("heading")).toHaveText("Bug verification · Verified");
  await expect(regression.getByText(newHead.slice(0, 12), { exact: true })).toBeVisible();
  await expect(conversation.getByText("Regression recheck complete. See Run details.", { exact: true })).toBeVisible();
});

test("ships a health endpoint from request to verified handoff", async ({ demo, page }) => {
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const conversation = page.getByRole("log", { name: "Conversation" });
  const decisions = conversation.getByRole("region", { name: "Run decisions" });
  const decision = (name: string) => decisions.getByRole("button", { name, exact: true });
  const statusOnly = decisions.getByRole("radio", { name: /Just the status/ });
  const run = page.getByRole("complementary", { name: "Run progress" });
  const update = conversation.getByRole("region", { name: "Run update" });

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
    await decisions.getByText("Attachments", { exact: true }).click();
    await decisions.getByLabel("Attach files or images").setInputFiles({
      name: "payload-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Return the status only."),
    });
    await holdForRecording(1600);
    const answered = page.waitForResponse((response) => /\/api\/inbox\/[^/]+$/.test(response.url()) && response.request().method() === "POST");
    await decision("Send answer").click();
    const answer = await answered;
    expect(answer.ok()).toBe(true);
    expect(answer.request().postDataJSON()).toMatchObject({
      kind: "question",
      attachments: [{ name: "payload-notes.txt" }],
    });
    await expect(decision("Approve the plan")).toBeVisible();
    await holdForRecording(1500);
    await decision("Approve the plan").click();
  });

  await test.step("Inspect the implementation and approve its passing gate", async () => {
    await expect(decision("Approve")).toBeVisible();
    const changed = decisions.getByText("Changed files (2)", { exact: true });
    await expect(changed).toBeHidden();
    await decisions.getByText("Review details", { exact: true }).click();
    await changed.click();
    await expect(decisions.getByText(/M\s+src\/server\.js/)).toBeVisible();
    await expect(decisions.getByText(/A\s+test\/health\.test\.js/)).toBeVisible();
    await decisions.getByText("Checks (1 passed)", { exact: true }).click();
    await expect(decisions.getByRole("listitem").filter({ hasText: "npm test" })).toBeVisible();
    await holdForRecording(2400);
    await decision("Approve").click();
  });

  await test.step("Approve the revision prompted by the reviewer", async () => {
    await expect(decision("Approve")).toBeVisible();
    await decisions.getByText("Review details", { exact: true }).click();
    await expect(decisions.getByText(/added a test that POST \/health is not a route/)).toBeVisible();
    await holdForRecording(1800);
    await decision("Approve").click();
  });

  await test.step("Decline optional web access for the E2E tester", async () => {
    await expect(decision("Deny")).toBeVisible();
    await holdForRecording(1200);
    await decision("Deny").click();
  });

  await test.step("Verify the handoff and the isolated Git branch", async () => {
    await expect(update.getByRole("heading", { name: "Run complete", exact: true })).toBeVisible();
    await expect(update).toContainText(/passed.*checks|checks.*passed/i);
    const inboxToggle = page.getByRole("banner").getByRole("button", { name: /^Inbox/ });
    await expect(inboxToggle).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: /^Needs you/ })).toHaveCount(0);
    await inboxToggle.click();
    const inbox = page.getByRole("complementary", { name: "Inbox" });
    await inbox.getByRole("button", { name: "View result", exact: true }).click();
    await expect(inbox).toBeHidden();
    await expect(update.getByRole("heading", { name: "Run complete", exact: true })).toBeVisible();
    await expect(run.getByRole("region", { name: "Run details" })).toBeHidden();
    await run.getByRole("button", { name: "Run details", exact: true }).click();
    const plainDetails = run.getByRole("region", { name: "Run details" });
    await expect(plainDetails.getByText("Next step", { exact: true })).toBeVisible();
    const result = run.getByRole("region", { name: "Run result" });
    await expect(result).toBeHidden();
    await run.getByText("Technical details", { exact: true }).click();
    await expect(result.getByRole("heading", { name: "Run handoff" })).toBeVisible();
    await expect(result.getByText(/2\/2 checks passed/)).toBeVisible();
    await expect(result.getByRole("button", { name: /^(?:Ask about this run|Check live deployment|Request code changes|Copy worktree path|Run locally)$/ })).toHaveCount(0);
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
    await expect(runs.locator("#run-list").getByRole("listitem")).toContainText("Add a GET /health endpoint");
    const details = run.getByRole("region", { name: "Run details" });
    await details.getByText("Run metadata", { exact: true }).click();
    await expect(details.getByText(await git(["rev-parse", "--show-toplevel"], demo.repo), { exact: true })).toBeVisible();
  });

  await test.step("Ask about the saved run without leaving chat or starting a revision", async () => {
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Check live deployment");
    await composer.press("Enter");
    await expect(conversation.getByText("Deployment could not be verified", { exact: true })).toBeVisible();
    await expect(composer).toBeVisible();
    await composer.fill("Which checks passed?");
    await composer.press("Enter");
    await expect(conversation.getByText("Passed · npm run e2e", { exact: true })).toBeVisible();
    await expect(page.locator("#run-list").getByRole("listitem")).toHaveCount(1);
  });

  if (recording) return;
  await test.step("Discover a command and confirm the local launch in chat", async () => {
    const composer = page.getByRole("textbox", { name: "Message" });
    const localAppPath = /\/api\/runs\/[^/]+\/local-app$/;
    const launches: string[] = [];
    await page.route(localAppPath, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      launches.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: { url: "http://127.0.0.1:6000/" } });
    });
    const commands = page.getByText("Commands", { exact: true });
    const choose = commands.locator("..").getByRole("button", { name: "Run locally", exact: true });
    await expect(choose).toHaveCount(0);
    await commands.click();
    await choose.click();
    await expect(composer).toHaveValue(/run locally/i);
    expect(launches).toEqual([]);

    await composer.press("Enter");
    const confirm = conversation.getByRole("region", { name: "Run action" }).getByRole("button", { name: "Run locally", exact: true });
    await expect(confirm).toBeVisible();
    expect(launches).toEqual([]);
    const launched = page.waitForResponse((response) => localAppPath.test(response.url()) && response.request().method() === "POST");
    const resultPath = /\/api\/runs\/[^/]+\/result$/;
    let releaseResult!: () => void;
    const holdResult = new Promise<void>((resolve) => { releaseResult = resolve; });
    await page.route(resultPath, async (route) => {
      await holdResult;
      await route.continue();
    }, { times: 1 });
    const pendingResult = page.waitForRequest((request) => resultPath.test(request.url()));
    const refreshed = page.waitForResponse((response) => resultPath.test(response.url()));
    try {
      await confirm.click();
      expect((await launched).ok()).toBe(true);
      expect(launches).toHaveLength(1);
      await expect(conversation.getByRole("region", { name: "Run action" }).getByRole("link", { name: "Open local app" }))
        .toHaveAttribute("href", "http://127.0.0.1:6000/");
      await pendingResult;
      await composer.fill("Request code changes");
      await composer.press("Enter");
      await expect(page.locator("#chat-status")).toContainText("Loading the run’s available actions");
      const newDraft = "Keep this new draft while the actions load.";
      await composer.fill(newDraft);
      releaseResult();
      expect((await refreshed).ok()).toBe(true);
      await commands.click();
      await expect(commands.locator("..").getByRole("button", { name: "Request code changes", exact: true })).toBeVisible();
      await expect(composer).toHaveValue(newDraft);
      await expect(button("Review revision")).toHaveCount(0);
      await commands.click();
    } finally {
      releaseResult();
    }
  });

  await test.step("Review and retry a revision in the same chat", async () => {
    const composer = page.getByRole("textbox", { name: "Message" });
    const brief = "Make the /health response useful for uptime monitors.";
    await composer.fill("Request code changes");
    await composer.press("Enter");
    await expect(button("Review revision")).toBeVisible();
    await expect(composer).toBeFocused();
    await composer.fill(brief);
    await page.locator("#chat-attachment-input").setInputFiles({
      name: "revision-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Keep the response compact."),
    });
    await button("Review revision").click();
    const revision = conversation.getByRole("region", { name: "Revision proposal" });
    const start = revision.getByRole("button", { name: "Start revision", exact: true });
    const attachment = revision.getByRole("button", { name: "Remove revision-notes.txt" });
    await expect(start).toBeVisible();
    await expect(revision.getByText(brief, { exact: true })).toBeVisible();
    await expect(attachment).toBeVisible();
    await expect(revision.getByLabel("Revision provider")).toBeHidden();
    await expect(page.getByRole("dialog", { name: "Request code changes" })).toHaveCount(0);
    await expect(composer).toBeVisible();

    const feedbackPath = /\/api\/runs\/[^/]+\/feedback$/;
    const matchesFeedback = (response: Response) =>
      feedbackPath.test(response.url()) && response.request().method() === "POST";
    await page.route(feedbackPath, (route) => route.fulfill({
      status: 409, json: { error: "The branch is temporarily busy. Try again." },
    }), { times: 1 });
    const failureResponse = page.waitForResponse(matchesFeedback);
    await start.click();
    const failure = await failureResponse;
    const draft = failure.request().postDataJSON();
    expect(draft).toMatchObject({ message: brief, provider: "claude", attachments: [{ name: "revision-notes.txt" }] });
    await expect(revision.getByRole("alert")).toContainText("The branch is temporarily busy. Try again.");
    await expect(attachment).toBeVisible();

    const retryResponse = page.waitForResponse(matchesFeedback);
    await start.click();
    const retry = await retryResponse;
    expect(retry.status()).toBe(201);
    expect(retry.request().postDataJSON()).toEqual(draft);
    await expect(conversation.getByText(/Revision started/)).toBeVisible();
    await expect(conversation.getByText("Deployment could not be verified", { exact: true })).toBeVisible();
    await expect(composer).toBeVisible();
  });

  await test.step("Preview the completed revision on a phone-sized screen", async () => {
    await expect(update.getByRole("heading", { name: "Revision complete", exact: true })).toBeVisible({ timeout: 25_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(update.getByRole("heading", { name: "Revision complete", exact: true })).toBeVisible();
    const preview = update.getByRole("button", { name: "Preview the changes", exact: true });
    await expect(update.getByRole("button")).toHaveCount(1);
    await expect(preview).toBeInViewport();
    const run = page.getByRole("complementary", { name: "Run progress" });
    await run.getByRole("button", { name: "Run details", exact: true }).click();
    await expect(preview).toBeInViewport();
    await run.getByRole("button", { name: "Hide details", exact: true }).click();
    const response = page.waitForResponse((entry) => /\/api\/runs\/[^/]+\/preview$/.test(new URL(entry.url()).pathname) &&
      entry.request().method() === "POST");
    const popup = page.context().waitForEvent("page", { timeout: 4000 }).catch(() => null);
    await preview.click();
    const launched = await response;
    expect(launched.ok()).toBe(true);
    const { url } = await launched.json() as { url: string };
    const tab = await popup;
    if (tab) {
      const previewPage = new URL(url);
      previewPage.search = "";
      await expect(tab).toHaveURL(previewPage.href);
      await expect(tab.getByRole("heading", { name: "Demo shop" })).toBeVisible();
      await tab.close();
    } else {
      await expect(conversation.getByRole("link", { name: "Open local preview", exact: true })).toHaveAttribute("href", url);
    }
  });

  await test.step("Keep a completed revision with its start when the chat continues", async () => {
    const composer = page.getByRole("textbox", { name: "Message" });
    const revisionStarted = conversation.getByRole("button", { name: "Revision started.", exact: true });
    const followup = conversation.getByText("What changed?", { exact: true });
    const reply = conversation.getByText("Changes saved by this run", { exact: true });
    const expectRevisionOrder = async () => {
      await expect(revisionStarted.or(update).or(followup).or(reply))
        .toHaveText(["Revision started.", /^Revision complete/, "What changed?", "Changes saved by this run"]);
      await expect(reply).toBeInViewport();
      await expect(composer).toBeInViewport();
    };

    await composer.fill("What changed?");
    await composer.press("Enter");
    await expectRevisionOrder();
    await page.reload();
    await expectRevisionOrder();
  });

  await test.step("Open the original result from the same chat", async () => {
    const original = page.locator("#run-list").getByRole("listitem").filter({ hasText: /Add a GET \/health endpoint/ });
    await original.getByRole("button").click();
    await expect(update.getByRole("heading", { name: "Run complete", exact: true })).toBeVisible();
    await expect(conversation.getByText(/Revision started/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(update.getByRole("button", { name: "Open latest revision", exact: true })).toBeVisible();
  });
});
