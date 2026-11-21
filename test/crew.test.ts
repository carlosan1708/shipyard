import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/exec.ts";
import { checkToolUse, inLane } from "../src/guards.ts";
import { runPipeline, type PipelineDeps } from "../src/pipeline.ts";
import { loadRoles } from "../src/roles.ts";
import { RunControl } from "../src/run-control.ts";
import { RunStore } from "../src/store.ts";
import type { Target } from "../src/config.ts";
import { FakeRunner, makeTargetRepo, tempDir, UNIT_TEST, writeFiles, type Step } from "./helpers.ts";

async function setup(steps: Step[], target?: Partial<Target>) {
  const repo = await makeTargetRepo();
  const runner = new FakeRunner(steps);
  const deps: PipelineDeps = {
    config: { model: "m", maxGateRetries: 1, worktreeRoot: tempDir("sy-wt-") },
    runner,
    store: new RunStore(tempDir("sy-runs-")),
    roles: loadRoles(),
  };
  return { runner, deps, target: { name: "tiny", path: repo, test: "npm test", e2e: "npm run e2e", ...target } as Target };
}

const PLAN = "Goal: make add() add.\nApproach: change the operator.\nFiles: src/add.js\nTasks:\n1. Write a failing test\n2. Fix the operator\nTests: add(2, 3) === 5";
const fix: Step = (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => Number(a) + Number(b);\n", "test/add.test.js": UNIT_TEST });
const e2e: Step = (req) =>
  writeFiles(req.cwd, { "e2e/add.e2e.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("e2e", () => assert.equal(add(2, 2), 4));\n' });
const approve = { verdict: "approve", summary: "Small, correct change.", findings: [{ severity: "nit", file: "src/add.js", line: 1, issue: "Number() twice reads a bit noisy." }] };

test("the full crew: plan, implement, review, e2e, docs and release, each committed where it changes something", async () => {
  const { runner, deps, target } = await setup([
    (req) => {
      writeFiles(req.cwd, { "stray.txt": "a planner should not write files\n" }); // via the shell, say
      return { summary: PLAN };
    },
    fix,
    () => ({ structured: approve, summary: "" }),
    e2e,
    (req) => writeFiles(req.cwd, { "README.md": "# tiny\n\n`add(a, b)` adds numbers, also numeric strings.\n" }),
    (req) => {
      const pkg = JSON.parse(readFileSync(join(req.cwd, "package.json"), "utf8"));
      writeFiles(req.cwd, { "package.json": JSON.stringify({ ...pkg, version: "0.2.0" }), "CHANGELOG.md": "## 0.2.0\n- add() adds\n" });
      return { summary: "Release notes: add() now adds." };
    },
  ]);

  const run = await runPipeline({ target, kind: "bug", request: "add() subtracts", crew: ["plan", "review", "e2e", "repair", "docs", "release"] }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((s) => [s.name, s.role, s.status]), [
    ["plan", "planner", "passed"],
    ["implement", "backend", "passed"],
    ["review", "reviewer", "passed"],
    ["e2e", "e2e-tester", "passed"],
    ["docs", "docs-writer", "passed"],
    ["release", "release-manager", "passed"],
  ]);
  // The plan reaches the implementer, the reviewer and nothing is lost on the way.
  assert.match(runner.calls[1]!.prompt, /<plan>\nGoal: make add\(\) add\./);
  assert.match(runner.calls[2]!.prompt, /git diff [0-9a-f]{12}\.\.HEAD/);
  assert.equal(runner.calls[2]!.resumeSessionId, undefined, "the reviewer starts fresh");
  assert.ok(runner.calls[2]!.outputSchema, "the reviewer is asked for a structured verdict");
  // The planner is read-only: its stray file is gone and was never committed.
  assert.deepEqual(run.stages[0]!.attempts[0]!.revertedFiles, ["stray.txt"]);
  assert.equal(existsSync(join(run.worktree, "stray.txt")), false);
  // The review verdict is kept as data and shown as text.
  assert.deepEqual((run.stages[2]!.attempts[0]!.output as { verdict: string }).verdict, "approve");
  assert.match(run.stages[2]!.attempts[0]!.summary, /\[nit\] src\/add\.js:1: Number\(\) twice/);
  // Only stages that changed something have a commit.
  const log = await git(["log", "--format=%s", `${run.baseSha}..${run.branch}`], run.repo);
  assert.deepEqual(log.split("\n").map((s) => s.split(":")[0]), ["shipyard(release)", "shipyard(docs)", "shipyard(e2e)", "shipyard(implement)"]);
  assert.equal(JSON.parse(await git(["show", `${run.branch}:package.json`], run.repo)).version, "0.2.0");
});

test("a review that requests changes sends the findings back to the implementer's own session", async () => {
  const { runner, deps, target } = await setup([
    (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => a + b;\n", "test/add.test.js": UNIT_TEST }),
    () => ({
      structured: {
        verdict: "request_changes",
        summary: "Works for numbers only.",
        findings: [{ severity: "major", file: "src/add.js", line: 1, issue: "Numeric strings from the API get concatenated.", suggestion: "Coerce with Number()." }],
      },
    }),
    fix,
  ]);

  const run = await runPipeline({ target, kind: "feature", request: "add() handles API input", crew: ["review"] }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((s) => [s.name, s.status]), [
    ["implement", "passed"],
    ["review", "failed"],
    ["revise", "passed"],
  ]);
  const revise = runner.calls[2]!;
  assert.equal(revise.role.name, "backend");
  assert.equal(revise.resumeSessionId, "session-backend");
  assert.match(revise.prompt, /\[major\] src\/add\.js:1: Numeric strings from the API get concatenated\.\n {2}→ Coerce with Number\(\)\./);
  assert.match(await git(["log", "-1", "--format=%s", run.branch], run.repo), /^shipyard\(revise\)/);
});

test("the UI/UX stage polishes the implemented work before review and preserves E2E tests", async () => {
  const { runner, deps, target } = await setup([
    fix,
    (req) => {
      assert.equal(req.role.name, "ui-ux");
      assert.equal(req.resumeSessionId, undefined);
      assert.match(req.prompt, /Polish the interface/);
      assert.match(readFileSync(join(req.cwd, "src/add.js"), "utf8"), /Number\(a\)/);
      writeFiles(req.cwd, { "styles.css": "body { color: navy; }\n", "e2e/stray.e2e.test.js": "// outside the lane" });
    },
    () => ({ structured: approve }),
  ]);
  const run = await runPipeline({ target, kind: "feature", request: "Polish the interface", crew: ["design", "review"] }, deps);
  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((stage) => stage.name), ["implement", "design", "review"]);
  assert.equal(run.stages[1]!.attempts[0]!.gates[0]!.code, 0);
  assert.deepEqual(run.stages[1]!.attempts[0]!.revertedFiles, ["e2e/stray.e2e.test.js"]);
  assert.ok(run.stages[1]!.commit);
  assert.equal(runner.calls.length, 3);
});

test("resuming a revision replays its assignments without re-running the orchestrator or completed specialists", async () => {
  const control = new RunControl();
  const { deps, target } = await setup([
    () => ({ structured: { assignments: [
      { role: "backend", task: "Fix addition" },
      { role: "ui-ux", task: "Improve the colors" },
    ] } }),
    fix,
    () => { control.stop(); },
  ], { e2e: undefined });
  const baseSha = await git(["rev-parse", "HEAD"], target.path);
  const req = {
    target, kind: "feature" as const, request: "Fix and restyle", crew: [],
    followUp: { runId: "source", brief: "Make a tiny app", baseSha, orchestrated: true as const },
  };
  const stopped = await runPipeline(req, { ...deps, control });
  assert.equal(stopped.status, "stopped");
  const backendCommit = stopped.stages[1]?.commit;
  assert.ok(backendCommit);
  const runner = new FakeRunner([(req) => {
    assert.equal(req.role.name, "ui-ux");
    assert.match(req.prompt, /Improve the colors/);
    writeFiles(req.cwd, { "styles.css": "body { color: navy; }\n" });
  }]);
  const revised = await runPipeline({ ...req, resume: stopped }, { ...deps, runner });
  assert.equal(revised.status, "passed");
  assert.equal(revised.stages[1]?.commit, backendCommit);
  assert.equal(runner.calls.length, 1);
  assert.ok(revised.stages[2]?.commit);
});

test("the implementer may disagree with a finding: no change, an explanation, and the tests still gate it", async () => {
  const { deps, target } = await setup([
    fix,
    () => ({ structured: { verdict: "request_changes", summary: "x", findings: [{ severity: "major", issue: "Rename add() to sum()." }] } }),
    () => ({ summary: "I kept add(): it's the public API name used by callers; renaming would break them." }),
  ]);
  const run = await runPipeline({ target, kind: "feature", request: "x", crew: ["review"] }, deps);
  assert.equal(run.status, "passed");
  const revise = run.stages[2]!;
  assert.equal(revise.status, "passed");
  assert.equal(revise.commit, undefined);
  assert.match(revise.attempts[0]!.summary, /kept add\(\)/);
  assert.equal(revise.attempts[0]!.gates[0]!.code, 0, "the tests still ran");
});

test("minor findings alone don't send the change back", async () => {
  const { runner, deps, target } = await setup([fix, () => ({ structured: approve })]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["review"] }, deps);
  assert.equal(run.status, "passed");
  assert.equal(runner.calls.length, 2);
});

test("a reviewer without a verdict fails the run instead of guessing", async () => {
  const { deps, target } = await setup([fix, () => ({ summary: "I think it's fine?" })]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["review"] }, deps);
  assert.equal(run.status, "failed");
  assert.equal(run.stages.at(-1)!.name, "review");
});

test("a planner that doesn't produce a plan is asked again", async () => {
  const { runner, deps, target } = await setup([() => ({ summary: "Looked around." }), () => ({ summary: PLAN }), fix]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["plan"] }, deps);
  assert.equal(run.status, "passed");
  assert.equal(run.stages[0]!.attempts.length, 2);
  assert.match(runner.calls[1]!.prompt, /didn't contain a plan/);
});

test("docs may change nothing, but may only change docs", async () => {
  const { deps, target } = await setup([
    fix,
    (req) => {
      writeFiles(req.cwd, { "src/add.js": "// docs writer was here\n", "docs/usage.md": "# Usage\n" });
      return { summary: "Documented usage." };
    },
  ]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["docs"] }, deps);
  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages[1]!.attempts[0]!.revertedFiles, ["src/add.js"]);
  assert.equal(await git(["show", "--name-only", "--format=", run.stages[1]!.commit!], run.repo), "docs/usage.md");

  const quiet = await setup([fix, () => ({ summary: "Nothing user-facing changed." })]);
  const run2 = await runPipeline({ target: quiet.target, kind: "bug", request: "x", crew: ["docs"] }, quiet.deps);
  assert.equal(run2.status, "passed");
  assert.equal(run2.stages[1]!.commit, undefined);
});

test("the frontend implementer builds, revises and repairs", async () => {
  const { runner, deps, target } = await setup([
    (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => a + b;\n", "test/add.test.js": UNIT_TEST }),
    (req) => writeFiles(req.cwd, { "e2e/add.e2e.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("e2e", () => assert.equal(add("2", "3"), 5));\n' }),
    fix,
  ]);
  const run = await runPipeline({ target, kind: "feature", request: "x", implementer: "frontend" }, deps);
  assert.equal(run.status, "passed");
  assert.equal(run.implementer, "frontend");
  assert.deepEqual(runner.calls.map((c) => c.role.name), ["frontend", "e2e-tester", "frontend"]);
  assert.equal(runner.calls[2]!.resumeSessionId, "session-frontend");
});

test("a runner that throws closes the stage as failed instead of leaving it running", async () => {
  const { deps, target } = await setup([
    fix,
    () => {
      throw new Error("ENOENT: no such file or directory");
    },
  ]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["docs"] }, deps);
  assert.equal(run.status, "error");
  assert.match(run.error!, /docs-writer agent could not run: ENOENT/);
  assert.deepEqual(run.stages.map((s) => [s.name, s.status]), [
    ["implement", "passed"],
    ["docs", "failed"],
  ]);
});

// ── bug-triager ──────────────────────────────────────────

const reproTest = (req: Parameters<Step>[0]) =>
  writeFiles(req.cwd, { "test/repro.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("add(2, 3) is 5", () => assert.equal(add(2, 3), 5));\n' });
const triageReport = (reproduced = true) => ({
  structured: {
    reproduced,
    reproduction_test: "test/repro.test.js",
    steps: "call add(2, 3)",
    expected: "5",
    actual: "-1",
    suspected_cause: "subtraction instead of addition",
    suspected_files: ["src/add.js"],
  },
});

test("triage proves the bug with a failing test first; the implementer must make it pass", async () => {
  const { runner, deps, target } = await setup([
    (req) => {
      reproTest(req);
      return triageReport();
    },
    (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => a + b;\n" }),
  ]);

  const run = await runPipeline({ target, kind: "bug", request: "the calculator is wrong", crew: ["triage"] }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((s) => [s.name, s.role, s.status]), [
    ["triage", "bug-triager", "passed"],
    ["implement", "backend", "passed"],
  ]);
  const gate = run.stages[0]!.attempts[0]!.gates[0]!;
  assert.equal(gate.expectFailure, true);
  assert.notEqual(gate.code, 0, "the tests failed on the current code: the bug is real");
  // The reproduction is committed on its own, and the implementer is told to make it pass.
  assert.equal(await git(["show", "--name-only", "--format=", run.stages[0]!.commit!], run.repo), "test/repro.test.js");
  assert.match(runner.calls[1]!.prompt, /reproduced this bug with a failing test in test\/repro\.test\.js/);
  assert.match(runner.calls[1]!.prompt, /<triage>\nReproduced by test\/repro\.test\.js\./);
  assert.equal(runner.calls[0]!.lane, "tests", "the triager may only write tests");
});

test("a triage test that passes on the current code doesn't count as a reproduction", async () => {
  const { runner, deps, target } = await setup([
    (req) => {
      writeFiles(req.cwd, { "test/repro.test.js": 'import { test } from "node:test";\ntest("nothing", () => {});\n' });
      return triageReport();
    },
    (req) => {
      reproTest(req);
      return triageReport();
    },
    (req) => writeFiles(req.cwd, { "src/add.js": "export const add = (a, b) => a + b;\n" }),
  ]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["triage"] }, deps);
  assert.equal(run.status, "passed");
  assert.equal(run.stages[0]!.attempts.length, 2);
  assert.match(runner.calls[1]!.prompt, /passes on the current code, so your test doesn't reproduce the bug/);
});

test("a bug the triager can't reproduce stops the run before any fix", async () => {
  const { runner, deps, target } = await setup([
    (req) => {
      reproTest(req);
      return triageReport(false);
    },
    (req) => {
      reproTest(req);
      return triageReport(false);
    },
  ]);
  const run = await runPipeline({ target, kind: "bug", request: "x", crew: ["triage"] }, deps);
  assert.equal(run.status, "failed");
  assert.equal(runner.calls.length, 2, "nobody tried to fix an unproven bug");
});

test("triage only applies to bug runs", async () => {
  const { runner, deps, target } = await setup([fix]);
  const run = await runPipeline({ target, kind: "feature", request: "x", crew: ["triage"] }, deps);
  assert.equal(run.status, "passed");
  assert.deepEqual(run.crew, []);
  assert.equal(runner.calls[0]!.role.name, "backend");
});

// ── security-auditor ─────────────────────────────────────

test("critical or high security findings go back to the implementer as a harden step", async () => {
  const { runner, deps, target } = await setup([
    fix,
    () => ({
      structured: {
        verdict: "fix_required",
        summary: "One injection risk.",
        findings: [
          { severity: "high", category: "injection", file: "src/add.js", line: 1, issue: "Input is passed to eval().", fix: "Parse numbers instead." },
          { severity: "low", category: "unsafe-default", issue: "No input length limit." },
        ],
      },
    }),
    (req) => writeFiles(req.cwd, { "src/add.js": "// hardened\nexport const add = (a, b) => Number(a) + Number(b);\n" }),
  ]);

  const run = await runPipeline({ target, kind: "feature", request: "x", crew: ["security"] }, deps);

  assert.equal(run.status, "passed");
  assert.deepEqual(run.stages.map((s) => [s.name, s.status]), [
    ["implement", "passed"],
    ["security", "failed"],
    ["harden", "passed"],
  ]);
  assert.equal(runner.calls[1]!.role.name, "security-auditor");
  assert.equal(runner.calls[1]!.lane, "none");
  assert.equal(runner.calls[2]!.resumeSessionId, "session-backend");
  assert.match(runner.calls[2]!.prompt, /\[high · injection\] src\/add\.js:1: Input is passed to eval\(\)\.\n {2}→ Parse numbers instead\./);
  assert.match(await git(["log", "-1", "--format=%s", run.branch], run.repo), /^shipyard\(harden\)/);
});

test("medium and low security findings alone pass", async () => {
  const { runner, deps, target } = await setup([
    fix,
    () => ({ structured: { verdict: "pass", summary: "Fine.", findings: [{ severity: "medium", category: "input-validation", issue: "No limit." }] } }),
  ]);
  const run = await runPipeline({ target, kind: "feature", request: "x", crew: ["security"] }, deps);
  assert.equal(run.status, "passed");
  assert.equal(runner.calls.length, 2);
});

// ── dependency-updater ───────────────────────────────────

test("a deps run is implemented by the dependency-updater, may change nothing, and skips plan and triage", async () => {
  const { runner, deps, target } = await setup([() => ({ summary: "Everything is already current." })]);
  const run = await runPipeline({ target, kind: "deps", request: "update dependencies", crew: ["triage", "plan"], implementer: "frontend" }, deps);
  assert.equal(run.status, "passed");
  assert.equal(run.implementer, "dependency-updater");
  assert.deepEqual(run.crew, []);
  assert.equal(runner.calls[0]!.role.name, "dependency-updater");
  assert.match(runner.calls[0]!.prompt, /Dependency update request:/);
  assert.equal(run.stages[0]!.commit, undefined, "nothing to commit when everything is current");
});

test("a deps run with upgrades is checked by the rest of the crew", async () => {
  const { runner, deps, target } = await setup([
    (req) => {
      const pkg = JSON.parse(readFileSync(join(req.cwd, "package.json"), "utf8"));
      writeFiles(req.cwd, { "package.json": JSON.stringify({ ...pkg, dependencies: { leftpad: "^1.1.0" } }) });
      return { summary: "leftpad 1.0.0 -> 1.1.0 (routine)" };
    },
    () => ({ structured: { verdict: "pass", summary: "No known vulnerabilities.", findings: [] } }),
    // The tiny repo's add() is deliberately broken; this run is about dependencies, so check something else.
    (req) => writeFiles(req.cwd, { "e2e/smoke2.e2e.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.js";\ntest("loads", () => assert.equal(typeof add, "function"));\n' }),
  ]);
  const run = await runPipeline({ target, kind: "deps", request: "update dependencies", crew: ["security", "e2e"] }, deps);
  assert.equal(run.status, "passed");
  assert.deepEqual(runner.calls.map((c) => c.role.name), ["dependency-updater", "security-auditor", "e2e-tester"]);
  assert.match(runner.calls[2]!.prompt, /main paths still work after the upgrades/);
});

test("lanes for the new roles", () => {
  assert.equal(inLane("src/app.js", "none"), false);
  for (const ok of ["README.md", "docs/api/endpoints.md", "CHANGELOG", "guide.mdx"]) assert.equal(inLane(ok, "docs"), true, ok);
  for (const no of ["src/app.js", "package.json", "test/a.test.js"]) assert.equal(inLane(no, "docs"), false, no);
  for (const ok of ["package.json", "packages/web/package.json", "pnpm-lock.yaml", "pyproject.toml", "Cargo.toml", "CHANGELOG.md", "RELEASE_NOTES.md"]) {
    assert.equal(inLane(ok, "release"), true, ok);
  }
  for (const no of ["src/version.ts", "README.md", "docs/x.md"]) assert.equal(inLane(no, "release"), false, no);
  const verdict = checkToolUse("Write", { file_path: "/w/src/a.js" }, { root: "/w", lane: "none" });
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /read-only/);
});
