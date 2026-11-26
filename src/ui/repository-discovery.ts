import { boundedText } from "../references.ts";
import { SHIPYARD_ROOT } from "../config.ts";
import { githubApi } from "./publication.ts";

export interface HostedRepository {
  repository: string;
  evidence?: string;
}

type GitHubRepository = { full_name: string; homepage?: string | null };
const GITHUB_NAME = /^[a-z0-9][a-z0-9-]{0,38}\/[\w.-]{1,100}$/i;
const GITHUB_LINK = /https:\/\/(?:www\.)?github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([\w.-]{1,100})(?=[/?#\s"'<>]|$)/gi;

function homepageMatches(homepage: string, site: URL): boolean {
  try {
    const url = new URL(homepage);
    if (url.hostname !== site.hostname || url.port || url.username || url.password) return false;
    if (!site.hostname.endsWith(".github.io")) return true;
    return url.pathname.split("/")[1]?.toLowerCase() === site.pathname.split("/")[1]?.toLowerCase();
  } catch { return false; }
}

const tokens = (value: string) => value.toLowerCase().replace(/portafolio/g, "portfolio").split(/[^a-z0-9]+/).filter(Boolean);

function nameScore(name: string, site: URL): number {
  const slash = name.indexOf("/");
  const owner = name.slice(0, slash).toLowerCase();
  const slug = site.hostname.split(".")[0] ?? "";
  const repo = name.slice(slash + 1).toLowerCase();
  if (site.hostname === `${owner}.github.io` && (site.pathname.split("/")[1]?.toLowerCase() || `${owner}.github.io`) === repo) return 12;
  const suffix = slug.startsWith(`${owner}-`) ? slug.slice(owner.length + 1) : slug;
  const parts = tokens(repo);
  const hints = tokens(suffix);
  if (!hints.length || !hints.every((part) => parts.includes(part))) return repo === slug ? 9 : 0;
  return (repo === slug ? 9 : 0) + (slug.startsWith(`${owner}-`) ? 5 : 0) + (parts.length === hints.length ? 3 : 0) + 1;
}

function firebaseSite(config: string, site: URL): boolean {
  const project = site.hostname.match(/^([a-z0-9-]+)\.(?:web\.app|firebaseapp\.com)$/)?.[1];
  if (!project) return false;
  const json = JSON.parse(config) as { hosting?: { site?: unknown } | Array<{ site?: unknown }> };
  return (Array.isArray(json.hosting) ? json.hosting : [json.hosting]).some((hosting) => hosting?.site === project);
}

async function siteLinks(site: URL, signal: AbortSignal): Promise<string[]> {
  if (site.protocol !== "https:" || site.port || site.username || site.password) return [];
  const root = new URL(site.origin);
  if (site.hostname.endsWith(".github.io")) root.pathname = `/${site.pathname.split("/")[1] ?? ""}/`;
  const response = await fetch(root, { signal, redirect: "manual", headers: { accept: "text/html", "user-agent": "Shipyard repository discovery" } });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    await response.body?.cancel();
    return [];
  }
  const html = await boundedText(response, 256_000);
  return [...new Set([...html.matchAll(GITHUB_LINK)].map(([, owner, name]) => `${owner}/${name!.replace(/\.git$/i, "")}`))].slice(0, 20);
}

/** Read-only discovery using the public site and the user's existing GitHub CLI session. */
export async function findHostedRepositories(site: URL, disconnected: AbortSignal, owner?: string): Promise<HostedRepository[]> {
  const signal = AbortSignal.any([disconnected, AbortSignal.timeout(12_000)]);
  const api = githubApi(SHIPYARD_ROOT, signal, 7_000);
  const list = async (endpoint: string): Promise<GitHubRepository[]> => {
    const output = await api(endpoint, "--method", "GET", "--jq", "[.[] | {full_name,homepage}]");
    return JSON.parse(output) as GitHubRepository[];
  };
  const firstPage = "user/repos?per_page=100&sort=pushed&affiliation=owner";
  const inferredOwner = site.hostname.endsWith(".github.io") ? site.hostname.split(".")[0] : site.hostname.split(".")[0]?.split("-")[0];
  const publicOwner = owner ?? (inferredOwner && inferredOwner.length >= 3 ? inferredOwner : undefined);
  const [links, account, ownerRepos] = await Promise.all([
    siteLinks(site, AbortSignal.any([signal, AbortSignal.timeout(4_000)])).catch(() => []),
    list(firstPage).then(async (first) => first.length < 100 ? first : [...first, ...await list(`${firstPage}&page=2`).catch(() => [])]).catch(() => []),
    publicOwner && /^[a-z0-9][a-z0-9-]{0,38}$/i.test(publicOwner) ?
      list(`${owner ? "orgs" : "users"}/${publicOwner}/repos?per_page=100&sort=pushed`).catch(() =>
        owner ? list(`users/${publicOwner}/repos?per_page=100&sort=pushed`).catch(() => []) : []) : [],
  ]);
  const candidates = new Map<string, { name: string; score: number; homepage?: string }>();
  const add = (name: string, score: number, homepage?: string) => {
    if (!GITHUB_NAME.test(name) || /\/\.{1,2}$/.test(name)) return;
    const key = name.toLowerCase();
    const previous = candidates.get(key);
    candidates.set(key, { name, score: Math.max(score, previous?.score ?? 0), homepage: homepage ?? previous?.homepage });
  };
  const repositories = [...account, ...ownerRepos].filter((repo) => typeof repo.full_name === "string" && (!owner || repo.full_name.toLowerCase().startsWith(`${owner.toLowerCase()}/`)));
  for (const repo of repositories) {
    if (typeof repo.full_name !== "string") continue;
    const homepage = typeof repo.homepage === "string" && homepageMatches(repo.homepage, site) ? repo.homepage : undefined;
    const score = nameScore(repo.full_name, site);
    if (homepage || score) add(repo.full_name, homepage ? 100 : score, homepage);
  }
  for (const name of links) if (!owner || name.toLowerCase().startsWith(`${owner.toLowerCase()}/`)) add(name, nameScore(name, site) + 1);
  if (!owner && site.hostname.endsWith(".github.io")) {
    const owner = site.hostname.split(".")[0];
    add(`${owner}/${site.pathname.split("/")[1] || site.hostname}`, 12);
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  const results = await Promise.all(ranked.map(async ({ name, score, homepage }): Promise<HostedRepository | undefined> => {
    const repository = `https://github.com/${name}`;
    const endpoint = `repos/${name}`;
    if (site.hostname.endsWith(".web.app") || site.hostname.endsWith(".firebaseapp.com")) {
      const config = await api(`${endpoint}/contents/firebase.json`, "--method", "GET", "-H", "Accept: application/vnd.github.raw+json").catch(() => "");
      try {
        if (config && firebaseSite(config, site)) return { repository, evidence: "firebase.json names this exact Firebase Hosting site" };
      } catch { /* An unavailable manifest is not evidence. */ }
    }
    if (homepage) return { repository, evidence: "the GitHub repository’s homepage matches the deployment" };
    if (site.hostname.endsWith(".github.io") && score >= 12) {
      const pages = await api(`${endpoint}/pages`, "--method", "GET", "--jq", ".html_url").catch(() => "");
      if (pages && homepageMatches(pages, site)) return { repository, evidence: "GitHub Pages lists this exact deployment" };
    }
    if (score < 4) return;
    // A name match is a lead. Only verified repository metadata can trigger cloning.
    const exists = repositories.some((repo) => repo.full_name.toLowerCase() === name.toLowerCase()) ||
      await api(endpoint, "--method", "GET", "--jq", ".full_name").then((found) => found.toLowerCase() === name.toLowerCase(), () => false);
    if (exists) return { repository };
  }));
  disconnected.throwIfAborted();
  return results.filter((result): result is HostedRepository => Boolean(result));
}
