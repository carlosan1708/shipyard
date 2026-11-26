import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkCommand, checkToolUse } from "../src/guards.ts";
import { SHIPYARD_ROOT } from "../src/config.ts";
import { sh } from "../src/exec.ts";
import { tempDir, writeFiles } from "./helpers.ts";

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

test("deployment and cloud resource commands require a dedicated approval", () => {
  for (const command of [
    "npm run deploy -- --non-interactive",
    "pnpm run deploy:production",
    "firebase hosting:sites:create portfolio --project example",
    "gcloud projects create example",
    "aws cloudformation deploy --stack-name example",
    "az webapp deploy --name example",
    "azd up",
    "terraform apply -auto-approve",
    "gh workflow run deploy.yml",
    "gh api repos/octo/example/actions/workflows/deploy.yml/dispatches -f ref=main",
  ]) {
    assert.equal(checkCommand(command, { SHIPYARD_ALLOW_PUBLISH: "1" }).blocked, true, command);
    assert.equal(checkToolUse("Bash", { command }, { root: "/w", lane: "any" }).allowed, false, command);
  }
});

test("project checks block explicit deploys and prevent nested programs from reaching external addresses", async () => {
  await assert.rejects(sh("npm run deploy", SHIPYARD_ROOT), /needs human approval/);
  const program = `
const net = require('node:net');
const server = net.createServer(socket => socket.end('local'));
server.listen(0, '127.0.0.1', () => {
  const local = net.connect(server.address().port, '127.0.0.1');
  local.on('data', value => console.log(value.toString()));
  local.on('close', () => server.close());
});
const external = net.connect(443, '192.0.2.1');
external.on('connect', () => process.exit(1));
external.on('error', error => {
  if (!['EPERM', 'EACCES', 'ENETUNREACH'].includes(error.code)) process.exitCode = 1;
  console.log('external blocked');
});`;
  const workspace = tempDir();
  writeFiles(workspace, { "check.cjs": `
const { spawnSync } = require("node:child_process");
const child = spawnSync(process.execPath, ["-e", ${JSON.stringify(program)}], { stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
` });
  const result = await sh("node check.cjs", workspace, 10_000);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /local/);
  assert.match(result.output, /external blocked/);
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
