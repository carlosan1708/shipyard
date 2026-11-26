import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { dockerProjectCheck, type DockerCommand } from "../src/docker-check.ts";

const image = "node:22-bookworm-slim";
const response = (code = 0, output = "", timedOut = false) => ({ code, output, timedOut });

function checkout(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "shipyard-docker-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: path, stdio: "pipe" });
  return path;
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `Missing ${name}`);
  return args[index + 1]!;
}

test("Docker checks copy current tracked and untracked files and isolate dependency setup", async (t) => {
  const cwd = checkout(t);
  writeFileSync(join(cwd, ".gitignore"), ".env\n");
  writeFileSync(join(cwd, "tracked.js"), "original");
  writeFileSync(join(cwd, "deleted.js"), "removed later");
  execFileSync("git", ["add", "."], { cwd, stdio: "pipe" });
  writeFileSync(join(cwd, "tracked.js"), "current");
  rmSync(join(cwd, "deleted.js"));
  writeFileSync(join(cwd, "new test.js"), "uncommitted");
  writeFileSync(join(cwd, ".env"), "PRIVATE_VALUE=outside-container");

  const created: string[] = [];
  const removed: string[] = [];
  const networks: string[] = [];
  let snapshot: string | undefined;
  const docker: DockerCommand = async (args) => {
    if (args[0] === "image") return response();
    if (args[1] === "create") {
      const mount = /^type=bind,(?:"source=((?:[^"]|"")*)"|source=([^,]+)),target=\/shipyard-workspace$/.exec(flag(args, "--mount"));
      assert.ok(mount);
      const source = mount[1]?.replaceAll('""', '"') ?? mount[2]!;
      assert.equal(args.filter((arg) => arg === "--mount").length, 1);
      assert.deepEqual(args.flatMap((arg, index) => arg === "--env" ? [args[index + 1]] : []), ["HOME=/tmp", "CI=1", "NO_COLOR=1"]);
      assert.notEqual(source, cwd);
      assert.equal(readFileSync(join(source, "tracked.js"), "utf8"), "current");
      assert.equal(readFileSync(join(source, "new test.js"), "utf8"), "uncommitted");
      networks.push(flag(args, "--network"));
      created.push(flag(args, "--name"));
      if (!snapshot) {
        assert.deepEqual(readdirSync(source).sort(), [".gitignore", "new test.js", "tracked.js"]);
        snapshot = source;
      } else {
        assert.equal(source, snapshot);
        assert.equal(readFileSync(join(source, "dependency"), "utf8"), "installed");
      }
      return response();
    }
    if (args[1] === "start") {
      assert.ok(snapshot);
      if (created.length === 1) writeFileSync(join(snapshot, "dependency"), "installed");
      return response(0, "container output");
    }
    if (args[1] === "inspect") return response(0, JSON.stringify({ Status: "exited", ExitCode: created.length === 1 ? 0 : 7 }));
    assert.deepEqual(args.slice(0, 4), ["container", "rm", "--force", "--volumes"]);
    removed.push(args[4]!);
    return response();
  };

  const result = await dockerProjectCheck("npm test", cwd, { image, install: "npm ci --ignore-scripts" }, undefined, undefined, docker);
  assert.equal(result.code, 7);
  assert.equal(result.output, "container output");
  assert.deepEqual(networks, ["bridge", "none"]);
  assert.equal(new Set(created).size, 2);
  assert.deepEqual(removed, created);
  assert.ok(snapshot && !existsSync(snapshot));
  assert.equal(existsSync(join(cwd, "dependency")), false);
});

test("cancelling a running Docker check removes its container", async (t) => {
  const cwd = checkout(t);
  const controller = new AbortController();
  let announceStart!: () => void;
  const started = new Promise<void>((resolve) => { announceStart = resolve; });
  const calls: string[][] = [];
  const docker: DockerCommand = async (args, { signal }) => {
    calls.push(args);
    if (args[1] !== "start") return response();
    assert.equal(signal, controller.signal);
    announceStart();
    return new Promise((resolve) => signal!.addEventListener("abort", () => resolve(response(1)), { once: true }));
  };

  const running = dockerProjectCheck("npm test", cwd, { image }, undefined, controller.signal, docker);
  await Promise.race([started, running]);
  controller.abort();
  const result = await running;
  assert.equal(result.code, 130);
  assert.equal(result.timedOut, false);
  const name = flag(calls[1]!, "--name");
  assert.deepEqual(calls.slice(2), [["container", "start", "--attach", name], ["container", "rm", "--force", "--volumes", name]]);
});

test("a timed-out Docker check still removes its container", async (t) => {
  const cwd = checkout(t);
  const calls: string[][] = [];
  const docker: DockerCommand = async (args) => {
    calls.push(args);
    return args[1] === "start" ? response(1, "time limit", true) : response();
  };

  const result = await dockerProjectCheck("npm test", cwd, { image }, 5_000, undefined, docker);
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.output, "time limit");
  assert.deepEqual(calls.at(-1), ["container", "rm", "--force", "--volumes", flag(calls[1]!, "--name")]);
});
