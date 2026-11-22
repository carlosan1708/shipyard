import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { git } from "../exec.ts";

const exec = promisify(execFile);

export interface Destination {
  remote: string;
  label: string;
  key: string;
  url: string;
  repository?: string;
}

export async function pushDestination(repo: string, remotes: string): Promise<Destination | undefined> {
  const names = remotes.split("\n").filter(Boolean);
  const remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;
  if (!remote || !/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]*$/.test(remote)) return;
  const urls = await git(["remote", "get-url", "--push", "--all", remote], repo);
  if (!urls || urls.includes("\n")) return;
  const scp = urls.match(/^(?:[\w.-]+@)?([\w.-]+):([^\s].*)$/);
  const url = URL.canParse(urls) ? new URL(urls) : undefined;
  let host: string;
  let repository: string | undefined;
  if (isAbsolute(urls) || url?.protocol === "file:") {
    host = "local repository";
  } else if (url && ["https:", "ssh:"].includes(url.protocol) && url.hostname) {
    host = url.host;
    repository = url.pathname;
  } else if (scp && !urls.includes("://") && !scp[2]?.startsWith(":")) {
    host = scp[1]!;
    repository = scp[2];
  } else {
    return;
  }
  const cleanPath = repository?.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const safeRepo = cleanPath && /^[\w.-]+(?:\/[\w.-]+)+$/.test(cleanPath) ? cleanPath : undefined;
  const github = host === "github.com" && safeRepo && /^[a-z\d][a-z\d-]*\/(?!\.{1,2}$)[\w.-]+$/i.test(safeRepo)
    ? `https://github.com/${safeRepo}` : undefined;
  return { remote, label: safeRepo ? `${host}/${safeRepo}` : host, key: createHash("sha256").update(`${remote}\0${urls}`).digest("hex"), url: urls, repository: github };
}

export async function pushRunCommit(repo: string, destination: Destination, branch: string, head: string, signal: AbortSignal): Promise<void> {
  try {
    await exec("git", [
      "-c", `remote.${destination.remote}.mirror=false`,
      "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
      "-c", "protocol.ssh.allow=always", "-c", "protocol.file.allow=always",
      "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--",
      destination.remote, `${head}:refs/heads/${branch}`,
    ], {
      cwd: repo, timeout: 90_000, maxBuffer: 1024 * 1024, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; killed?: boolean };
    const message = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    if (signal.aborted || failure.killed) throw new Error("The push did not finish. Retry to check or send the same commit.");
    if (/non-fast-forward|\(fetch first\)/i.test(message)) throw new Error("The remote branch has different commits. Shipyard refused to overwrite them.");
    if (/authentication|permission denied|access denied|could not read username|repository not found|not appear to be a git repository|403/i.test(message)) {
      throw new Error("Git could not access the remote. Check its URL and your Git credentials or write access, then retry.");
    }
    if (/could not resolve|failed to connect|connection (?:refused|timed out)/i.test(message)) throw new Error("Git could not reach the remote. Check your connection and retry.");
    throw new Error("Git rejected the push. Check the remote’s branch rules and repository settings, then retry.");
  }
}

class PullRequestComparisonError extends Error {
  constructor(readonly reason: "unrelated" | "no-changes", message: string) { super(message); }
}

function githubApi(repo: string, signal: AbortSignal, timeout: number) {
  return async (...args: string[]) => (await exec("gh", ["api", "--hostname", "github.com", ...args], {
    cwd: repo, signal, timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  })).stdout.trim();
}

function githubHead(api: ReturnType<typeof githubApi>, path: string, branch: string) {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  return api(`${path}/git/ref/heads/${ref}`, "--jq", ".object.sha");
}

function linkedPullRequestNumber(repository: string, link: string): string | undefined {
  const url = URL.canParse(link) ? new URL(link) : undefined;
  const number = url?.pathname.split("/").at(-1);
  if (!number || !/^[1-9]\d*$/.test(number) || `${repository}/pull/${number}` !== link) return;
  return number;
}

export async function linkedPullRequestState(repo: string, repository: string, link: string, signal: AbortSignal): Promise<"open" | "closed" | undefined> {
  const number = linkedPullRequestNumber(repository, link);
  if (!number) return;
  const path = `repos/${new URL(repository).pathname.slice(1)}/pulls/${number}`;
  const state = await githubApi(repo, signal, 3000)(path, "--jq", 'if .merged then "merged" else .state end').catch(() => undefined);
  return state === "open" || state === "closed" ? state : undefined;
}

export async function closedPullRequest(repo: string, repository: string, link: string, branch: string, signal: AbortSignal) {
  const number = linkedPullRequestNumber(repository, link);
  if (!number) throw new Error("The linked pull request is unavailable in this repository.");
  const slug = new URL(repository).pathname.slice(1);
  const path = `repos/${slug}/pulls/${number}`;
  const api = githubApi(repo, signal, 12_000);
  const details = await api(path, "--jq", '{state, merged, body, branch:.head.ref, repository:.head.repo.full_name, base:.base.ref}')
    .then((value) => JSON.parse(value) as { state?: string; merged?: boolean; body?: string | null; branch?: string; repository?: string; base?: string })
    .catch(() => { throw new Error("Shipyard couldn’t read the linked pull request on GitHub. Try reviewing it again."); });
  if (details.state !== "closed" || details.merged !== false || details.branch !== branch || details.repository?.toLowerCase() !== slug.toLowerCase() || !details.base) {
    throw new Error("The linked pull request must be closed, unmerged, and use this branch to reopen it.");
  }
  return { link, number, base: details.base, body: details.body ?? "" };
}

export async function reopenRunPullRequest(repo: string, repository: string, link: string, branch: string, head: string,
  base: { branch: string; head: string }, description: string, signal: AbortSignal): Promise<void> {
  const closed = await closedPullRequest(repo, repository, link, branch, signal);
  const path = `repos/${new URL(repository).pathname.slice(1)}`;
  const api = githubApi(repo, signal, 30_000);
  if (closed.base !== base.branch || await githubHead(api, path, base.branch) !== base.head || await githubHead(api, path, branch) !== head) {
    throw new Error("The GitHub branches changed. Review the pull request again before reopening it.");
  }
  const opened = await writePullRequest(api, `${path}/pulls/${closed.number}`, "PATCH", { state: "open", body: description }, ".state");
  if (opened !== "open") throw new Error("GitHub did not confirm that the pull request reopened.");
}

export async function draftBase(repo: string, repository: string, signal: AbortSignal, requestedBranch?: string) {
  const api = githubApi(repo, signal, 12_000);
  const path = `repos/${new URL(repository).pathname.slice(1)}`;
  try {
    const branch = requestedBranch ?? await api(path, "--jq", ".default_branch");
    const head = await githubHead(api, path, branch);
    if (!branch || !/^[a-f0-9]{40}$/.test(head)) throw new Error("GitHub returned an invalid base branch");
    return { branch, head };
  } catch (error) {
    const failure = error as { code?: string; stderr?: string };
    if (failure.code === "ENOENT" || /HTTP 401|gh auth login|bad credentials/i.test(failure.stderr ?? "")) {
      throw new Error("Sign in to GitHub on this computer, then review the draft again.");
    }
    throw new Error("Shipyard couldn’t read the base branch on GitHub. Check the repository connection and try again.");
  }
}

async function writePullRequest(api: ReturnType<typeof githubApi>, path: string, method: "POST" | "PATCH", body: object, field: string) {
  const directory = await mkdtemp(join(tmpdir(), "shipyard-pr-"));
  try {
    const input = join(directory, "pull-request.json");
    await writeFile(input, JSON.stringify(body), { mode: 0o600 });
    return await api(path, "--method", method, "--input", input, "--jq", field);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function fetchDraftBase(repo: string, destination: Destination, head: string, signal: AbortSignal): Promise<void> {
  if (await git(["cat-file", "-e", `${head}^{commit}`], repo).then(() => true, () => false)) return;
  try {
    await exec("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
      "fetch", "--no-tags", "--no-write-fetch-head", "--", destination.url, head], {
      cwd: repo, signal, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    });
  } catch {
    throw new Error("Shipyard couldn’t fetch the reviewed commit from GitHub. Check the repository connection and try again.");
  }
}

async function pullRequestBase(api: ReturnType<typeof githubApi>, apiPath: string, head: string): Promise<string> {
  const base = await api(apiPath, "--jq", ".default_branch");
  if (!base) throw new Error("GitHub did not return the default branch");
  try {
    const ahead = await api(`${apiPath}/compare/${encodeURIComponent(base)}...${head}`,
      "--method", "GET", "-F", "per_page=1", "--jq", ".ahead_by");
    if (ahead === "0") throw new PullRequestComparisonError("no-changes", "The branch has no commits to merge into the repository’s default branch.");
  } catch (error) {
    if (/no common ancestor/i.test((error as { stderr?: string }).stderr ?? "")) {
      throw new PullRequestComparisonError("unrelated", "The run branch and GitHub’s default branch have unrelated histories. Shipyard can prepare a compatible branch for a draft PR.");
    }
    throw error;
  }
  return base;
}

export async function pullRequestOptions(repo: string, repository: string, head: string, signal: AbortSignal):
  Promise<{ canCreatePullRequest?: true; pullRequestUnavailable?: string; pullRequestBlocked?: "unrelated" | "no-changes" }> {
  const apiPath = `repos/${new URL(repository).pathname.slice(1)}`;
  const api = githubApi(repo, signal, 3_000);
  try {
    await pullRequestBase(api, apiPath, head);
  } catch (error) {
    if (error instanceof PullRequestComparisonError) return { pullRequestUnavailable: error.message, pullRequestBlocked: error.reason };
    // Let the explicit creation request report authentication or connection errors.
  }
  return { canCreatePullRequest: true };
}

export async function createRunPullRequest(repo: string, repository: string, branch: string, head: string, signal: AbortSignal,
  options: { draft: boolean; description: string; reviewedBase?: { branch: string; head: string } }): Promise<string> {
  const { draft, description, reviewedBase } = options;
  const slug = new URL(repository).pathname.slice(1);
  const apiPath = `repos/${slug}`;
  const api = githubApi(repo, signal, 30_000);
  const confirmedUrl = (value: string) => {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    const match = url?.pathname.match(/^\/(.+)\/pull\/([1-9]\d*)$/);
    if (url?.origin === "https://github.com" && match?.[1]?.toLowerCase() === slug.toLowerCase()) {
      return `${repository}/pull/${match[2]}`;
    }
  };
  let pullRequestUrl: string | undefined;
  try {
    const remoteHead = await githubHead(api, apiPath, branch);
    if (remoteHead !== head) throw new Error("remote head changed");
    const existing = await api(`${apiPath}/pulls`, "--method", "GET",
      "-f", `head=${slug.split("/")[0]}:${branch}`, "-f", "state=open", "--jq", ".[].html_url");
    pullRequestUrl = existing.split("\n").map(confirmedUrl).find(Boolean);
    if (!pullRequestUrl) {
      const base = await pullRequestBase(api, apiPath, head);
      if (reviewedBase && (base !== reviewedBase.branch || await githubHead(api, apiPath, base) !== reviewedBase.head)) {
        throw new Error("reviewed base changed");
      }
      const title = await git(["show", "-s", "--format=%s", head], repo);
      const created = await writePullRequest(api, `${apiPath}/pulls`, "POST", { head: branch, base, title: title || branch, draft, body: description }, ".html_url");
      pullRequestUrl = confirmedUrl(created);
    }
  } catch (error) {
    if (error instanceof PullRequestComparisonError) throw error;
    const failure = error as { code?: string; message?: string; stderr?: string; killed?: boolean };
    const message = failure.stderr ?? "";
    if (failure.message === "remote head changed") {
      throw new Error("GitHub’s branch no longer matches the pushed commit. Check the branch on GitHub before creating a pull request.");
    }
    if (failure.message === "reviewed base changed") throw new Error("GitHub’s default branch moved. Review the draft against the current base.");
    if (signal.aborted || failure.killed) throw new Error("The GitHub request did not finish. Try again to find or create the pull request.");
    if (failure.code === "ENOENT") throw new Error("Install GitHub CLI (gh) and sign in with gh auth login to create pull requests from Shipyard.");
    if (/gh auth login|HTTP 401|bad credentials/i.test(message)) throw new Error("Sign in to GitHub CLI with gh auth login, then try again.");
    if (/HTTP 40[34]|resource not accessible/i.test(message)) throw new Error("GitHub denied access. Check that GitHub CLI has permission to read the repository and create pull requests.");
    if (/no commits between/i.test(message)) throw new Error("The branch has no commits to merge into the repository’s default branch.");
    throw new Error("GitHub could not create the pull request. Check the repository’s pull request settings and try again.");
  }
  if (!pullRequestUrl) throw new Error("GitHub did not return a pull request link. Retry to find the pull request.");
  return pullRequestUrl;
}
