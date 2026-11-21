import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkCommand, checkToolUse } from "../src/guards.ts";
import { SHIPYARD_ROOT } from "../src/config.ts";

test("publishing commands are blocked by default", () => {
  for (const cmd of [
    "git push origin main",
    "git -C repo push",
    "npm publish",
    "cd pkg && pnpm publish --access public",
    "gh pr create --fill",
    "gh release create v1.0.0",
    "npx vercel --prod",
    "gcloud run services update portfolio --image example",
    "gcloud builds submit --tag example",
    "gcloud run services update-traffic portfolio --to-latest",
  ]) {
    assert.equal(checkCommand(cmd, {}).blocked, true, cmd);
  }
});

test("ordinary development commands are allowed", () => {
  for (const cmd of ["npm test", "git status", "git commit -m wip", "git diff HEAD~1", "rm -rf node_modules", "gh pr view 12"]) {
    assert.equal(checkCommand(cmd, {}).blocked, false, cmd);
  }
});

test("SHIPYARD_ALLOW_PUBLISH unlocks publishing but never destructive commands", () => {
  const env = { SHIPYARD_ALLOW_PUBLISH: "1" };
  assert.equal(checkCommand("npm publish", env).blocked, false);
  assert.equal(checkCommand("git push --force origin main", env).blocked, true);
  assert.equal(checkCommand("rm -rf ~", env).blocked, true);
});

test("file writes must stay inside the worktree", () => {
  const root = "/work/tree";
  assert.equal(checkToolUse("Write", { file_path: "/work/tree/src/a.js" }, { root, lane: "any" }).allowed, true);
  assert.equal(checkToolUse("Edit", { file_path: "/work/other/a.js" }, { root, lane: "any" }).allowed, false);
  assert.equal(checkToolUse("Edit", { file_path: "../escape.js" }, { root, lane: "any" }).allowed, false);
});

test("the tests lane only allows test files", () => {
  const opts = { root: "/w", lane: "tests" as const };
  assert.equal(checkToolUse("Write", { file_path: "/w/e2e/cart.e2e.test.js" }, opts).allowed, true);
  assert.equal(checkToolUse("Write", { file_path: "/w/test/cart.test.js" }, opts).allowed, true);
  assert.equal(checkToolUse("Write", { file_path: "/w/src/__tests__/x.ts" }, opts).allowed, true);
  assert.equal(checkToolUse("Edit", { file_path: "/w/src/cart.js" }, opts).allowed, false);
  assert.equal(checkToolUse("Read", { file_path: "/w/src/cart.js" }, opts).allowed, true);
});

test("the no-e2e lane protects E2E tests from the implementer", () => {
  const opts = { root: "/w", lane: "no-e2e" as const };
  assert.equal(checkToolUse("Edit", { file_path: "/w/e2e/api.e2e.test.js" }, opts).allowed, false);
  assert.equal(checkToolUse("Edit", { file_path: "/w/src/cart.js" }, opts).allowed, true);
  assert.equal(checkToolUse("Edit", { file_path: "/w/test/cart.test.js" }, opts).allowed, true);
});

test("the pipeline ignores SHIPYARD_ALLOW_PUBLISH in the environment", () => {
  process.env.SHIPYARD_ALLOW_PUBLISH = "1";
  try {
    assert.equal(checkToolUse("Bash", { command: "npm publish" }, { root: "/w", lane: "any" }).allowed, false);
  } finally {
    delete process.env.SHIPYARD_ALLOW_PUBLISH;
  }
});

test("the plugin hook script blocks with exit code 2 and explains why", () => {
  const script = join(SHIPYARD_ROOT, "plugins", "shipyard", "hooks", "guard-publish.mjs");
  const run = (command: string) =>
    spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8", env: {} });
  const blocked = run("git push");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /needs human approval/);
  assert.equal(run("npm test").status, 0);
});
