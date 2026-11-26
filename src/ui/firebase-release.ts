import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { git } from "../exec.ts";
import { gateOk, type GateRecord } from "../store.ts";
import { changedFiles, detachedWorktree } from "../worktree.ts";
import { draftBase, fetchDraftBase, githubOrigin, inspectLinkedPullRequest } from "./publication.ts";

const exec = promisify(execFile);
const identifier = /^[a-z0-9][a-z0-9-]{0,62}$/;
const staticKeys = new Set(["site", "public", "ignore", "cleanUrls", "trailingSlash", "headers", "redirects", "rewrites"]);

export interface FirebaseHostingRelease {
  project: string;
  site: string;
  url: string;
  account: string;
  branch: string;
  head: string;
  deployedAt: string;
}

export interface FirebaseHostingReview extends Omit<FirebaseHostingRelease, "deployedAt"> {
  repository: string;
  pullRequest: string;
  checks: string[];
  token: string;
}

function firebaseCommand(path: string | undefined): [string, string[]] | undefined {
  if (process.platform !== "win32") return ["firebase", []];
  for (const directory of (path ?? "").split(delimiter).map((entry) => entry.replace(/^"(.*)"$/, "$1"))) {
    if (!isAbsolute(directory)) continue;
    const executable = join(directory, "firebase.exe");
    if (existsSync(executable)) return [executable, []];
    if (!existsSync(join(directory, "firebase.cmd"))) continue;
    // npm's Windows shim invokes this module. Run the module directly so values stay separate from shell syntax.
    for (const root of [join(directory, "node_modules"), join(directory, "..")]) {
      const script = join(root, "firebase-tools", "lib", "bin", "firebase.js");
      if (existsSync(script)) return [process.execPath, [script]];
    }
  }
}

async function firebase(args: string[], signal: AbortSignal, cwd?: string, timeout = 20_000): Promise<unknown> {
  // Select an existing CLI account explicitly. Do not inherit the host's credential or endpoint overrides.
  const { PATH, HOME, XDG_CONFIG_HOME, TMPDIR, HTTPS_PROXY, HTTP_PROXY, NO_PROXY,
    USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot } = process.env;
  const command = firebaseCommand(PATH);
  if (!command) throw new Error("Install the Firebase CLI and sign in with firebase login.");
  const [executable, prefix] = command;
  try {
    const { stdout } = await exec(executable, [...prefix, ...args, "--non-interactive", "--json"], {
      cwd, signal, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { PATH, HOME, XDG_CONFIG_HOME, TMPDIR, HTTPS_PROXY, HTTP_PROXY, NO_PROXY,
        USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot, CI: "1" },
    });
    const output = JSON.parse(stdout) as { status?: string; result?: unknown };
    if (output.status !== "success") throw new Error("Firebase did not confirm success");
    return output.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Install the Firebase CLI and sign in with firebase login.");
    if (args[0] === "deploy") throw new Error("Firebase did not confirm the deployment. Check the site’s release history before retrying.");
    throw new Error("Firebase could not read the selected account or site. Check the Firebase CLI sign-in and Hosting access.");
  }
}

async function activeAccount(signal: AbortSignal): Promise<string> {
  const accounts = await firebase(["login:list"], signal) as Array<{ user?: { email?: string } }> | undefined;
  const account = Array.isArray(accounts) ? accounts[0]?.user?.email : undefined;
  if (!account || !/^[^\s@]+@[^\s@]+$/.test(account)) throw new Error("Sign in to Firebase with firebase login before reviewing a deployment.");
  return account;
}

async function confirmSite(project: string, site: string, account: string, signal: AbortSignal) {
  const result = await firebase(["hosting:sites:list", `--project=${project}`, `--account=${account}`], signal) as { sites?: Array<{ name?: string }> } | undefined;
  if (!result?.sites?.some(({ name }) => name === `projects/${project}/sites/${site}` || name?.match(/^projects\/\d+\/sites\//) && name.endsWith(`/sites/${site}`))) {
    throw new Error("The signed-in account could not verify this existing site in the reviewed Firebase project.");
  }
}

async function staticConfig(repo: string, head: string) {
  const read = async (file: string) => JSON.parse(await git(["show", `${head}:${file}`], repo));
  const [configuration, aliases] = await Promise.all([read("firebase.json"), read(".firebaserc")]).catch(() => {
    throw new Error("The reviewed commit needs firebase.json and a default project in .firebaserc.");
  });
  const hosting = configuration?.hosting;
  const project = aliases?.projects?.default;
  if (!hosting || Array.isArray(hosting) || typeof hosting !== "object" || Object.keys(hosting).some((key) => !staticKeys.has(key)) ||
      configuration.predeploy !== undefined || configuration.postdeploy !== undefined ||
      typeof project !== "string" || !identifier.test(project) || typeof hosting.site !== "string" || !identifier.test(hosting.site) ||
      typeof hosting.public !== "string" || !/^(?:\.|(?:\.\/)?[\w-]+(?:\/[\w.-]+)*\/?)$/.test(hosting.public) || hosting.public.split("/").includes("..") ||
      (hosting.ignore !== undefined && (!Array.isArray(hosting.ignore) || hosting.ignore.some((glob: unknown) => typeof glob !== "string" || glob.startsWith("!")))) ||
      (hosting.rewrites !== undefined && (!Array.isArray(hosting.rewrites) || hosting.rewrites.some((rule: Record<string, unknown>) =>
        !rule || typeof rule.destination !== "string" || !rule.destination.startsWith("/") ||
        Object.keys(rule).some((key) => !["source", "regex", "destination"].includes(key)))))) {
    throw new Error("Shipyard can deploy one static Firebase Hosting site with an explicit site ID. Build hooks and service rewrites require a separate workflow.");
  }
  const tree = await git(["ls-tree", "-r", "--full-tree", "-z", head], repo, { raw: true });
  if (tree.split("\0").some((entry) => entry && !/^100(?:644|755) blob /.test(entry))) {
    throw new Error("This release contains symlinks or submodules. Review its publish files through the repository’s deployment workflow.");
  }
  return { project, site: hosting.site as string, hosting: { ...hosting,
    ignore: [...new Set(["firebase.json", "**/.*", "**/.*/**", "**/node_modules/**", ...(hosting.ignore ?? [])])] } };
}

export class FirebaseHostingReleases {
  private readonly active = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string, private readonly signal: AbortSignal) {}

  private runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) throw new Error("A Firebase operation is already running for this release.");
    const pending = operation().finally(() => this.active.delete(key));
    this.active.set(key, pending);
    return pending;
  }

  prepare(run: { id: string; repo: string; pullRequest?: string }, verify: (worktree: string) => Promise<GateRecord[]>): Promise<FirebaseHostingReview> {
    return this.runExclusive(run.id, async () => {
      const repository = await githubOrigin(run.repo);
      const pullRequest = run.pullRequest;
      if (!repository || !pullRequest) throw new Error("Link a merged GitHub pull request before reviewing a Firebase deployment.");
      const [pr, base] = await Promise.all([
        inspectLinkedPullRequest(run.repo, repository, pullRequest, this.signal), draftBase(run.repo, repository, this.signal),
      ]);
      if (pr?.state !== "merged" || pr.base !== base.branch || !pr.mergeCommit || !/^[a-f0-9]{40}$/.test(pr.mergeCommit)) {
        throw new Error("The linked pull request must be merged into the GitHub repository’s default branch.");
      }
      await fetchDraftBase(run.repo, { url: repository }, base.head, this.signal);
      if (!await git(["merge-base", "--is-ancestor", pr.mergeCommit, base.head], run.repo).then(() => true, () => false)) {
        throw new Error("The current base branch no longer contains the linked merge commit.");
      }
      const { project, site } = await staticConfig(run.repo, base.head);
      const account = await activeAccount(this.signal);
      await confirmSite(project, site, account, this.signal);
      const candidate = await detachedWorktree(run.repo, this.root, base.head);
      try {
        const checks = await verify(candidate.worktree);
        const failed = checks.find((gate) => !gateOk(gate));
        if (!checks.length || failed) throw new Error(failed ? `${failed.command} failed on the release commit. ${failed.outputTail.slice(-1200)}` : "Configure a project check before deploying.");
        if (await git(["rev-parse", "HEAD"], candidate.worktree) !== base.head || (await changedFiles(candidate.worktree)).length) {
          throw new Error("Project checks changed the release checkout. Review the checks before deploying.");
        }
        return { ...base, project, site, url: `https://${site}.web.app/`, account, repository, pullRequest,
          checks: checks.map(({ command }) => command), token: randomUUID() };
      } finally { await candidate.close(); }
    });
  }

  deploy(repo: string, review: FirebaseHostingReview): Promise<FirebaseHostingRelease> {
    const { project, site, url, account, branch, head, repository } = review;
    return this.runExclusive(`site/${project}/${site}`, async () => {
      if (await githubOrigin(repo) !== repository) throw new Error("The GitHub repository changed. Review the release again.");
      const base = await draftBase(repo, repository, this.signal);
      if (base.branch !== branch || base.head !== head) throw new Error("The default branch changed after verification. Review the new commit before deploying.");
      const config = await staticConfig(repo, head);
      if (config.project !== project || config.site !== site || await activeAccount(this.signal) !== account) {
        throw new Error("The Firebase destination or account changed. Review the release again.");
      }
      await confirmSite(project, site, account, this.signal);
      const candidate = await detachedWorktree(repo, this.root, head);
      try {
        await writeFile(join(candidate.worktree, "firebase.json"), JSON.stringify({ hosting: config.hosting }));
        const latest = await draftBase(repo, repository, this.signal);
        if (latest.branch !== branch || latest.head !== head) throw new Error("The default branch moved. Review the new commit before deploying.");
        await firebase(["deploy", "--config=firebase.json", `--only=hosting:${site}`, `--project=${project}`, `--account=${account}`],
          this.signal, candidate.worktree, 6 * 60_000);
      } finally { await candidate.close(); }
      return { project, site, url, account, branch, head, deployedAt: new Date().toISOString() };
    });
  }

  async shutdown() {
    await Promise.allSettled(this.active.values());
  }
}
