import type { AttachmentSource } from "./attachments.ts";

export interface ReferenceCheck {
  url?: string;
  label?: string;
  status: "read" | "partial" | "blocked" | "permission-required";
  detail: string;
  content?: string;
  shared?: boolean;
  browserHelpSkipped?: boolean;
  coverage?: string[];
  missing?: string[];
  attachments?: AttachmentSource;
}

export interface ReviewedReference {
  text: string;
  coverage?: string[];
  missing?: string[];
  attachments?: AttachmentSource;
}

export type ReferenceReview = ReviewedReference | { blocked: string };

export function sharedReference(url: string, notes: ReviewedReference): ReferenceCheck {
  const { text, coverage, missing, attachments } = notes;
  const incomplete = Boolean(missing?.length) || (url.startsWith("https://www.linkedin.com/") && (!coverage?.length || !missing));
  return { url, status: incomplete ? "partial" : "read", shared: true, coverage, missing, attachments,
    detail: incomplete ? "Reviewed notes are available, but coverage is incomplete or unverified." : "Reference text reviewed and approved by you.",
    content: text.trim() };
}

export function validReferenceText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 24000 && Boolean(value.trim());
}

export const MAX_PUBLIC_REFERENCES = 8;

/** Canonical public links only. Discard fragments and query strings, which can contain credentials. */
function publicReference(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
    if (["github.com", "www.github.com"].includes(url.hostname) && parts.length <= 2 &&
      /^[a-z0-9][a-z0-9-]{0,38}$/i.test(parts[0] ?? "") && (parts.length === 1 || /^[a-z0-9_.-]{1,100}$/i.test(parts[1] ?? ""))) {
      return new URL(`https://github.com/${parts.join("/").toLowerCase()}`);
    }
    if (["linkedin.com", "www.linkedin.com"].includes(url.hostname) && (parts.length === 2 ||
        (parts.length === 4 && parts[2] === "details" && /^[a-z-]+$/i.test(parts[3] ?? ""))) &&
      parts[0] === "in" && /^[a-z0-9_-]{1,150}$/i.test(parts[1] ?? "")) {
      return new URL(`https://www.linkedin.com/in/${parts[1]}`);
    }
  } catch { /* Not a supported reference URL. */ }
}

export function parseReferencePermissions(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_PUBLIC_REFERENCES || input.some((entry) => typeof entry !== "string")) {
    throw new Error("Enter up to eight GitHub or LinkedIn reference links.");
  }
  const urls = input.map((value: string) => publicReference(value.trim())?.href);
  if (urls.some((url) => !url)) throw new Error("Use HTTPS links to a GitHub profile or repository, or a LinkedIn profile.");
  return [...new Set(urls as string[])];
}

export function referenceLinks(request: string): string[] {
  const urls = new Set<string>();
  for (const match of request.matchAll(/https:\/\/(?:www\.)?(?:github\.com|linkedin\.com)\/[\w./-]+/gi)) {
    const url = publicReference(match[0].replace(/[./]+$/, ""));
    if (url) urls.add(url.href);
  }
  return [...urls];
}

export function missingReferencePermissions(request: string, allowed: readonly string[]): ReferenceCheck[] {
  const urls = referenceLinks(request).filter((url) => !allowed.includes(url));
  const checks: ReferenceCheck[] = urls.slice(0, MAX_PUBLIC_REFERENCES).map((url) => ({ url, status: "permission-required", detail: "Approve this URL to let Shipyard read it." }));
  for (const [label, pattern, host] of [
    ["GitHub profile", /\bmy\s+github\s+(?:profile|page)\b/i, "https://github.com/"],
    ["LinkedIn profile", /\b(?:my|your)\s+linkedin\b|\blinkedin\s+profile\b|\bthe\s+linkedin(?=[.!?]|$)/i, "https://www.linkedin.com/"],
  ] as const) {
    if (pattern.test(request) && ![...allowed, ...urls].some((url) => url.startsWith(host))) {
      checks.push({ label, status: "permission-required", detail: `Include your ${label} URL in your request.` });
    }
  }
  return checks;
}

export async function readPublicReference(link: string, signal?: AbortSignal): Promise<ReferenceCheck> {
  const url = publicReference(link);
  if (!url) throw new Error("Unsupported public reference URL");
  const timeout = AbortSignal.timeout(10_000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const reading = url.hostname === "github.com" ? await readGitHub(url, stop) : await readLinkedIn(url, stop);
    return { url: url.href, ...reading };
  } catch (error) {
    signal?.throwIfAborted();
    return { url: url.href, status: "blocked", detail: timeout.aborted ? "The public site timed out." : error instanceof Error ? error.message : "The public site could not be read." };
  }
}

async function readGitHub(url: URL, signal: AbortSignal): Promise<Omit<ReferenceCheck, "url">> {
  const [owner, repo] = url.pathname.slice(1).split("/");
  const get = async (path: string, accept = "application/vnd.github+json") => {
    const response = await fetch(`https://api.github.com${path}`, {
      signal, redirect: "manual", headers: { accept, "user-agent": "Shipyard public references" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 429) throw new Error(`GitHub limited public access (HTTP ${response.status}).`);
      if (response.status === 404) throw new Error("GitHub did not expose this profile or repository publicly.");
      throw new Error(`GitHub returned HTTP ${response.status}.`);
    }
    return response;
  };
  const fields = (item: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.flatMap((key) => typeof item[key] === "string" ? [[key, (item[key] as string).slice(0, 700)]] : []));
  const repoKeys = ["full_name", "description", "language", "html_url", "homepage"];
  const root = repo ? `/repos/${owner}/${repo}` : `/users/${owner}`;
  const data = JSON.parse(await boundedText(await get(root), 100_000));
  const lines = [JSON.stringify(fields(data, repo ? repoKeys : ["login", "name", "bio", "blog", "company", "location"]))];
  const listing = repo ? undefined : await get(`/users/${owner}/repos?type=owner&sort=pushed&per_page=12`)
    .then(async (response) => JSON.parse(await boundedText(response, 220_000)) as Record<string, unknown>[])
    .catch(() => undefined);
  if (listing?.length) lines.push("Recent public repositories:", ...listing.slice(0, 12).map((item) => JSON.stringify(fields(item, repoKeys))));
  const readme = await get(`/repos/${owner}/${repo ?? owner}/readme`, "application/vnd.github.raw+json")
    .then((response) => boundedText(response, 4000)).catch(() => "");
  if (readme.trim()) lines.push("Public README:", readme.trim());
  const partial = !repo && listing === undefined;
  return {
    status: partial ? "partial" : "read", content: lines.join("\n").slice(0, 8000),
    detail: partial ? "GitHub profile read. The public repository list was unavailable." : `Read the public GitHub ${repo ? "repository" : "profile"}.`,
  };
}

async function readLinkedIn(url: URL, signal: AbortSignal): Promise<Omit<ReferenceCheck, "url">> {
  const response = await fetch(url, { signal, redirect: "manual", headers: { accept: "text/html", "user-agent": "Shipyard public references" } });
  if (!response.ok) {
    const redirect = response.headers.get("location") ?? "";
    await response.body?.cancel();
    if (/login|sign.in|authwall|checkpoint/i.test(redirect) || [401, 403, 999].includes(response.status)) {
      throw new Error("LinkedIn requires sign-in or blocks public access to this profile.");
    }
    throw new Error(`LinkedIn returned HTTP ${response.status}.`);
  }
  const html = await boundedText(response, 700_000);
  const readable = (value: string) => value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:h[1-6]|li|p|div)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&nbsp;": " " })[entity] ?? entity)
    .split("\n").map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n");
  const metadata = [...html.matchAll(/<meta\b[^>]+>/gi)].flatMap(([tag]) => {
    if (!/\b(?:name|property)=["'](?:og:title|og:description|description)["']/i.test(tag)) return [];
    const value = tag.match(/\bcontent=(?:"([^"]*)"|'([^']*)')/i);
    return value ? [readable(value[1] ?? value[2] ?? "")] : [];
  }).filter((value) => value && !/^(?:log in|sign in|join linkedin|sign up|linkedin login)\b/i.test(value));
  const sections = new Map<string, string>();
  for (const [, body] of html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi)) {
    const heading = readable(body?.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "");
    if (!/^(?:about|experience|education|projects|skills|licenses\s*(?:&|and)\s*certifications|volunteering|publications|honors\s*(?:&|and)\s*awards|languages)$/i.test(heading)) continue;
    const content = readable(body ?? "");
    if (content.length > heading.length) sections.set(heading, content);
  }
  if (!metadata.length && !sections.size) {
    throw new Error("LinkedIn did not expose public profile text.");
  }
  return {
    status: "partial",
    detail: sections.size ? "LinkedIn exposed some public profile sections. Use the browser handoff to check for hidden or expanded entries."
      : "LinkedIn exposed only public profile metadata. Use the browser handoff to read the profile sections.",
    coverage: [...(metadata.length ? ["Public title and description"] : []), ...sections.keys()],
    content: [...new Set(metadata), ...sections.values()].join("\n\n").slice(0, 16000),
  };
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
    return text.slice(0, limit);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
