import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RunStore } from "../src/store.ts";

const exec = promisify(execFile);

test("branch claims work without symlink permissions and only their owner releases them", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shipyard-branch-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const run = { repo: directory, branch: "shipyard/sample" };
  const store = new RunStore(directory);
  const otherStore = new RunStore(directory);
  const release = store.claimBranch(run);
  assert.ok(release);
  assert.equal(otherStore.claimBranch(run), undefined);
  const releaseOtherBranch = otherStore.claimBranch({ ...run, branch: "shipyard/other" });
  assert.ok(releaseOtherBranch);
  releaseOtherBranch();
  release();

  const releaseNext = otherStore.claimBranch(run);
  assert.ok(releaseNext);
  release();
  assert.equal(store.claimBranch(run), undefined);
  releaseNext();
  assert.deepEqual(readdirSync(join(directory, ".branch-locks")), []);
});

test("a branch claim is recoverable after its owner exits", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "shipyard-branch-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const run = { repo: directory, branch: "shipyard/sample" };
  const script = `
    import { RunStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    const release = new RunStore(${JSON.stringify(directory)}).claimBranch(${JSON.stringify(run)});
    if (!release) process.exit(1);
  `;
  await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script]);
  assert.equal(readdirSync(join(directory, ".branch-locks")).length, 1);
  const release = new RunStore(directory).claimBranch(run);
  assert.ok(release);
  release();
  assert.deepEqual(readdirSync(join(directory, ".branch-locks")), []);
});
