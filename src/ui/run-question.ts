import { extname, matchesGlob } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { git } from "../exec.ts";
import { readPublicPage } from "../public-web.ts";

import type { DeploymentProvider } from "../config.ts";

export type DeployAction = `${DeploymentProvider}-release`;
export type RunQuestionAction = "deployment" | "draft-pr" | "cloud-release" | DeployAction | "budget" | "checks" | "preview" | "revision";

export interface RunAnswer {
  heading: string;
  details: string[];
  links?: Array<{ label: string; url: string }>;
  actions?: Array<{ label: string; action: RunQuestionAction }>;
  review?: DeployAction;
}

export function requestedDeploymentProviders(question: string): DeploymentProvider[] {
  const patterns = { aws: /\b(?:aws|amazon web services)\b/i, azure: /\bazure\b/i, firebase: /\bfirebase\b/i };
  return (Object.keys(patterns) as DeploymentProvider[]).filter((provider) => patterns[provider].test(question));
}

export function runQuestionKind(question: string) {
  const text = question.toLowerCase();
  if (/\bdeploy\s+(?:it|this|now|the|from|to|on|via|using|main|aws|azure|firebase)\b|\bdeploy[.!]?\s*$|\brelease\s+(?:it\s+)?to\s+(?:aws|azure|firebase)\b/.test(text) &&
    !/\b(?:don't|don’t|do not|never|not to)\s+(?:deploy|release)\b/.test(text)) return "deploy-request";
  if (/\b(?:deploy\w*|production|live site|is it live|firebase|aws|azure|cloud run|release)\b/.test(text)) return "deployment";
  if (/\b(?:pull request|pr|merg\w*|github|push\w*)\b/.test(text)) return "publication";
  if (/\b(?:test\w*|checks?|e2e|verification|fail\w*)\b/.test(text)) return "checks";
  if (/\b(?:diff|changed|what did|delivered|files)\b/.test(text)) return "changes";
  if (/\b(?:next|options?|what (?:now|to do|should)|ready|status|budget|stopped|continue|resume)\b/.test(text)) return "next";
  return "unknown";
}

/** Compare changed, tracked static files against an explicitly configured Firebase Hosting site. */
export async function checkFirebaseHosting(repo: string, head: string, files: string[], signal: AbortSignal) {
  const contents = await git(["show", `${head}:firebase.json`], repo).catch(() => "");
  if (!contents) return;
  let hosting: { site?: unknown; public?: unknown; ignore?: unknown } | undefined;
  try { hosting = JSON.parse(contents)?.hosting; } catch { return; }
  if (!hosting || Array.isArray(hosting) || typeof hosting.site !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(hosting.site) ||
      typeof hosting.public !== "string") return;
  const directory = hosting.public.replace(/^\.\//, "").replace(/\/$/, "");
  if (directory.startsWith("/") || directory.split("/").includes("..") || directory.includes("\\")) return;
  const prefix = directory && directory !== "." ? directory + "/" : "";
  const url = `https://${hosting.site}.web.app/`;
  const ignores = Array.isArray(hosting.ignore) ? hosting.ignore.filter((pattern): pattern is string => typeof pattern === "string") : [];
  const candidates = [...new Set(files)].filter((file) => {
    if (!file.startsWith(prefix) || file === "firebase.json") return false;
    const path = file.slice(prefix.length);
    return !path.split("/").some((part) => !part || part.startsWith(".")) &&
      !/^(?:test|tests|e2e|docs|node_modules)\//.test(path) && !/^(?:package(?:-lock)?\.json)$/.test(path) &&
      /^(?:\.html?|\.json|\.css|\.m?js|\.svg|\.txt)$/.test(extname(path)) &&
      !ignores.some((pattern) => matchesGlob(path, pattern));
  });
  const probes = candidates.slice(0, 8);
  const checks = await Promise.all(probes.map(async (file) => {
    const path = file.slice(prefix.length);
    const remotePath = path === "index.html" ? "" : path.split("/").map(encodeURIComponent).join("/");
    const local = await git(["show", `${head}:${file}`], repo, { raw: true }).catch(() => undefined);
    if (local === undefined) return { path, status: "unknown" } as const;
    try {
      const live = await readPublicPage(url + remotePath, signal, true);
      if (new URL(live.url).origin !== new URL(url).origin || live.truncated) return { path, status: "unknown" } as const;
      let matches = live.text.trim() === local.trim();
      if (!matches && extname(path) === ".json") {
        try { matches = isDeepStrictEqual(JSON.parse(local), JSON.parse(live.text)); } catch { /* Compare as text. */ }
      }
      return { path, status: matches ? "matches" : "different" } as const;
    } catch (error) {
      return { path, status: error instanceof Error && /HTTP 404\./.test(error.message) ? "different" : "unknown" } as const;
    }
  }));
  return { url, checks, partial: candidates.length > probes.length };
}
