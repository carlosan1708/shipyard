import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./exec.ts";

/** Commits made by shipyard are authored by a bot identity, so provenance is obvious in `git log`. */
const BOT = ["-c", "user.name=shipyard", "-c", "user.email=shipyard@localhost"];

export async function repoRoot(path: string): Promise<string> {
  try {
    return await git(["rev-parse", "--show-toplevel"], path);
  } catch {
    throw new Error(`Target is not a git repository: ${path}`);
  }
}

/** Create `branch` at the repo's HEAD, checked out in a new worktree at `dir`. Returns the base commit. */
export async function createWorktree(repo: string, dir: string, branch: string): Promise<string> {
  const baseSha = await git(["rev-parse", "HEAD"], repo).catch(() => {
    throw new Error(`Target repository has no commits yet: ${repo}`);
  });
  mkdirSync(dirname(dir), { recursive: true });
  await git(["worktree", "add", "-b", branch, dir, baseSha], repo);
  return baseSha;
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(["worktree", "remove", "--force", dir], repo).catch(() => rmSync(dir, { recursive: true, force: true }));
}

/** Files changed since HEAD, including untracked files. Paths are relative to the worktree. */
export async function changedFiles(cwd: string): Promise<string[]> {
  const out = await git(["status", "--porcelain=v1", "-uall", "-z"], cwd, { raw: true });
  if (!out) return [];
  const entries = out.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) i++; // skip the rename source
  }
  return files;
}

/** Undo changes to the given files: restore tracked ones from HEAD, delete untracked ones. */
export async function revertFiles(cwd: string, files: string[]): Promise<void> {
  for (const file of files) {
    const tracked = await git(["ls-files", "--error-unmatch", file], cwd).then(
      () => true,
      () => false,
    );
    if (tracked) await git(["checkout", "HEAD", "--", file], cwd);
    else rmSync(join(cwd, file), { force: true });
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
