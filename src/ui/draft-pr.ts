import { git } from "../exec.ts";
import type { RunRecord } from "../store.ts";
import { detachedWorktree, squashCommit } from "../worktree.ts";

export interface DraftReview {
  token: string;
  repository: string;
  destination: string;
  head: string;
  base: { branch: string; head: string };
  branch: string;
  description: string;
  transplant?: { tree: string; conflicts: string[] };
}

export const MAX_PULL_REQUEST_DESCRIPTION = 32_000;

/** Describe the reviewed diff and checks without copying the brief or agent logs into GitHub. */
export async function describePullRequest(repo: string, base: string, head: string, checks: string[]): Promise<string> {
  const changes = (await git(["diff", "--name-status", "--no-renames", "-z", base, head, "--"], repo, { raw: true })).split("\0");
  const summary: string[] = [];
  for (const [status, verb] of [["A", "Add"], ["M", "Update"], ["D", "Remove"], ["T", "Change file type for"]]) {
    const files = [];
    for (let index = 0; index + 1 < changes.length; index += 2) {
      if (changes[index] === status) files.push(changes[index + 1]!);
    }
    if (!files.length) continue;
    const paths = files.slice(0, 8).map(markdownCode).join(", ");
    summary.push(`- ${verb} ${paths}${files.length > 8 ? ` and ${files.length - 8} more` : ""}.`);
  }
  return ["## Summary", ...summary, "", "## Verification", ...(checks.length ? checks : ["- No checks recorded for this commit."])].join("\n");
}

export function markdownCode(text: string): string {
  const normalized = text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
  const backticks = normalized.match(/`+/g) ?? [];
  if (!backticks.length) return `\`${normalized}\``;
  const marker = "`".repeat(1 + Math.max(0, ...backticks.map((run) => run.length)));
  return `${marker} ${normalized} ${marker}`;
}

/** Apply the run's commit range on a different base in a scratch checkout. */
export async function reviewDraftBranch(run: RunRecord, head: string, base: string, root: string):
  Promise<Pick<DraftReview, "branch" | "transplant">> {
  if (await git(["merge-base", "--is-ancestor", head, base], run.repo).then(() => true, () => false)) {
    throw new Error("GitHub’s default branch already contains this commit.");
  }
  if (await git(["merge-base", head, base], run.repo).then(() => true, () => false)) return { branch: run.branch };

  const source = run.branchBaseSha ?? run.baseSha;
  if (!await git(["merge-base", "--is-ancestor", source, head], run.repo).then(() => true, () => false)) {
    throw new Error("Shipyard couldn’t find the start of this run’s changes.");
  }
  const commit = await squashCommit(run.repo, head, source, "Prepare verified Shipyard changes");
  const scratch = await detachedWorktree(run.repo, root, base);
  try {
    const applied = await git(["-c", "rerere.enabled=false", "-c", "core.hooksPath=/dev/null", "cherry-pick", "--no-commit", commit], scratch.worktree)
      .then(() => true, () => false);
    const conflicts = (await git(["diff", "--name-only", "--diff-filter=U", "-z"], scratch.worktree, { raw: true })).split("\0").filter(Boolean);
    if (!applied && !conflicts.length) throw new Error("Shipyard couldn’t apply the run’s changes to GitHub’s default branch.");
    if (conflicts.length) {
      await git(["--literal-pathspecs", "restore", `--source=${head}`, "--staged", "--worktree", "--", ...conflicts], scratch.worktree);
    }
    const tree = await git(["write-tree"], scratch.worktree);
    if (tree === await git(["rev-parse", `${base}^{tree}`], run.repo)) {
      throw new Error("GitHub’s default branch already contains these changes.");
    }
    const prefix = `${run.branch}-pr`;
    let branch = prefix;
    for (let suffix = 2; await git(["show-ref", "--verify", `refs/heads/${branch}`], run.repo).then(() => true, () => false); suffix++) {
      branch = `${prefix}-${suffix}`;
    }
    return { branch, transplant: { tree, conflicts } };
  } finally {
    await scratch.close();
  }
}
