import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/exec.ts";
import { runPipeline, makeRunId, type PipelineDeps } from "../src/pipeline.ts";
import { loadRoles } from "../src/roles.ts";
import { RunStore } from "../src/store.ts";
import type { Target } from "../src/config.ts";
import { FakeRunner, makeTargetRepo, tempDir, UNIT_TEST, writeFiles, type Step } from "./helpers.ts";

async function setup(steps: Step[]) {
  const repo = await makeTargetRepo();
  const runner = new FakeRunner(steps);
  const deps: PipelineDeps = {
    config: { model: "test-model", maxGateRetries: 1, worktreeRoot: tempDir("af-wt-") },
    runner,
    store: new RunStore(tempDir("af-runs-")),
    roles: loadRoles(),
  };
  const target: Target = { name: "tiny", path: repo, test: "npm test", e2e: "npm run e2e" };
  return { repo, runner, deps, target };
}

const fixAdd: Step = (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => Number(a) + Number(b);\n" });
const writeUnitTest: Step = (req) => writeFiles(req.cwd, { "test/add.test.js": UNIT_TEST });
const writeE2E = (body: string): Step => (req) =>
  writeFiles(req.cwd, {
    "e2e/add.e2e.test.js": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("e2e", () => { ${body} });\n`,
  });

test("a failed gate goes back to the same session, then the run passes and commits per stage", async () => {
  const { runner, deps, target } = await setup([
    writeUnitTest, // backend attempt 1: reproduces the bug, but does not fix it -> gate fails
    fixAdd, // backend attempt 2: fixes it
    writeE2E("assert.equal(add(1, 1), 2);"), // e2e tester
  ]);

  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts instead of adding" }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((s) => [s.name, s.status, s.attempts.length]), [
    ["implement", "passed", 2],
    ["e2e", "passed", 1],
  ]);
  assert.equal(run.stages[0]!.attempts[0]!.gates[0]!.code !== 0, true, "first gate should fail");

  // Retry resumes the backend's own session, with the gate output in the prompt.
  assert.equal(runner.calls[1]!.resumeSessionId, "session-backend");
  assert.match(runner.calls[1]!.prompt, /gate failed/);
  assert.equal(runner.calls[2]!.role.name, "e2e-tester");
  assert.equal(runner.calls[2]!.lane, "tests");

  const log = await git(["log", "--format=%s", `${run.baseSha}..${run.branch}`], run.repo);
  assert.deepEqual(log.split("\n"), [
    "shipyard(e2e): add() subtracts instead of adding",
    "shipyard(implement): add() subtracts instead of adding",
  ]);
  assert.equal(run.totals.attempts, 3);
  assert.ok(Math.abs(run.totals.costUsd - 0.3) < 1e-9);
  assert.equal(deps.store.get(run.id)?.status, "passed");
});

test("an E2E failure is sent back to the implementer, and out-of-lane edits by the tester are reverted", async () => {
  const { runner, deps, target } = await setup([
    // backend: correct for numbers only
    (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => a + b;\n", "test/add.test.js": UNIT_TEST }),
    // tester: finds that string input from the API breaks it, and also (wrongly) edits source via the shell
    (req) => {
      writeE2E('assert.equal(add("2", "3"), 5);')(req);
      writeFiles(req.cwd, { "src/add.js": "// tester was here\nexport const add = () => 5;\n" });
    },
    // backend repair, in its original session
    fixAdd,
  ]);

  const run = await runPipeline({ target, kind: "feature", request: "add() must accept numeric strings" }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((s) => [s.name, s.status]), [
    ["implement", "passed"],
    ["e2e", "failed"],
    ["repair", "passed"],
  ]);
  assert.deepEqual(run.stages[1]!.attempts[0]!.revertedFiles, ["src/add.js"]);

  const repairCall = runner.calls[2]!;
  assert.equal(repairCall.role.name, "backend");
  assert.equal(repairCall.lane, "no-e2e");
  assert.equal(repairCall.resumeSessionId, "session-backend");
  assert.match(repairCall.prompt, /E2E gate fails/);

  // The tester's commit contains only its test, not the reverted source edit.
  const e2eCommit = run.stages[1]!.commit!;
  const files = await git(["show", "--name-only", "--format=", e2eCommit], run.repo);
  assert.equal(files, "e2e/add.e2e.test.js");
});

test("the run fails after the retry budget, and later stages never start", async () => {
  const { runner, deps, target } = await setup([writeUnitTest, () => {}]);

  const run = await runPipeline({ target, kind: "bug", request: "add() is broken" }, deps);

  assert.equal(run.status, "failed");
  assert.equal(run.stages.length, 1);
  assert.equal(run.stages[0]!.attempts.length, 2); // 1 + maxGateRetries
  assert.equal(runner.calls.length, 2);
  // Nothing was committed on the branch.
  assert.equal(await git(["rev-list", "--count", `${run.baseSha}..${run.branch}`], run.repo), "0");
});

// Regression: a real run with an expired sign-in got a session id and one turn, then the
// existing tests passed on the untouched code and the run was reported as "passed".
test("an agent that cannot run errors the run, never passes it, and leaves no branch behind", async () => {
  const authError = "Failed to authenticate: OAuth session expired and could not be refreshed";
  const { runner, deps, target } = await setup([() => ({ ok: false, sessionId: "s-1", turns: 1, costUsd: 0, error: authError })]);

  const run = await runPipeline({ target, kind: "feature", request: "add a health endpoint" }, deps);

  assert.equal(run.status, "error");
  assert.match(run.error!, /backend agent could not run: Failed to authenticate/);
  assert.equal(runner.calls.length, 1, "no retry and no later stages");
  assert.deepEqual(run.stages[0]!.attempts[0]!.gates, [], "gates must not grade untouched code");
  assert.equal(run.cleanedUp, true);
  assert.equal(existsSync(run.worktree), false);
  assert.equal(await git(["branch", "--list", run.branch], run.repo), "");
});

test("green tests on an unchanged tree do not count: the agent is asked again, then the stage fails", async () => {
  const { runner, deps, target } = await setup([() => {}, () => {}]);

  const run = await runPipeline({ target, kind: "feature", request: "add a health endpoint" }, deps);

  assert.equal(run.status, "failed");
  const attempts = run.stages[0]!.attempts;
  assert.deepEqual(attempts.map((a) => [a.noChanges, a.gates.length, a.passed]), [
    [true, 0, false],
    [true, 0, false],
  ]);
  assert.match(runner.calls[1]!.prompt, /without changing any files/);
});

test("an agent stopped by its turn cap is still graded on the work it did", async () => {
  const { deps, target } = await setup([
    (req) => {
      writeUnitTest(req);
      fixAdd(req);
      return { ok: false, error: "error_max_turns" };
    },
    writeE2E("assert.equal(add(2, 2), 4);"),
  ]);

  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts" }, deps);

  assert.equal(run.status, "passed");
  assert.equal(run.stages[0]!.attempts[0]!.agentOk, false);
  assert.equal(run.stages[0]!.attempts[0]!.passed, true);
});

test("the target repo's own checkout is never touched", async () => {
  const { repo, deps, target } = await setup([writeUnitTest, fixAdd, writeE2E("assert.ok(true);")]);
  await runPipeline({ target, kind: "bug", request: "add() subtracts" }, deps);
  assert.equal(await git(["status", "--porcelain"], repo), "");
  assert.equal(existsSync(join(repo, "test", "add.test.js")), false);
});

test("run ids are sortable and readable", () => {
  const id = makeRunId("Fix the WELCOME10 coupon!! please", new Date("2026-11-20T15:30:12Z"));
  assert.match(id, /^20261120-153012-fix-the-welcome10-coupon-please-[0-9a-f]{4}$/);
});
