import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { git } from "../src/exec.ts";
import { runPipeline, type CheckpointContext, type CheckpointDecision, type PipelineDeps, type StageName } from "../src/pipeline.ts";
import { LineQueue, terminalReviewer } from "../src/review.ts";
import { loadRoles } from "../src/roles.ts";
import { RunStore } from "../src/store.ts";
import type { Target } from "../src/config.ts";
import { FakeRunner, makeTargetRepo, tempDir, UNIT_TEST, writeFiles, type Step } from "./helpers.ts";

/** A scripted human: answers checkpoints in order and records what it was shown. */
function scriptedReviewer(decisions: CheckpointDecision[]) {
  const seen: CheckpointContext[] = [];
  return {
    seen,
    review: async (ctx: CheckpointContext) => {
      seen.push(ctx);
      const next = decisions.shift();
      if (!next) throw new Error(`no decision scripted for checkpoint ${seen.length} (${ctx.stage})`);
      return next;
    },
  };
}

async function setup(steps: Step[], decisions: CheckpointDecision[], stages: StageName[] = ["implement", "e2e", "repair"]) {
  const repo = await makeTargetRepo();
  const runner = new FakeRunner(steps);
  const human = scriptedReviewer(decisions);
  const deps: PipelineDeps = {
    config: { model: "test-model", maxGateRetries: 1, worktreeRoot: tempDir("sy-wt-") },
    runner,
    store: new RunStore(tempDir("sy-runs-")),
    roles: loadRoles(),
    checkpoints: { stages, review: human.review },
  };
  const target: Target = { name: "tiny", path: repo, test: "npm test", e2e: "npm run e2e" };
  return { runner, human, deps, target };
}

const fix = (body = "Number(a) + Number(b)"): Step => (req) =>
  writeFiles(req.cwd, { "src/add.js": `export const add = (a, b) => ${body};\n`, "test/add.test.js": UNIT_TEST });
const e2e = (assertion: string): Step => (req) =>
  writeFiles(req.cwd, {
    "e2e/add.e2e.test.js": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("e2e", () => { ${assertion} });\n`,
  });

test("approving every checkpoint runs the pipeline as usual", async () => {
  const { human, deps, target } = await setup([fix(), e2e("assert.equal(add(1, 2), 3);")], [{ action: "continue" }, { action: "continue" }]);

  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts" }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(human.seen.map((c) => [c.stage, c.outcome, c.canContinue]), [
    ["implement", "passed", true],
    ["e2e", "passed", true],
  ]);
  assert.equal(human.seen[0]!.sessionId, "session-backend");
  assert.equal(run.stages[0]!.attempts[0]!.review?.action, "continue");
});

test("feedback on a passing stage goes into the same session, then the gates run again", async () => {
  const { runner, deps, target } = await setup(
    [
      fix("a + b"), // passes the unit test, but the reviewer wants string inputs handled
      fix("Number(a) + Number(b)"),
      e2e('assert.equal(add("2", "3"), 5);'),
    ],
    [{ action: "feedback", message: "Inputs from the API are strings. Coerce them." }, { action: "continue" }, { action: "continue" }],
  );

  const run = await runPipeline({ target, kind: "feature", request: "add() must handle API input" }, deps);

  assert.equal(run.status, "passed");
  const impl = run.stages[0]!;
  assert.deepEqual(impl.attempts.map((a) => [a.passed, a.review?.action]), [
    [true, "feedback"],
    [true, "continue"],
  ]);
  assert.equal(runner.calls[1]!.resumeSessionId, "session-backend");
  assert.match(runner.calls[1]!.prompt, /<feedback>\nInputs from the API are strings\. Coerce them\.\n<\/feedback>/);
  // The stage commit contains the version the human approved.
  const committed = await git(["show", `${impl.commit}:src/add.js`], run.repo);
  assert.match(committed, /Number\(a\) \+ Number\(b\)/);
});

test("stopping at a checkpoint keeps the worktree and its uncommitted work, and runs nothing after", async () => {
  const { runner, deps, target } = await setup([fix()], [{ action: "stop" }]);

  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts" }, deps);

  assert.equal(run.status, "stopped");
  assert.equal(run.stages[0]!.status, "stopped");
  assert.equal(runner.calls.length, 1);
  assert.equal(run.stages[0]!.commit, undefined);
  assert.ok(existsSync(join(run.worktree, "test", "add.test.js")), "the agent's work is still there to inspect");
  assert.equal(await git(["rev-list", "--count", `${run.baseSha}..${run.branch}`], run.repo), "0");
});

test("a stage out of retries pauses for the human instead of failing, and feedback gets it unstuck", async () => {
  const { runner, human, deps, target } = await setup(
    [
      (req) => writeFiles(req.cwd, { "test/add.test.js": UNIT_TEST }), // attempt 1: test only, gate fails
      () => {}, // attempt 2 (automatic retry): still failing
      fix(), // attempt 3, after the human's hint
      e2e("assert.equal(add(2, 2), 4);"),
    ],
    [{ action: "feedback", message: "The bug is the minus sign in src/add.js." }, { action: "continue" }, { action: "continue" }],
  );

  const run = await runPipeline({ target, kind: "bug", request: "add() is wrong" }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(human.seen.map((c) => [c.stage, c.outcome, c.canContinue, c.attempt]), [
    ["implement", "failed", false, 2], // no "continue" for a failed implement: there is nothing to continue to
    ["implement", "passed", true, 3],
    ["e2e", "passed", true, 1],
  ]);
  // The retry prompt carries both the gate output the agent never saw and the human's hint.
  assert.match(runner.calls[2]!.prompt, /The pipeline gate failed[\s\S]*<feedback>\nThe bug is the minus sign/);
});

test("continuing past an E2E failure hands it to the implementer for repair", async () => {
  const { runner, human, deps, target } = await setup(
    [fix("a + b"), e2e('assert.equal(add("2", "3"), 5);'), fix("Number(a) + Number(b)")],
    [{ action: "continue" }, { action: "continue" }, { action: "continue" }],
  );

  const run = await runPipeline({ target, kind: "feature", request: "add() must accept strings" }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(human.seen.map((c) => [c.stage, c.outcome, c.canContinue]), [
    ["implement", "passed", true],
    ["e2e", "failed", true],
    ["repair", "passed", true],
  ]);
  assert.equal(runner.calls[2]!.lane, "no-e2e");
});

test("time spent waiting at checkpoints is reported apart from working time", async () => {
  const { deps, target } = await setup([fix(), e2e("assert.ok(true);")], [], ["implement"]);
  deps.checkpoints!.review = async () => {
    await new Promise((r) => setTimeout(r, 300)); // the human thinks for a moment
    return { action: "continue" };
  };
  const lines: string[] = [];
  deps.log = (l) => lines.push(l);

  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts" }, deps);

  const wait = run.stages[0]!.attempts[0]!.review!.waitMs;
  assert.ok(wait >= 290, `waitMs should cover the pause, got ${wait}`);
  assert.equal(run.totals.reviewWaitMs, wait);
  assert.match(lines.at(-1)!, /working \+ \d+s waiting for you/);
});

test("checkpoints only pause after the stages you name", async () => {
  const { human, deps, target } = await setup([fix(), e2e("assert.ok(true);")], [{ action: "continue" }], ["e2e"]);
  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts" }, deps);
  assert.equal(run.status, "passed");
  assert.deepEqual(human.seen.map((c) => c.stage), ["e2e"]);
});

test("the terminal reviewer shows the changes and reads multi-line feedback", async () => {
  const dir = join(tempDir(), "wt");
  writeFiles(dir, { "src/a.js": "export const a = 1;\n" });
  const { initRepoWithCommit } = await import("../src/worktree.ts");
  await initRepoWithCommit(dir);
  writeFiles(dir, { "src/a.js": "export const a = 2;\n", "test/a.test.js": "// new\n// test\n" });

  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (d) => (shown += d));
  const review = terminalReviewer({ input, output });
  input.write("x\nd\nf\nUse a constant.\nAnd name it well.\n\n");

  const ctx: CheckpointContext = {
    runId: "r",
    stage: "implement",
    role: "backend",
    outcome: "passed",
    canContinue: true,
    attempt: 1,
    summary: "Changed a to 2.",
    gates: [{ command: "npm test", code: 0, durationMs: 1200, timedOut: false, outputTail: "" }],
    noChanges: false,
    worktree: dir,
    sessionId: "abc",
  };
  const decision = await review(ctx);

  assert.deepEqual(decision, { action: "feedback", message: "Use a constant.\nAnd name it well." });
  assert.match(shown, /━━ checkpoint · implement passed its gates \(attempt 1\) ━━/);
  assert.match(shown, /M  src\/a\.js  \(\+1 -1\)/);
  assert.match(shown, /A  test\/a\.test\.js  \(\+2, new\)/);
  assert.match(shown, /✓ npm test \(1\.2s\)/);
  assert.match(shown, /claude --resume abc/);
  assert.match(shown, /Type one of: a, d, f, s/, "an unknown key shows the valid ones");
  assert.match(shown, /\+export const a = 2;/, "d prints the full diff");
  assert.match(shown, /\+\/\/ test/, "the diff includes untracked files");
  // Nothing was staged: the stage commit and lane reverts depend on a clean index.
  assert.equal(await git(["diff", "--cached", "--name-only"], dir), "");
  assert.equal(readFileSync(join(dir, "src/a.js"), "utf8"), "export const a = 2;\n");
});

test("when the answers run out the run stops rather than guessing", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const dir = join(tempDir(), "wt");
  writeFiles(dir, { "a.txt": "a\n" });
  const { initRepoWithCommit } = await import("../src/worktree.ts");
  await initRepoWithCommit(dir);
  input.end("");
  const decision = await terminalReviewer({ input, output })({
    runId: "r", stage: "e2e", role: "e2e-tester", outcome: "failed", canContinue: true, attempt: 1,
    summary: "", gates: [], noChanges: true, worktree: dir,
  });
  assert.deepEqual(decision, { action: "stop" });
});

test("queued lines are not lost between checkpoints", async () => {
  const input = new PassThrough();
  const queue = new LineQueue(input);
  input.write("one\ntwo\nthr");
  assert.equal(await queue.next(), "one");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await queue.next(), "two");
  input.end("ee\n");
  assert.equal(await queue.next(), "three");
  assert.equal(await queue.next(), null);
});
