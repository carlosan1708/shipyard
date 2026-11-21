import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitAllowing } from "./exec.ts";

export interface WorktreeDiff {
  /** One line per changed file, e.g. "M  src/server.js  (+2 -0)" or "A  test/health.test.js  (+57)". */
  summary: string[];
  /** The full patch, untracked files included. */
  patch: string;
}

/**
 * What changed since HEAD, including untracked files, without touching the index
 * (staging here would confuse the lane revert and the stage commit).
 */
export async function diffSinceHead(cwd: string): Promise<WorktreeDiff> {
  const summary: string[] = [];
  const numstat = await git(["diff", "HEAD", "--numstat"], cwd);
  const status = await git(["diff", "HEAD", "--name-status"], cwd);
  const statusByPath = new Map(status.split("\n").filter(Boolean).map((l) => [l.split("\t").at(-1)!, l.split("\t")[0]!]));
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed, path] = line.split("\t");
    summary.push(`${(statusByPath.get(path!) ?? "M").padEnd(2)} ${path}  (+${added} -${removed})`);
  }
  let patch = await git(["diff", "HEAD"], cwd, { raw: true });

  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd, { raw: true })).split("\0").filter(Boolean);
  for (const path of untracked) {
    const text = readFileSync(join(cwd, path), "utf8");
    const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    summary.push(`A  ${path}  (+${lines}, new)`);
    patch += await gitAllowing(["diff", "--no-index", "--", "/dev/null", path], cwd, [1]);
  }
  return { summary, patch };
}

/** Commits made by shipyard are authored by a bot identity, so provenance is obvious in `git log`. */
const BOT = ["-c", "user.name=shipyard", "-c", "user.email=shipyard@localhost"];

export async function repoRoot(path: string): Promise<string> {
  try {
    return await git(["rev-parse", "--show-toplevel"], path);
  } catch {
    throw new Error(`Target is not a git repository: ${path}`);
  }
}

/** Serialize repository operations that update shared Git metadata. */
const repoLocks = new Map<string, Promise<unknown>>();
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repo) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  repoLocks.set(repo, next);
  return next;
}

/** Create `branch` at the requested commit or the repo's HEAD, in a new worktree. */
export async function createWorktree(repo: string, dir: string, branch: string, startCommit?: string): Promise<string> {
  return withRepoLock(repo, async () => {
    const baseSha = startCommit ?? await git(["rev-parse", "HEAD"], repo).catch(() => {
      throw new Error(`Target repository has no commits yet: ${repo}`);
    });
    mkdirSync(dirname(dir), { recursive: true });
    await git(["worktree", "add", "-b", branch, dir, baseSha], repo);
    return baseSha;
  });
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(["worktree", "remove", "--force", dir], repo).catch(() => rmSync(dir, { recursive: true, force: true }));
}

/** Files changed since HEAD, including untracked files. Paths are relative to the worktree. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const out = await git(["status", "--porcelain=v1", "--no-renames", "-uall", "-z"], cwd, { raw: true });
  if (!out) return [];
  return out.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

/** Undo changes to the given files: restore tracked ones from HEAD, delete untracked ones. */
export async function revertFiles(cwd: string, files: string[]): Promise<void> {
  for (const file of files) {
    const tracked = await git(["cat-file", "-e", `HEAD:${file}`], cwd).then(
      () => true,
      () => false,
    );
    if (tracked) await git(["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", file], cwd);
    else {
      await git(["--literal-pathspecs", "rm", "--cached", "--ignore-unmatch", "-f", "--", file], cwd);
      rmSync(join(cwd, file), { force: true });
    }
  }
}

/** Stage and commit everything. Returns the new commit sha, or null if there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(["add", "-A"], cwd);
  const staged = await git(["diff", "--cached", "--name-only"], cwd);
  if (!staged) return null;
  await git([...BOT, "commit", "-q", "--no-verify", "-m", message], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

export async function initRepoWithCommit(dir: string, message = "Initial commit"): Promise<void> {
  await git(["init", "-q", "-b", "main"], dir);
  await git(["add", "-A"], dir);
  await git([...BOT, "commit", "-q", "--no-verify", "-m", message], dir);
}
