import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { parseConfig } from "../src/config.ts";
import { loadRoles } from "../src/roles.ts";
import type { DeploymentRecord, RunRecord } from "../src/store.ts";
import { DemoRunner } from "../src/ui/demo.ts";
import { RunManager } from "../src/ui/manager.ts";
import { startUiServer } from "../src/ui/server.ts";

const head = "0123456789abcdef0123456789abcdef01234567";
const token = "test-only-reviewed-commit";
const repository = "https://github.com/example/portfolio";
const pullRequest = `${repository}/pull/42`;
const common = { phase: "approval", sourceRunId: "source-run", pullRequest } as const;
const scenarios: { name: string; deployment: DeploymentRecord; destination: string; identity: string }[] = [
  {
    name: "Firebase Hosting",
    deployment: { ...common, provider: "firebase", review: {
      token, repository, pullRequest, head, branch: "main", project: "demo-project", site: "demo-site",
      url: "https://demo-site.web.app", account: "deploy@example.test", checks: ["npm test"],
    } },
    destination: "demo-site",
    identity: "deploy@example.test",
  },
  {
    name: "AWS",
    deployment: { ...common, provider: "aws", workflowReview: {
      provider: "aws", token, repository, head, branch: "main", workflow: "deploy.yml",
      workflowId: 42, environment: "test-production",
    } },
    destination: "test-production",
    identity: "deploy.yml",
  },
];

test("guides a local commit toward deployment without starting another revision", async ({ page }, info) => {
  test.skip(process.env.SHIPYARD_RECORD_DEMO === "1", "The recording follows the feature workflow.");
  const workspace = info.outputPath("workspace");
  await mkdir(workspace, { recursive: true });
  const config = parseConfig({ runsDir: "runs", worktreeRoot: "worktrees" }, workspace);
  const manager = new RunManager({ config, roles: loadRoles(), runner: new DemoRunner() });
  const finishedAt = new Date().toISOString();
  const run: RunRecord = {
    id: "local-publication-fixture", kind: "feature", target: "demo-portfolio", request: "Update the portfolio",
    tags: [], status: "passed", createdAt: finishedAt, finishedAt, repo: workspace, worktree: workspace,
    branch: "shipyard/portfolio-update", baseSha: "f".repeat(40), stages: [],
    totals: { costUsd: 0, durationMs: 0, turns: 0, attempts: 0, reviewWaitMs: 0 },
  };
  manager.store.save(run);
  const server = await startUiServer({ manager, config, demo: true });
  try {
    const destination = "origin:github.com/example/portfolio";
    const runPath = `/api/runs/${run.id}`;
    const requests: { path: string; body: unknown }[] = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === `${runPath}/result`) return route.fulfill({ json: {
        canPreview: true, handoff: { fileCount: 1, uncommittedCount: 0 },
        publish: { head, destination, canDraftPullRequest: true, pushed: false },
      } });
      if (request.method() !== "POST") return route.continue();
      const body = request.postDataJSON();
      requests.push({ path, body });
      if (path === `${runPath}/draft-pull-request` && body?.action === "review") return route.fulfill({ json: { review: {
        token, repository, head, branch: run.branch, base: { branch: "main", head: run.baseSha },
        description: "Update the portfolio", descriptionMaxLength: 32_000,
      } } });
      return route.fulfill({ status: 409, json: { error: "Unexpected request in publishing review test" } });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.url);
    await page.getByRole("complementary", { name: "Runs" }).getByRole("button", { name: /Update the portfolio/ }).click();
    const conversation = page.getByRole("log", { name: "Conversation" });
    const composer = page.getByRole("textbox", { name: "Message" });
    await expect(conversation.getByRole("button", { name: "Preview the changes" })).toBeVisible();
    await composer.fill("commit changes and redeploy it");
    await composer.press("Enter");
    const reply = conversation.getByRole("article").filter({ hasText: "The commit is saved locally." });
    const reviewAction = reply.getByRole("button", { name: "Review draft pull request", exact: true });
    await expect(reviewAction).toBeInViewport();
    await expect(reply).toContainText("then merge it on GitHub");
    await expect(conversation.getByRole("button", { name: /^Start revision$/i })).toHaveCount(0);
    expect(requests).toEqual([]);

    await reviewAction.click();
    const review = page.getByRole("dialog", { name: "Create draft pull request" });
    await expect(review.getByText("example/portfolio", { exact: true })).toBeVisible();
    await expect(review.getByText(run.branch, { exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "Approve and create draft PR" })).toBeEnabled();
    await review.getByRole("button", { name: "Cancel" }).click();
    await expect(review).toBeHidden();
    expect(requests).toEqual([{ path: `${runPath}/draft-pull-request`, body: { action: "review", head, destination, reopen: false } }]);
  } finally {
    await Promise.all([manager.shutdown(), server.close()]);
  }
});

for (const { name, deployment, destination, identity } of scenarios) {
  test(`reviews ${name} deployment in chat before sending the bound approval`, async ({ page }, info) => {
    test.skip(process.env.SHIPYARD_RECORD_DEMO === "1", "The recording follows the feature workflow.");
    const workspace = info.outputPath("workspace");
    await mkdir(workspace, { recursive: true });
    const config = parseConfig({ runsDir: "runs", worktreeRoot: "worktrees" }, workspace);
    const manager = new RunManager({ config, roles: loadRoles(), runner: new DemoRunner() });
    const run: RunRecord = {
      id: "deployment-approval-fixture", kind: "deployment", target: "demo-portfolio", request: `Deploy demo portfolio to ${name}`,
      deployment, tags: [], status: "running", createdAt: new Date().toISOString(), repo: workspace, worktree: workspace,
      branch: "main", baseSha: head, stages: [], totals: { costUsd: 0, durationMs: 0, turns: 0, attempts: 0, reviewWaitMs: 0 },
    };
    manager.store.save(run);
    const server = await startUiServer({ manager, config, demo: true });
    try {
      const submissions: unknown[] = [];
      await page.route(`**/api/runs/${run.id}/deployment`, async (route) => {
        submissions.push(route.request().postDataJSON());
        await route.fulfill({ json: { run: { ...run, deployment: { ...deployment, phase: "publishing" } } } });
      });
      await page.goto(server.url);
      await page.getByRole("button", { name: "Inbox", exact: true }).click();
      const inbox = page.getByRole("complementary", { name: "Inbox" });
      await expect(inbox.getByText(destination, { exact: true })).toBeVisible();
      await expect(inbox.getByRole("button", { name: "Approve and deploy" })).toHaveCount(0);
      await inbox.getByRole("button", { name: "Review deployment in chat" }).click();
      const conversation = page.getByRole("log", { name: "Conversation" });
      const approval = conversation.getByRole("article", { name: "Deployment approval" });
      await expect(approval).toBeFocused();
      await expect(inbox).toBeHidden();
      await expect(approval.getByText(name, { exact: true })).toBeVisible();
      await expect(approval.getByText(destination, { exact: true })).toBeVisible();
      await expect(approval.getByText(identity, { exact: true })).toBeVisible();
      await expect(approval.getByTitle(head)).toHaveText(head.slice(0, 12));
      await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
      await page.getByRole("button", { name: "Run details", exact: true }).click();
      await expect(page.getByRole("button", { name: "Approve and deploy", exact: true })).toHaveCount(1);
      expect(submissions).toEqual([]);
      await approval.getByRole("button", { name: "Approve and deploy", exact: true }).click();
      await expect(approval).toBeHidden();
      expect(submissions).toEqual([{ action: "deploy", token, confirm: true }]);
    } finally {
      await Promise.all([manager.shutdown(), server.close()]);
    }
  });
}
