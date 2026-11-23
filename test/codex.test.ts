import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { AgentEvent } from "../src/agent.ts";
import { CodexAgentRunner } from "../src/codex.ts";
import { CODEX_TIMEOUT_MS, SHIPYARD_ROOT, parseConfig } from "../src/config.ts";
import { formatReport } from "../src/eval.ts";
import { git } from "../src/exec.ts";
import { REVIEW_SCHEMA } from "../src/prompts.ts";
import { loadRoles, requireRole } from "../src/roles.ts";
import { RunStore } from "../src/store.ts";
import { initRepoWithCommit } from "../src/worktree.ts";
import { tempDir, writeFiles } from "./helpers.ts";

const execFileAsync = promisify(execFile);

const fake = `#!/usr/bin/env node
const {readFileSync, writeFileSync} = require("node:fs");
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const get = (flag) => args[args.indexOf(flag) + 1];
const emit = (event) => console.log(JSON.stringify(event));
const resume = args.indexOf("resume");
const thread = resume < 0 ? "thread-abc" : args[resume + 1];
if (prompt.includes("FAKE_HANG")) {
  emit({type: "thread.started", thread_id: thread});
  emit({type: "item.completed", item: {type: "agent_message", text: "Waiting"}});
  setInterval(() => {}, 1000);
} else if (prompt.includes("FAKE_AUTH")) {
  emit({type: "turn.failed", error: {message: "Authentication failed: Unauthorized"}});
  process.exitCode = 1;
} else {
  const hasSchema = args.includes("--output-schema");
  const schema = hasSchema ? JSON.parse(readFileSync(get("--output-schema"), "utf8")) : undefined;
  const start = {type: "thread.started", thread_id: thread};
  const startLine = JSON.stringify(start);
  process.stdout.write(startLine.slice(0, 10));
  process.stdout.write(startLine.slice(10) + "\\n");
  emit({type: "item.started", item: {type: "command_execution", command: "ls"}});
  emit({type: "item.completed", item: {type: "agent_message", text: "Working"}});
  if (prompt.startsWith("You are the end-to-end test engineer")) {
    writeFileSync("built.txt", "out-of-lane edit");
    writeFileSync("e2e/shipyard.e2e.test.js", 'import { test } from "node:test"; test("passes", () => {});');
  } else if (prompt.includes("FAKE_BUILD") && !hasSchema) {
    writeFileSync("built.txt", "made by Codex\\n");
  }
  const summary = hasSchema
    ? JSON.stringify(prompt.includes("FAKE_INVALID") ? {verdict: "approve"} : {
      verdict: "approve", summary: "Looks good", findings: [
        {severity: "minor", file: null, line: null, issue: "An optional detail", suggestion: null}
      ]
    })
    : JSON.stringify({args, prompt, schema, path: process.cwd()});
  if (hasSchema && !schema.properties.findings.items.required.includes("line")) throw new Error("Codex needs a strict schema");
  emit({type: "turn.completed", usage: {input_tokens: 122, cached_input_tokens: 22, output_tokens: 34}});
  writeFileSync(get("--output-last-message"), summary);
}
`;

function fixture(t: TestContext): string {
  const root = tempDir("shipyard-codex-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeExecutable(root: string): string {
  const path = join(root, "codex");
  writeFileSync(path, fake);
  chmodSync(path, 0o755);
  return path;
}

test("Codex reads JSONL events and final structured output, and resumes with the current lane", async (t) => {
  const root = fixture(t);
  const executable = fakeExecutable(root);
  const repo = join(root, "repo");
  writeFiles(repo, { "README.md": "# test\n" });
  await initRepoWithCommit(repo);
  const events: AgentEvent[] = [];
  const role = requireRole(loadRoles(), "reviewer");
  const runner = new CodexAgentRunner(10_000, executable);
  const review = await runner.run({ role, lane: "none", cwd: repo, prompt: "Review the change", outputSchema: REVIEW_SCHEMA, onEvent: (event) => events.push(event) });
  assert.ok(review.ok, review.error ?? "Review failed");
  assert.equal(review.sessionId, "thread-abc");
  assert.deepEqual(review.usage, { inputTokens: 122, cachedInputTokens: 22, outputTokens: 34 });
  assert.equal(review.costUsd, null);
  assert.deepEqual(review.structured, {
    verdict: "approve", summary: "Looks good", findings: [{ severity: "minor", issue: "An optional detail" }],
  });
  assert.deepEqual(events, [{ type: "session", sessionId: "thread-abc" }, { type: "tool", tool: "Bash", detail: "ls" }, { type: "text", text: "Working" }]);
  const retry = await runner.run({ role, lane: "no-e2e", cwd: repo, prompt: "Address feedback", model: "codex-test", effort: "xhigh", resumeSessionId: review.sessionId });
  assert.ok(retry.ok, retry.error ?? "Retry failed");
  const { args, prompt } = JSON.parse(retry.summary) as { args: string[]; prompt: string };
  assert.equal(args[args.indexOf("resume") + 1], "thread-abc");
  assert.equal(args[args.indexOf("--model") + 1], "codex-test");
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes('mcp_servers.shipyard_browser.enabled_tools=["read_public_page"]'));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(prompt.startsWith(role.prompt));
  assert.match(prompt, /Address feedback/);
  const image = join(root, "feedback image.png");
  const plan = await runner.run({ role, lane: "none", cwd: repo, prompt: "Plan it", images: [{ path: image, mediaType: "image/png" }] });
  assert.ok(plan.ok, plan.error ?? "Plan failed");
  const planArgs = JSON.parse(plan.summary).args;
  assert.ok(planArgs.includes('sandbox_mode="read-only"'));
  assert.ok(!planArgs.includes("--model"));
  assert.ok(!planArgs.some((arg: string) => arg.startsWith("model_reasoning_effort=")));
  assert.equal(planArgs[planArgs.indexOf("--image") + 1], image);
});

test("Codex reports a missing CLI, authentication error, timeout, and schema mismatch", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  writeFiles(repo, { "README.md": "demo\n" });
  await initRepoWithCommit(repo);
  const executable = fakeExecutable(root);
  const role = requireRole(loadRoles(), "reviewer");
  const req = { role, cwd: repo, lane: "none" as const, prompt: "" };
  const missing = await new CodexAgentRunner(5_000, join(root, "missing")).run(req);
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /not found on PATH/);
  const runner = new CodexAgentRunner(5_000, executable);
  const auth = await runner.run({ ...req, prompt: "FAKE_AUTH" });
  assert.equal(auth.ok, false);
  assert.match(auth.error!, /Unauthorized.*codex login/);
  const invalid = await runner.run({ ...req, prompt: "FAKE_INVALID", outputSchema: REVIEW_SCHEMA });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error!, /did not match the requested schema/);
  const timeout = await new CodexAgentRunner(150, executable).run({ ...req, prompt: "FAKE_HANG" });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error!, /timed out after 150 ms/);
});

test("interrupting Codex stops its active process and keeps its session ID for same-provider steering", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  writeFiles(repo, { "README.md": "demo\n" });
  await initRepoWithCommit(repo);
  const controller = new AbortController();
  const result = await new CodexAgentRunner(5_000, fakeExecutable(root)).run({
    cwd: repo,
    role: requireRole(loadRoles(), "backend"),
    lane: "any",
    prompt: "FAKE_HANG",
    signal: controller.signal,
    onEvent: () => controller.abort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, "thread-abc");
  assert.match(result.error!, /aborted/i);
});

test("the CLI routes Codex through the demo pipeline and displays persisted provider and token usage", async (t) => {
  const root = fixture(t);
  const repo = join(root, "demo");
  cpSync(join(SHIPYARD_ROOT, "examples", "demo-shop"), repo, { recursive: true });
  await initRepoWithCommit(repo);
  fakeExecutable(root);
  symlinkSync(join(SHIPYARD_ROOT, "plugins"), join(root, "plugins"), "dir");
  writeFiles(root, {
    "shipyard.config.yaml": `
model: claude-test
codex:
  models: [codex-test]
worktreeRoot: worktrees
runsDir: runs
targets:
  demo:
    path: demo
    test: npm test
    e2e: npm run e2e
`,
  });
  const cli = (...args: string[]) => execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: SHIPYARD_ROOT,
    env: { ...process.env, SHIPYARD_ROOT: root, PATH: `${root}:${process.env.PATH}` },
  });

  await assert.rejects(cli("ship", "demo", "FAKE_BUILD", "--model=codex-test", "--provider=claude"), /Unknown model "codex-test" for claude/);
  await assert.rejects(cli("ship", "demo", "FAKE_BUILD", "--budget=2", "--provider=codex"), /Dollar budgets are only supported for Claude/);
  const { stdout } = await cli("ship", "demo", "FAKE_BUILD", "--model=codex-test", "--effort=xhigh", "--provider=codex", "--crew=review,e2e");
  assert.match(stdout, /✓ passed.*366 input \/ 102 output tokens/);

  const store = new RunStore(join(root, "runs"));
  const [run] = store.list();
  assert.equal(run?.provider, "codex");
  assert.equal(run?.totals.costUsd, null);
  assert.equal(run?.model, "codex-test");
  assert.deepEqual(run?.stages.map((stage) => stage.name), ["implement", "review", "e2e"]);
  assert.deepEqual(run?.stages[2]?.attempts[0]?.revertedFiles, ["built.txt"]);
  assert.equal(await git(["status", "--porcelain"], repo), "");
  assert.equal(await git(["show", `${run!.branch}:built.txt`], repo), "made by Codex");
  assert.match((await cli("runs")).stdout, /codex.*cost unavailable.*366 input/);
  assert.match((await cli("targets")).stdout, /demo\t.*demo/);

  const file = join(store.dir(run!.id), "run.json");
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.provider;
  writeFileSync(file, JSON.stringify(legacy));
  assert.equal(store.get(run!.id)?.provider, "claude");
});

test("provider config defaults and Codex eval formatting", () => {
  const config = parseConfig({}, "/");
  assert.equal(config.defaultProvider, "claude");
  assert.equal(config.codex?.model, undefined);
  assert.equal(config.codex?.effort, undefined);
  assert.equal(config.codex?.timeoutMsPerAttempt, CODEX_TIMEOUT_MS);
  assert.equal(parseConfig({ defaultProvider: "codex" }, "/").defaultProvider, "codex");
  assert.throws(() => parseConfig({ defaultProvider: "unknown" }, "/"), /Provider must be/);
  assert.throws(() => parseConfig({ codex: { effort: "invalid" } }, "/"), /codex.effort/);
  assert.throws(() => parseConfig({ codex: { timeoutMsPerAttempt: 0 } }, "/"), /timeoutMsPerAttempt/);
  const report = formatReport({
    provider: "codex", startedAt: "", model: "Codex CLI default",
    results: [{ id: "test", kind: "feature", pipeline: "passed", solved: true, attempts: 1, durationMs: 100, costUsd: null,
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 1 } }],
  });
  assert.match(report, /tokens 12 in \/ 3 out · dollar cost unavailable.*provider codex/);
});
