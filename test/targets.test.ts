import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { parseConfig } from "../src/config.ts";
import { loadRoles } from "../src/roles.ts";
import { addTargetToConfigFile, detectCommands, displayPath, findLocalRepos, inspectRepo, suggestName, validateTargetName } from "../src/targets.ts";
import { RunManager, type LiveMessage } from "../src/ui/manager.ts";
import { initRepoWithCommit } from "../src/worktree.ts";
import { FakeRunner, makeTargetRepo, tempDir, writeFiles } from "./helpers.ts";

const commands = (dir: string) => {
  const d = detectCommands(dir);
  return { test: d.test.map((c) => c.command), e2e: d.e2e.map((c) => c.command) };
};

test("Node: package scripts become commands, with the repo's own package manager", () => {
  const dir = tempDir();
  writeFiles(dir, {
    "package.json": JSON.stringify({
      scripts: { test: "vitest run", "test:watch": "vitest", "test:e2e": "playwright test", "test:e2e:ui": "playwright test --ui", "test:unit": "vitest run unit", dev: "vite" },
    }),
    "pnpm-lock.yaml": "",
  });
  assert.deepEqual(commands(dir), { test: ["pnpm test", "pnpm run test:unit"], e2e: ["pnpm run test:e2e"] });
});

test("npm's placeholder test script is never suggested (it always fails)", () => {
  const dir = tempDir();
  writeFiles(dir, { "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.deepEqual(commands(dir), { test: [], e2e: [] });
});

test("Python, Make, Go and Rust projects get their usual test commands", () => {
  const py = tempDir();
  writeFiles(py, { "pyproject.toml": "[tool.pytest.ini_options]\n", "Makefile": "test:\n\tpytest\ne2e:\n\tpytest e2e\n" });
  assert.deepEqual(commands(py), { test: ["pytest", "make test"], e2e: ["make e2e"] });
  const go = tempDir();
  writeFiles(go, { "go.mod": "module x\n", "Cargo.toml": "[package]\n" });
  assert.deepEqual(commands(go).test, ["go test ./...", "cargo test"]);
});

test("inspectRepo explains what's wrong with a folder before it's added", async () => {
  const plain = tempDir();
  const r1 = await inspectRepo(plain, "/", {});
  assert.equal(r1.ok, false);
  assert.match(r1.errors[0]!, /not a git repository/);

  const empty = tempDir();
  const { git } = await import("../src/exec.ts");
  await git(["init", "-q"], empty);
  assert.match((await inspectRepo(empty, "/", {})).errors[0]!, /no commits/);

  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "Initial commit"], empty);
  const fresh = await inspectRepo(empty, "/", {});
  assert.equal(fresh.ok, true, "an empty first commit is enough to start");
  assert.equal(fresh.empty, true);
  assert.deepEqual(fresh.test, []);
  assert.equal((await inspectRepo(await makeTargetRepo(), "/", {})).empty, false);

  assert.match((await inspectRepo("/definitely/not/here", "/", {})).errors[0]!, /No folder/);
  assert.match((await inspectRepo("  ", "/", {})).errors[0]!, /Enter the folder/);
});

test("inspectRepo uses the repo root, counts commits and warns about uncommitted work", async () => {
  const repo = await makeTargetRepo();
  writeFiles(repo, { "src/add.js": "// edited\n", "notes.txt": "new\n" });
  const info = await inspectRepo(join(repo, "src"), "/", {});
  assert.equal(info.ok, true);
  assert.equal(realpathSync(info.path), realpathSync(repo));
  assert.equal(info.commits, 1);
  assert.equal(info.branch, "main");
  assert.ok(info.warnings.some((w) => /repository root/.test(w)));
  assert.ok(info.warnings.some((w) => /2 uncommitted changes won't be included/.test(w)));
  assert.deepEqual(info.test.map((c) => c.command), ["npm test"]);

  const again = await inspectRepo(repo, "/", { mine: { name: "mine", path: repo, test: "npm test" } });
  assert.equal(again.ok, false);
  assert.equal(again.existingName, "mine", "found even though the config path goes through a symlink");

  const clean = await makeTargetRepo();
  assert.deepEqual((await inspectRepo(clean, "/", {})).warnings, [], "no false 'repository root' warning for a symlinked path");
});

test("a config with an empty or inline targets entry still gets a clean block", () => {
  for (const start of ["targets: {}\n", "targets:\n", "model: x\n"]) {
    const file = join(tempDir(), "c.yaml");
    writeFileSync(file, start);
    addTargetToConfigFile(file, { name: "a", path: "/r/a", test: "t" });
    addTargetToConfigFile(file, { name: "b", path: "/r/b", test: "t" });
    assert.match(readFileSync(file, "utf8"), /targets:\n {2}a:\n {4}path: \/r\/a\n {4}test: t\n\n {2}b:\n/, start);
  }
});

test("names are checked and suggested from the folder", () => {
  assert.equal(suggestName("/x/Photo-Filtering---Deduplication Tool"), "photo-filtering---deduplication-tool");
  assert.equal(validateTargetName("my-api", {}), null);
  assert.match(validateTargetName("my api", {})!, /letters/);
  assert.match(validateTargetName("a", { a: { name: "a", path: "/", test: "t" } })!, /already/);
  assert.equal(displayPath(join(homedir(), "code", "x")), "~/code/x");
});

test("adding a target keeps the config file's comments and refuses duplicates", () => {
  const file = join(tempDir(), "shipyard.config.yaml");
  writeFileSync(file, "# my settings\nmodel: claude-opus-5-5 # the default\naskTools: [WebFetch, WebSearch]\n\ntargets:\n  # the demo\n  demo:\n    path: ./demo\n    test: npm test\n");
  addTargetToConfigFile(file, { name: "api", path: join(homedir(), "code", "api"), test: "pnpm test", e2e: "pnpm run test:e2e" });
  const text = readFileSync(file, "utf8");
  assert.match(text, /# my settings/);
  assert.match(text, /# the default/);
  assert.match(text, /# the demo/);
  assert.match(text, /askTools: \[WebFetch, WebSearch\]/, "the file's own style is kept");
  assert.match(text, /\n\n {2}api:\n {4}path: ~\/code\/api\n {4}test: pnpm test\n {4}e2e: pnpm run test:e2e\n/);
  assert.deepEqual(Object.keys(parseConfig(YAML.parse(text), "/").targets), ["demo", "api"]);
  assert.throws(() => addTargetToConfigFile(file, { name: "api", path: "/x", test: "t" }), /already/);
});

test("the manager adds a repo live: saved to the file, broadcast, and usable for a run", async () => {
  const configFile = join(tempDir(), "shipyard.config.yaml");
  writeFileSync(configFile, "targets: {}\n");
  const config = parseConfig({ worktreeRoot: tempDir(), runsDir: tempDir(), maxGateRetries: 0 }, "/");
  const manager = new RunManager({ config, roles: loadRoles(), runner: new FakeRunner([(req) => writeFiles(req.cwd, { "x.txt": "x\n" })]), configFile });
  const messages: LiveMessage[] = [];
  manager.bus.on("message", (m: LiveMessage) => messages.push(m));
  const repo = await makeTargetRepo();

  await assert.rejects(manager.addTarget({ name: "tiny", path: repo, test: "" }), /Enter the command/);
  await assert.rejects(manager.addTarget({ name: "bad name", path: repo, test: "npm test" }), /letters/);
  await assert.rejects(manager.addTarget({ name: "tiny", path: tempDir(), test: "npm test" }), /not a git repository/);

  const target = await manager.addTarget({ name: "tiny", path: repo, test: "npm test" });
  assert.equal(realpathSync(target.path), realpathSync(repo));
  assert.match(readFileSync(configFile, "utf8"), /tiny:\n {4}path: .+\n {4}test: npm test/);
  const updated = messages.find((m) => m.type === "targets");
  assert.ok(updated);
  assert.deepEqual(updated.targets.map((entry) => ({ ...entry, path: realpathSync(entry.path) })),
    [{ name: "tiny", path: realpathSync(repo), e2e: false }]);

  const id = manager.start({ target: "tiny", kind: "feature", request: "touch a file", checkpoints: [] });
  assert.equal((await manager.whenDone(id))?.status, "passed");

  const demo = new RunManager({ config, roles: loadRoles(), runner: new FakeRunner([]) });
  assert.equal(demo.canAddTargets, false);
  await assert.rejects(demo.addTarget({ name: "x", path: repo, test: "t" }), /demo mode/);
});

test("local repos are found one level down, newest first, minus the ones already added", async () => {
  const root = tempDir();
  for (const name of ["alpha", "beta", "taken"]) {
    mkdirSync(join(root, name));
    writeFiles(join(root, name), { "README.md": name });
    await initRepoWithCommit(join(root, name));
  }
  mkdirSync(join(root, "not-a-repo"));
  const found = findLocalRepos([root, "/does/not/exist"], [join(root, "taken")]);
  assert.deepEqual(found.map((r) => r.name).sort(), ["alpha", "beta"]);
});
