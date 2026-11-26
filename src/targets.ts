import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { expandPath, type Target } from "./config.ts";
import { git } from "./exec.ts";

const exec = promisify(execFile);

export interface CommandCandidate {
  command: string;
  /** Where it came from, e.g. "package.json script \"test\"". */
  source: string;
}

export interface RepoInspection {
  /** Absolute path of the repo root. */
  path: string;
  /** The path as it will be written to the config (~ for your home folder). */
  displayPath: string;
  suggestedName: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  branch?: string;
  commits?: number;
  test: CommandCandidate[];
  e2e: CommandCandidate[];
  /** Set when this repo is already a target. */
  existingName?: string;
  /** No committed files yet: a brand-new project whose first run sets everything up. */
  empty?: boolean;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

export function validateTargetName(name: string, existing: Record<string, Target>): string | null {
  if (!NAME.test(name)) return "Use letters, digits, dot, dash or underscore (up to 48), starting with a letter or digit";
  if (existing[name]) return `There is already a target called "${name}"`;
  return null;
}

export function suggestName(dir: string): string {
  return (
    basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 48) || "repo"
  );
}

/** Show home-folder paths with ~, so the config stays readable and portable between your machines. */
export function displayPath(abs: string): string {
  const fromHome = relative(homedir(), abs);
  if (!fromHome) return "~";
  if (isAbsolute(fromHome) || fromHome === ".." || fromHome.startsWith(`..${sep}`)) return abs;
  return `~/${fromHome.split(sep).join("/")}`;
}

/** Guess the unit test and E2E commands from the repo's own files. Best guesses first. */
export function detectCommands(dir: string): { test: CommandCandidate[]; e2e: CommandCandidate[] } {
  const test: CommandCandidate[] = [];
  const e2e: CommandCandidate[] = [];
  const has = (f: string) => existsSync(join(dir, f));

  const pkgFile = join(dir, "package.json");
  if (existsSync(pkgFile)) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(pkgFile, "utf8")).scripts ?? {}) as Record<string, string>;
    } catch {
      // unreadable package.json: no Node suggestions
    }
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const run = (script: string) => (script === "test" && pm !== "bun" ? `${pm} test` : `${pm} run ${script}`);
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== "string" || /no test specified/.test(body)) continue; // npm init's placeholder always fails
      // Watch modes and interactive UIs never exit, so as a gate they would hang the run.
      if (/watch|(^|[:-])(ui|open|debug|dev)$/i.test(name) || /--watch\b|--ui\b|\bopen\b/.test(body)) continue;
      const candidate = { command: run(name), source: `package.json script "${name}"` };
      if (/(^|[:-])(e2e|integration|playwright|cypress)([:-]|$)/i.test(name) || /\b(playwright|cypress)\b/.test(body)) e2e.push(candidate);
      else if (name === "test" || /^test[:-]|^unit$|[:-]unit$/.test(name)) test.push(candidate);
    }
    test.sort((a, b) => Number(b.command.endsWith(" test")) - Number(a.command.endsWith(" test")));
  }

  const pyproject = has("pyproject.toml") ? readFileSync(join(dir, "pyproject.toml"), "utf8") : "";
  if (pyproject.includes("pytest") || has("pytest.ini") || has("conftest.py") || (has("tests") && (has("pyproject.toml") || has("setup.py") || has("requirements.txt")))) {
    test.push({ command: "pytest", source: "Python project with pytest" });
  }

  if (has("Makefile")) {
    const makefile = readFileSync(join(dir, "Makefile"), "utf8");
    if (/^test\s*:/m.test(makefile)) test.push({ command: "make test", source: "Makefile target \"test\"" });
    if (/^e2e\s*:/m.test(makefile)) e2e.push({ command: "make e2e", source: "Makefile target \"e2e\"" });
  }
  if (has("go.mod")) test.push({ command: "go test ./...", source: "Go module" });
  if (has("Cargo.toml")) test.push({ command: "cargo test", source: "Rust crate" });

  const unique = (list: CommandCandidate[]) => list.filter((c, i) => list.findIndex((d) => d.command === c.command) === i);
  return { test: unique(test), e2e: unique(e2e) };
}

/** Everything the Add repo form needs to know about a folder before it becomes a target. */
export async function inspectRepo(input: string, baseDir: string, targets: Record<string, Target>): Promise<RepoInspection> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let path = expandPath(input.trim(), baseDir);
  // Compare real paths: on macOS /var is /private/var, and git always reports the real one.
  const sameRepo = (t: Target) => pathKey(realPath(t.path)) === pathKey(realPath(path));
  const result = (): RepoInspection => {
    const existing = Object.values(targets).find(sameRepo);
    return {
      path,
      displayPath: displayPath(path),
      suggestedName: existing?.name ?? suggestName(path),
      ok: errors.length === 0,
      errors,
      warnings,
      ...(errors.length ? { test: [], e2e: [] } : detectCommands(path)),
      branch,
      commits,
      existingName: existing?.name,
      empty,
    };
  };
  let branch: string | undefined;
  let commits: number | undefined;
  let empty: boolean | undefined;

  if (!input.trim()) {
    errors.push("Enter the folder of a git repository");
    return result();
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    errors.push("No folder at that path");
    return result();
  }
  let root: string;
  try {
    root = await git(["rev-parse", "--show-toplevel"], path);
  } catch {
    errors.push("This folder is not a git repository. Shipyard works on branches, so run `git init` and commit first.");
    return result();
  }
  if (pathKey(root) !== pathKey(realPath(path))) warnings.push(`Using the repository root, ${displayPath(root)}, which contains this folder.`);
  path = root;

  try {
    commits = Number(await git(["rev-list", "--count", "HEAD"], path));
    branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], path);
  } catch {
    errors.push("The repository has no commits yet. Make a first commit; shipyard starts every run from the latest one.");
    return result();
  }
  empty = (await git(["ls-files"], path)) === "";
  const dirty = (await git(["status", "--porcelain"], path)).split("\n").filter(Boolean).length;
  if (dirty) warnings.push(`${dirty} uncommitted change${dirty === 1 ? "" : "s"} won't be included: runs start from the latest commit on ${branch}.`);
  const existing = Object.values(targets).find(sameRepo);
  if (existing) errors.push(`Already added as "${existing.name}"`);
  return result();
}

export async function cloneRepo(url: string, root: string, signal: AbortSignal): Promise<{ path: string; name: string }> {
  const name = suggestName(url.replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/i, "") ?? "");
  const key = createHash("sha256").update(url).digest("hex").slice(0, 12);
  const path = join(root, `${name}-${key}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const reuse = async () => {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return undefined;
    const origin = await git(["config", "--local", "--get", "remote.origin.url"], path).catch(() => "");
    const checkoutRoot = await git(["rev-parse", "--show-toplevel"], path).catch(() => "");
    if (origin !== url || !checkoutRoot || pathKey(checkoutRoot) !== pathKey(realpathSync(path))) {
      throw new Error("The clone destination is occupied by a different checkout");
    }
    return { path, name };
  };
  const existing = await reuse();
  if (existing) return existing;
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("The clone destination already exists");

  const staging = mkdtempSync(join(root, ".clone-"));
  const checkout = join(staging, name);
  try {
    try {
      await exec("git", [
        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
        "clone", "--no-recurse-submodules", "--", url, checkout,
      ], { signal, timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
    } catch (error) {
      const failure = error as { killed?: boolean; stderr?: string };
      if (signal.aborted) throw new Error("Clone stopped because Shipyard is shutting down");
      if (failure.killed) throw new Error("Git did not finish cloning within two minutes. Check the connection and try again.");
      if (/authentication|could not read username|permission denied|repository not found|not found|publickey|403|401|host key verification/i.test(failure.stderr ?? "")) {
        throw new Error("Git could not access the repository. Check the URL and your Git credentials or SSH setup.");
      }
      throw new Error("Git could not clone the repository. Check the clone URL and your connection.");
    }
    signal.throwIfAborted();
    if (!await git(["rev-parse", "--verify", "HEAD"], checkout).catch(() => "")) {
      throw new Error("The remote has no checked-out commit. Push a first commit and set its default branch before adding it.");
    }
    const concurrent = await reuse();
    if (concurrent) return concurrent;
    if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("The clone destination already exists");
    renameSync(checkout, path);
    return { path, name };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Git repositories one level inside the usual project folders, for the "Your repos" list. */
export function findLocalRepos(roots: string[], exclude: string[]): Array<{ name: string; path: string; displayPath: string }> {
  const seen = new Set(exclude.map((path) => pathKey(realPath(path))));
  const repos: Array<{ name: string; path: string; displayPath: string; mtime: number }> = [];
  for (const root of [...new Set(roots)]) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = join(root, entry);
      try {
        const gitDir = statSync(join(dir, ".git"));
        const key = pathKey(realPath(dir));
        if (seen.has(key)) continue;
        seen.add(key);
        repos.push({ name: entry, path: dir, displayPath: displayPath(dir), mtime: gitDir.mtimeMs });
      } catch {
        // unreadable folder: skip
      }
    }
  }
  return repos
    .sort((a, b) => b.mtime - a.mtime) // most recently touched first
    .slice(0, 60)
    .map(({ name, path, displayPath }) => ({ name, path, displayPath }));
}

export function defaultRepoRoots(shipyardRoot: string): string[] {
  const home = homedir();
  return [dirname(shipyardRoot), ...["code", "projects", "dev", "src", "repos", "Developer", "Documents/GitHub", "workspace"].map((d) => join(home, d))];
}

/** Add a target to shipyard.config.yaml, keeping its comments and layout. */
export function addTargetToConfigFile(file: string, target: { name: string; path: string; test: string; e2e?: string }): void {
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  if (doc.errors.length) throw new Error(`${file} has YAML errors; fix them first: ${doc.errors[0]!.message}`);
  let targets = doc.get("targets", true);
  if (!YAML.isMap(targets)) {
    // Missing, `targets:` with nothing under it, or something odd: start a fresh map.
    targets = doc.createNode({});
    doc.set("targets", targets);
  }
  const map = targets as YAML.YAMLMap;
  if (map.has(target.name)) throw new Error(`There is already a target called "${target.name}"`);
  map.flow = false; // `targets: {}` becomes a normal block, not an inline map
  const entry: Record<string, string> = { path: displayPath(target.path), test: target.test };
  if (target.e2e) entry.e2e = target.e2e;
  const key = doc.createNode(target.name) as YAML.Scalar;
  if (map.items.length) key.spaceBefore = true; // a blank line between repos, like the rest of the file
  map.items.push(doc.createPair(key, doc.createNode(entry)));
  // Keep the file's own style: `[a, b]`, not the library's default `[ a, b ]`.
  writeFileSync(file, doc.toString({ flowCollectionPadding: false }));
}
