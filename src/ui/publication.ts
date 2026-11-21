import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { git } from "../exec.ts";

const exec = promisify(execFile);

interface Destination {
  remote: string;
  label: string;
  key: string;
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
  return { remote, label: safeRepo ? `${host}/${safeRepo}` : host, key: createHash("sha256").update(`${remote}\0${urls}`).digest("hex"), repository: github };
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

export async function pullRequestLink(repo: string, destination: Destination, branch: string): Promise<string | undefined> {
  if (!destination.repository) return;
  const prefix = `refs/remotes/${destination.remote}/`;
  const head = await git(["symbolic-ref", "--quiet", `${prefix}HEAD`], repo).catch(() => "");
  const base = head.startsWith(prefix) ? head.slice(prefix.length) : undefined;
  const selection = base ? `${encodeURIComponent(base)}...${encodeURIComponent(branch)}` : encodeURIComponent(branch);
  return `${destination.repository}/compare/${selection}?quick_pull=1`;
}

export async function createRunPullRequest(repo: string, repository: string, branch: string, head: string, signal: AbortSignal): Promise<string> {
  const slug = new URL(repository).pathname.slice(1);
  const apiPath = `repos/${slug}`;
  const api = async (...args: string[]) => (await exec("gh", ["api", "--hostname", "github.com", ...args], {
    cwd: repo, signal, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  })).stdout.trim();
  const confirmedUrl = (value: string) => {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    const match = url?.pathname.match(/^\/(.+)\/pull\/([1-9]\d*)$/);
    if (url?.origin === "https://github.com" && match?.[1]?.toLowerCase() === slug.toLowerCase()) {
      return `${repository}/pull/${match[2]}`;
    }
  };
  let pullRequestUrl: string | undefined;
  try {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const remoteHead = await api(`${apiPath}/git/ref/heads/${ref}`, "--jq", ".object.sha");
    if (remoteHead !== head) throw new Error("remote head changed");
    const existing = await api(`${apiPath}/pulls`, "--method", "GET",
      "-f", `head=${slug.split("/")[0]}:${branch}`, "-f", "state=open", "--jq", ".[].html_url");
    pullRequestUrl = existing.split("\n").map(confirmedUrl).find(Boolean);
    if (!pullRequestUrl) {
      const base = await api(apiPath, "--jq", ".default_branch");
      const title = await git(["show", "-s", "--format=%s", head], repo);
      const created = await api(`${apiPath}/pulls`, "--method", "POST", "-f", `head=${branch}`, "-f", `base=${base}`,
        "-f", `title=${title || branch}`, "--jq", ".html_url");
      pullRequestUrl = confirmedUrl(created);
    }
  } catch (error) {
    const failure = error as { code?: string; message?: string; stderr?: string; killed?: boolean };
    const message = failure.stderr ?? "";
    if (failure.message === "remote head changed") {
      throw new Error("GitHub’s branch no longer matches the pushed commit. Check the branch on GitHub before creating a pull request.");
    }
    if (signal.aborted || failure.killed) throw new Error("The GitHub request did not finish. Try again to find or create the pull request.");
    if (failure.code === "ENOENT") throw new Error("Install GitHub CLI (gh) and sign in with gh auth login to create pull requests from Shipyard.");
    if (/gh auth login|HTTP 401|bad credentials/i.test(message)) throw new Error("Sign in to GitHub CLI with gh auth login, then try again.");
    if (/HTTP 40[34]|resource not accessible/i.test(message)) throw new Error("GitHub denied access. Check that GitHub CLI has permission to read the repository and create pull requests.");
    if (/no commits between/i.test(message)) throw new Error("The branch has no commits to merge into the repository’s default branch.");
    throw new Error("GitHub could not create the pull request. Retry or use Compare on GitHub.");
  }
  if (!pullRequestUrl) throw new Error("GitHub did not return a pull request link. Retry to find the pull request.");
  return pullRequestUrl;
}
