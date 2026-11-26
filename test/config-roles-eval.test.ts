import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig } from "../src/config.ts";
import { applyEdits, formatReport, loadTasks } from "../src/eval.ts";
import { loadRoles, parseRole } from "../src/roles.ts";
import { tempDir, writeFiles } from "./helpers.ts";

test("config resolves relative and home paths and applies defaults", () => {
  const base = resolve("/base");
  const config = parseConfig({ targets: { a: { path: "./repo", test: "npm test" }, b: { path: "~/code/b", test: "make test", e2e: "make e2e" } } }, base);
  assert.equal(config.targets.a!.path, join(base, "repo"));
  assert.equal(config.targets.a!.e2e, undefined);
  assert.equal(config.targets.b!.path, join(homedir(), "code/b"));
  assert.equal(config.model, "claude-opus-5-5");
  assert.equal(config.auth, "subscription", "runs default to the Claude subscription, not API billing");
  assert.deepEqual(config.models, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.deepEqual(parseConfig({ model: "claude-fable-5-2", models: ["claude-haiku-5-5"] }, "/").models, ["claude-fable-5-2", "claude-haiku-5-5"], "the default model is always offered, first");
  assert.equal(config.maxGateRetries, 2);
  assert.equal(config.maxBudgetUsdPerStage, 3);
  assert.equal(config.maxBudgetUsdPerRun, 10);
});

test("config rejects bad values", () => {
  assert.throws(() => parseConfig({ effort: "extreme" }, "/"), /effort/);
  assert.throws(() => parseConfig({ auth: "oauth" }, "/"), /auth/);
  assert.throws(() => parseConfig({ targets: { a: { path: "x" } } }, "/"), /test is required/);
  assert.throws(() => parseConfig({ maxGateRetries: -1 }, "/"), /maxGateRetries/);
  assert.throws(() => parseConfig({ maxBudgetUsdPerRun: "ten" }, "/"), /maxBudgetUsdPerRun/);
});

test("the shipped roles load from the plugin's agent files", () => {
  const roles = loadRoles();
  assert.deepEqual([...roles.keys()].sort(), ["backend", "bug-triager", "chat-advisor", "dependency-updater", "docs-writer", "e2e-tester", "frontend", "google-cloud-releaser", "local-app", "orchestrator", "planner", "release-manager", "reviewer", "security-auditor", "ui-ux"]);
  assert.deepEqual(roles.get("chat-advisor")?.tools, []);
  // Read-only roles get no editing tools at all; the lane and post-stage revert back that up.
  for (const name of ["local-app", "orchestrator", "planner", "reviewer", "security-auditor"]) assert.ok(!roles.get(name)!.tools.some((t) => ["Edit", "Write"].includes(t)), name);
  const backend = roles.get("backend")!;
  assert.ok(backend.tools.includes("Bash"));
  assert.equal(backend.model, undefined, "model: inherit means use the configured model");
  assert.match(backend.prompt, /reproduces the reported behaviour and watch it fail/);
});

test("roles need frontmatter, a name and explicit tools", () => {
  assert.throws(() => parseRole("no frontmatter"), /frontmatter/);
  assert.throws(() => parseRole("---\nname: x\ndescription: y\n---\nbody"), /tools/);
  const role = parseRole("---\nname: x\ndescription: y\ntools: [Read, Grep]\nmodel: sonnet\n---\nDo it.");
  assert.deepEqual(role.tools, ["Read", "Grep"]);
  assert.equal(role.model, "sonnet");
});

test("eval edits must match exactly once", () => {
  const dir = tempDir();
  writeFiles(dir, { "a.js": "x = 1;\nx = 1;\n" });
  assert.throws(() => applyEdits(dir, [{ file: "a.js", find: "x = 1;", replace: "x = 2;" }]), /exactly once, found 2/);
  assert.throws(() => applyEdits(dir, [{ file: "a.js", find: "y", replace: "z" }]), /found 0/);
});

test("every shipped eval task is well formed", () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 7);
  for (const t of tasks) {
    assert.ok(t.kind === "bug" ? t.seed?.length : t.reference?.length, t.id);
    assert.ok(!/src\/|\.js\b/.test(t.request), `${t.id}: the request should describe symptoms, not point at files`);
  }
});

test("the eval report shows solve rate and cost per solved task", () => {
  const text = formatReport({
    startedAt: "x",
    model: "m",
    results: [
      { id: "a", kind: "bug", pipeline: "passed", solved: true, costUsd: 0.5, durationMs: 60_000, attempts: 2 },
      { id: "b", kind: "feature", pipeline: "failed", solved: false, costUsd: 1.5, durationMs: 120_000, attempts: 4 },
    ],
  });
  assert.match(text, /solved 1\/2 \(50%\) · est. total \$2\.00 · est. \$2\.00 per solved task/);
});
