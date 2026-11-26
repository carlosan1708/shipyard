import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test as base } from "@playwright/test";
import type { AgentRunner } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import { dockerProjectCheck, requireDockerChecks } from "../src/docker-check.ts";
import { DEMO_APP_DIR } from "../src/eval.ts";
import { git } from "../src/exec.ts";
import { loadRoles } from "../src/roles.ts";
import { RunManager } from "../src/ui/manager.ts";
import { startUiServer } from "../src/ui/server.ts";
import { initRepoWithCommit } from "../src/worktree.ts";

const docker = promisify(execFile);
const image = "node:22-bookworm-slim";
const test = base.extend<{ fixture: { repo: string; workspace: string } }>({
  fixture: async ({}, use) => {
    const workspace = await mkdtemp(join(tmpdir(), "shipyard-docker-smoke-"));
    try {
      const repo = join(workspace, "demo-shop");
      await cp(DEMO_APP_DIR, repo, { recursive: true });
      await initRepoWithCommit(repo);
      await use({ repo, workspace });
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
    }
  },
});

test.beforeAll(async () => {
  await requireDockerChecks();
});

test("Docker sees a test fail and then pass before it is committed", async ({ fixture: { repo } }) => {
  const testFile = "test/docker-worktree.test.js";
  const title = "reads a new test from the worktree";
  const writeTest = (expected: number) => writeFile(join(repo, testFile), `
import assert from "node:assert/strict";
import { test } from "node:test";
test(${JSON.stringify(title)}, () => assert.equal(42, ${expected}));
`);

  await writeTest(0);
  const failed = await dockerProjectCheck("npm test", repo, { image });
  expect(failed.code, failed.output).toBe(1);
  expect(failed.output).toMatch(new RegExp(`^not ok \\d+ - ${title}$`, "m"));

  await writeTest(42);
  const passed = await dockerProjectCheck("npm test", repo, { image });
  expect(passed.code, passed.output).toBe(0);
  expect(passed.output).toMatch(new RegExp(`^ok \\d+ - ${title}$`, "m"));
  expect(await git(["status", "--short"], repo)).toBe(`?? ${testFile}`);
});

async function testContainers(marker: string, includeStopped = false): Promise<string[]> {
  const { stdout } = await docker("docker", ["container", "ls", ...(includeStopped ? ["--all"] : []), "--no-trunc",
    "--format", "{{.ID}}\t{{.Command}}"], { timeout: 8_000 });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const [id, command] = line.split("\t", 2);
    return id && /^[a-f0-9]{64}$/.test(id) && command?.includes(marker) ? [id] : [];
  });
}

test("Stop run in chat removes that run's live Docker container", async ({ page, fixture: { repo, workspace } }) => {
  const marker = `shipyard-smoke-${randomUUID()}`;
  const title = "Docker smoke cancellation";
  const config = parseConfig({ worktreeRoot: "worktrees", runsDir: "runs", targets: { "demo-shop": {
    path: repo, test: `node -e 'setTimeout(() => {}, 60000)' ${marker}`, checksDocker: { image },
  } } }, workspace);
  const runner: AgentRunner = {
    async run({ cwd }) {
      await writeFile(join(cwd, "docker-smoke.txt"), "A scripted change to trigger project checks.\n");
      return { ok: true, costUsd: 0, turns: 1, durationMs: 0, summary: "Created a test file." };
    },
  };
  const manager = new RunManager({ config, roles: loadRoles(), runner });
  const server = await startUiServer({ manager, config, demo: true });
  try {
    await page.goto(server.url);
    await expect(page.getByRole("banner").getByRole("status")).toHaveText("Live");
    const started = await page.request.post(new URL("/api/runs", server.url).href, { data: {
      target: "demo-shop", kind: "feature", request: title, crew: [], checkpoints: [],
    } });
    expect(started.status()).toBe(201);
    await page.getByRole("complementary", { name: "Runs" }).getByRole("button", { name: /Docker smoke cancellation/ }).click();
    const chat = page.getByRole("log", { name: "Conversation" });
    await expect(chat).toBeVisible();
    let running: string[] = [];
    await expect.poll(async () => {
      running = await testContainers(marker);
      return running;
    }, { timeout: 45_000 }).toHaveLength(1);
    const id = running[0]!;

    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Stop this run");
    await composer.press("Enter");
    await chat.getByRole("region", { name: "Run action" }).getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(chat.getByRole("heading", { name: "Run stopped", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const { stdout } = await docker("docker", ["container", "ls", "--all", "--quiet", "--filter", `id=${id}`], { timeout: 8_000 });
      return stdout.trim();
    }).toBe("");
  } finally {
    try {
      await Promise.all([manager.shutdown(), server.close()]);
    } finally {
      const leftover = await testContainers(marker, true);
      if (leftover.length) await docker("docker", ["container", "rm", "--force", "--volumes", ...leftover], { timeout: 15_000 });
    }
  }
});
