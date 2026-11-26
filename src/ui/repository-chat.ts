import type { Target } from "../config.ts";
import type { ChatMessage, ChatReply } from "./chat.ts";
import type { HostedRepository } from "./repository-discovery.ts";

export type RepoAction = { kind: "add-repo"; label: string; locator?: string } |
  { kind: "use-target"; label: string; target: string };

type LocalRepo = { name: string; displayPath: string };
type RepositoryAccess = {
  local: () => LocalRepo[];
  hosted: (site: URL, owner?: string) => Promise<HostedRepository[]>;
  clone: (url: string) => Promise<{ displayPath: string; existingName?: string }>;
};
type RepositoryReply = ChatReply & { needsResearch?: true };

const URL_IN_MESSAGE = /(?:https?:\/\/|ssh:\/\/)[^\s<>"`]+|\b[\w.-]+@[\w.-]+:[\w./~+-]+/gi;
const LOCAL_PATH = /(?:["`])((?:[a-z]:[\\/]|[~.]?[\\/])[^"`\r\n]+)["`]|(?:^|\s)((?:[a-z]:[\\/]|[~.]?[\\/])\S+)/i;
const INTENT = /^(?:(?:please|can you|could you|i want to|i need to|let['’]s)\s+)*(?:clone\b|(?:add|import|open|use|find|register|connect|attach|set up|switch to)\s+(?:(?:a|the|my|this|our|an?)\s+)?(?:[\w.-]+\s+)?(?:repo(?:sitory)?|checkout|git folder)\b)/i;
const BEFORE_LOCATOR = /^(?:(?:please|can you|could you|i want to|i need to|let['’]s)\s+)*(?:add|import|open|use|find|register|connect|attach|set up|switch to)(?:\s+from)?[\s:"`]*$/i;
const FIND_SOURCE = /^(?:please\s+)?(?:find|locate|identify|look up|discover)\s+(?:(?:its|the|a|my|this)\s+)?(?:(?:source|[\w.-]+)\s+)?(?:source|repo(?:sitory)?|git checkout)\b/i;
const CLONE_REQUEST = /^(?:(?:please|can you|could you|i want to|i need to)\s+)*clone\b|\b(?:and|then)\s+(?:please\s+)?clone\b/i;
const GITHUB_ACCOUNT = /^https:\/\/(?:www\.)?github\.com\/(?:orgs\/)?([a-z0-9][a-z0-9-]{0,38})\/?(?:[?#].*)?$/i;
const HOSTING = /(?:^|\.)(?:web\.app|firebaseapp\.com|github\.io|gitlab\.io|netlify\.app|vercel\.app|pages\.dev|onrender\.com|herokuapp\.com|azurewebsites\.net|amplifyapp\.com|run\.app)$/i;

export function isHostedProjectUrl(value: string): boolean {
  try { return HOSTING.test(new URL(value).hostname); }
  catch { return false; }
}

function gitLocator(value: string): string | undefined {
  if (/^[\w.-]+@[\w.-]+:\/?[\w.-][\w./~+-]*$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.password || (url.protocol === "https:" && url.username)) return;
  if (url.protocol === "ssh:" && url.pathname.length > 1 && !url.search && !url.hash) return value;
  if (url.protocol !== "https:" || isHostedProjectUrl(value)) return;
  const parts = url.pathname.split("/").filter(Boolean);
  if ((url.hostname === "github.com" || url.hostname === "bitbucket.org") && !url.port && parts.length >= 2 &&
      parts.slice(0, 2).every((part) => /^[\w.-]+$/.test(part)) && !["topics", "orgs", "users", "settings", "marketplace", "sponsors", "search", "features"].includes(parts[0]!.toLowerCase())) {
    return `${url.origin}/${parts[0]}/${parts[1]!.replace(/\.git$/i, "")}.git`;
  }
  if (url.hostname === "gitlab.com" && !url.port && parts.length >= 2) {
    const divider = parts.indexOf("-");
    const repo = divider >= 2 ? parts.slice(0, divider) : parts;
    if (repo.every((part) => /^[\w.-]+$/.test(part))) return `${url.origin}/${repo.join("/").replace(/\.git$/i, "")}.git`;
  }
  if (/\.git\/?$/i.test(url.pathname) && !url.search && !url.hash) return value;
}

const normalize = (value: string) => value.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function repositoryChat(messages: ChatMessage[], targets: Target[], access?: RepositoryAccess): Promise<RepositoryReply | undefined> {
  const request = messages.at(-1)!.content;
  const previous = messages.slice(0, -1).findLast(({ role }) => role === "user")?.content ?? "";
  const urls = [...new Set([...request.matchAll(URL_IN_MESSAGE)].map(([url]) => url!.replace(/[),.;!?\]}]+$/, "")))];
  const userGithub = urls.map((url) => url.match(GITHUB_ACCOUNT)?.[1]).find(Boolean);
  const followUpClone = !urls.length && /^(?:please\s+)?clone\s+(?:it|this|that|the (?:source )?repo(?:sitory)?)[.!]?$/i.test(request);
  const earlierSite = (userGithub || followUpClone) && [...previous.matchAll(URL_IN_MESSAGE)].map(([url]) => url!).find(isHostedProjectUrl);
  const hosted = urls.find(isHostedProjectUrl) ?? earlierSite;
  const actionText = request.replace(URL_IN_MESSAGE, " ").replace(/^[\s\p{P}]+/u, "").trim();
  const hostedIntent = hosted && (earlierSite || FIND_SOURCE.test(actionText) || CLONE_REQUEST.test(actionText));
  const pathMatch = urls.length ? null : request.match(LOCAL_PATH);
  const path = pathMatch?.[1] ?? pathMatch?.[2]?.replace(/[),.;!?\]}]+$/, "");
  const direct = urls.length === 1 && request === urls[0];
  const directPath = path && [path, `"${path}"`, `\`${path}\``].includes(request);
  const locator = urls[0] ?? path;
  const locatorIntent = locator && BEFORE_LOCATOR.test(request.slice(0, request.indexOf(locator)));
  const named = request.match(/\b(?:clone|use|open|add|find)\s+(?:(?:a|the|my|this|our)\s+)?([\w.-]+)\s+(?:repo(?:sitory)?|checkout)\b/i)?.[1];
  const shorthand = !urls.length && !path ? request.match(/^(?:(?:please\s+)?(?:clone|add|use)\s+)?(?:github[:\s]+)?([\w.-]+\/[\w.-]+?)(?:\s+from github)?[.!]?$/i)?.[1] : undefined;
  const followUp = INTENT.test(previous) && (direct || shorthand);
  if (!urls.length && !path && /\buse (?:the )?(?:selected|current|configured) repo(?:sitory)?\b/i.test(request)) return;
  if (!INTENT.test(request) && !hostedIntent && !locatorIntent && !directPath && !followUp && !(shorthand && /\b(?:clone|github)\b/i.test(request)) && !(direct && gitLocator(urls[0]!))) return;

  const actions: RepoAction[] = [];
  const add = (label: string, locator?: string) => { if (access) actions.push({ kind: "add-repo", label, locator }); };
  const reply = (text: string, needsResearch?: true): RepositoryReply => ({ text, options: [], repoActions: actions, ...(needsResearch ? { needsResearch } : {}) });
  const remotes = urls.filter((url) => !(hosted && GITHUB_ACCOUNT.test(url) && /^https:\/\/(?:www\.)?github\.com\/orgs\//i.test(url)))
    .map(gitLocator).filter((url): url is string => Boolean(url));
  if (shorthand && !remotes.length) remotes.push(`https://github.com/${shorthand.replace(/\.git$/i, "")}.git`);
  if (remotes.length) {
    for (const locator of remotes.slice(0, 3)) add(remotes.length === 1 ? "Review clone setup" : `Review ${locator.split(/[/:]/).at(-1)!.replace(/\.git$/i, "")}`, locator);
    return reply(access ? "Choose a repository to review the clone. After cloning, Shipyard will help you confirm the project’s test commands." :
      "Repository setup is available in the standard Shipyard dashboard. This demo uses its bundled repository.");
  }
  if (path) {
    add("Inspect local checkout", path);
    return reply(access ? "Open the setup to check this folder and review the test commands Shipyard finds." :
      "Local repository setup is available in the standard Shipyard dashboard.");
  }
  if (hosted && access) {
    const candidates = await access.hosted(new URL(hosted), userGithub);
    const verified = candidates.filter((candidate) => candidate.evidence);
    if (verified.length === 1) {
      const { repository, evidence } = verified[0]!;
      const name = new URL(repository).pathname.slice(1);
      const source = `I verified [${name}](${repository}) as the source because ${evidence}.`;
      const clone = CLONE_REQUEST.test(actionText) && !/\b(?:don['’]t|do not|never|without|avoid|skip|hold off on)\s+(?:[\w-]+\s+){0,2}clon\w*|\bclone\b.{0,20}\b(?:later|not yet|after i|after you ask)\b/i.test(actionText);
      if (clone) {
        try {
          const checkout = await access.clone(`${repository}.git`);
          if (checkout.existingName) {
            actions.push({ kind: "use-target", label: `Use ${checkout.existingName}`, target: checkout.existingName });
            return reply(`${source} The checkout is already configured in Shipyard.`);
          }
          add("Review repository setup", checkout.displayPath);
          return reply(`${source} The repo is cloned at \`${checkout.displayPath}\`. Review its detected test commands to add it to Shipyard.`);
        } catch (error) {
          add("Review clone setup", `${repository}.git`);
          return reply(`${source} ${error instanceof Error ? error.message : "The clone failed."}`);
        }
      }
      add("Review clone setup", `${repository}.git`);
      return reply(source);
    }
    if (candidates.length) {
      const options = (verified.length > 1 ? verified : candidates).slice(0, 3);
      for (const { repository } of options) add(`Review ${new URL(repository).pathname.slice(1)}`, `${repository}.git`);
      return verified.length > 1 ? reply("Several repositories point to this deployment. Choose the source repository to clone.") :
        reply("I found these potential source repositories. Choose one to review its clone setup.", true);
    }
  }
  const hostName = hosted ? new URL(hosted).hostname.split(".")[0] : undefined;
  const hints = [named, hostName].filter((value): value is string => Boolean(value)).map(normalize);
  const matches = (name: string) => hints.some((hint) => hint === normalize(name) ||
    (normalize(name).length >= 5 && hint.endsWith(`-${normalize(name)}`)));
  for (const target of targets.filter(({ name }) => matches(name)).slice(0, 3)) actions.push({ kind: "use-target", label: `Use ${target.name}`, target: target.name });
  if (hints.length && access && actions.length < 3) {
    for (const repo of access.local().filter(({ name }) => matches(name)).slice(0, 3 - actions.length)) add(`Inspect ${repo.name}`, repo.displayPath);
  }
  add("Choose a local repo or enter a Git URL");
  if (hosted) return reply("That link opens a deployed website. I couldn’t verify its source from the available GitHub metadata. Choose a local checkout, paste a Git clone URL, or share the GitHub account or organization that owns it.",
    access && !actions.some(({ kind, label }) => kind === "use-target" || label.startsWith("Inspect ")) ? true : undefined);
  if (urls.length) return reply("I couldn’t identify a Git repository from that link. Paste the repository’s HTTPS or SSH clone URL from its Clone or Code menu, or choose a local Git checkout.");
  if (actions.some(({ kind, label }) => kind === "use-target" || label.startsWith("Inspect "))) return reply("I found a possible repository match. Choose it below, or paste a Git clone URL if you meant a different project.");
  return reply("Which repository should Shipyard use? Paste an HTTPS or SSH clone URL, a GitHub owner/repository, or the path to a local Git checkout.");
}
