#!/usr/bin/env node
// Publish guard. Agents may build and test, but anything that leaves this
// machine (push, publish, release, PR) needs a human. Set
// SHIPYARD_ALLOW_PUBLISH=1 for a session where you have approved it.
//
// Used two ways from this one file:
//  - as a Claude Code PreToolUse hook (reads the hook JSON on stdin, exits 2 to block)
//  - imported by the pipeline runner (src/guards.ts) as checkCommand()

import { pathToFileURL } from "node:url";

/** @type {Array<{ pattern: RegExp, reason: string }>} */
export const PUBLISH_RULES = [
  // Allows global options before the subcommand, e.g. `git -C repo push`.
  { pattern: /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|-\S+\s+)*push\b/, reason: "git push" },
  { pattern: /\b(?:npm|pnpm|bun)\s+publish\b/, reason: "package publish" },
  { pattern: /\byarn\s+(?:npm\s+)?publish\b/, reason: "package publish" },
  { pattern: /\b(?:twine\s+upload|cargo\s+publish|gem\s+push)\b/, reason: "package publish" },
  { pattern: /\bgh\s+(?:pr\s+(?:create|merge)|release\s+create|repo\s+create)\b/, reason: "GitHub write" },
  { pattern: /\b(?:vercel|netlify|fly|firebase)\b.*\bdeploy\b|\bvercel\s+--prod\b/, reason: "deploy" },
  { pattern: /\bgcloud\b[^\n;|&]*\b(?:deploy|submit|update-traffic|services\s+(?:update|replace|delete|add-iam-policy-binding|set-iam-policy))\b/, reason: "Google Cloud release" },
];

/** Always blocked, even with SHIPYARD_ALLOW_PUBLISH=1. */
export const DESTRUCTIVE_RULES = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(?:\/|~|\$HOME)(?:\s|$)/, reason: "recursive delete of / or home" },
  { pattern: /\bgit\s+reset\s+--hard\s+origin\b/, reason: "hard reset to remote" },
  { pattern: /\bgit\s+push\b.*(?:--force|-f\b)/, reason: "force push" },
];

/**
 * @param {string} command
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ blocked: false } | { blocked: true, reason: string }}
 */
export function checkCommand(command, env = process.env) {
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(command)) {
      return { blocked: true, reason: `Blocked by shipyard guard: ${rule.reason} is never allowed for agents.` };
    }
  }
  if (env.SHIPYARD_ALLOW_PUBLISH === "1") return { blocked: false };
  for (const rule of PUBLISH_RULES) {
    if (rule.pattern.test(command)) {
      return {
        blocked: true,
        reason: `Blocked by shipyard guard: ${rule.reason} needs human approval. Stop and report that the work is ready to publish instead.`,
      };
    }
  }
  return { blocked: false };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const input = JSON.parse(await readStdin());
    const command = input?.tool_input?.command;
    if (typeof command === "string") {
      const verdict = checkCommand(command);
      if (verdict.blocked) {
        process.stderr.write(verdict.reason + "\n");
        process.exit(2); // exit code 2 = block the tool call, stderr goes to Claude
      }
    }
  } catch {
    // Malformed input: do not block normal work.
  }
  process.exit(0);
}
