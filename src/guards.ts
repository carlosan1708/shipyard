import { isAbsolute, relative, resolve } from "node:path";
// One implementation of the publish guard, shared with the Claude Code plugin hook.
import { checkCommand } from "../plugins/shipyard/hooks/guard-publish.mjs";

export { checkCommand };

/**
 * A lane limits which files a role may write.
 * - any: anything inside the worktree (implementers)
 * - tests: only test files (the E2E tester)
 * - no-e2e: anything except E2E tests (UI/UX design and implementer repairs preserve existing E2E tests)
 * - none: nothing at all (planner, reviewer)
 * - docs: documentation only (docs writer)
 * - release: version fields, lockfiles, changelog and release notes (release manager)
 */
export type Lane = "any" | "tests" | "no-e2e" | "none" | "docs" | "release";

const TEST_PATH = /(^|\/)(e2e|tests?|__tests__|spec)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;
const E2E_PATH = /(^|\/)e2e\/|\.e2e\.[cm]?[jt]sx?$/;
const DOCS_PATH = /(^|\/)docs?\/|\.(md|mdx|markdown|rst|adoc)$|(^|\/)(README|CHANGELOG|CONTRIBUTING|HISTORY)(\.[a-z]+)?$/i;
const RELEASE_PATH =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|setup\.cfg|setup\.py|Cargo\.toml|Cargo\.lock|VERSION|version\.txt)$|(^|\/)(CHANGELOG|HISTORY|RELEASE[_-]?NOTES)(\.[a-z]+)?$/i;

export const isTestPath = (rel: string): boolean => TEST_PATH.test(rel);
export const isE2EPath = (rel: string): boolean => E2E_PATH.test(rel);

export function inLane(rel: string, lane: Lane): boolean {
  switch (lane) {
    case "tests":
      return isTestPath(rel);
    case "no-e2e":
      return !isE2EPath(rel);
    case "none":
      return false;
    case "docs":
      return DOCS_PATH.test(rel);
    case "release":
      return RELEASE_PATH.test(rel);
    default:
      return true;
  }
}

const LANE_WORDS: Record<Lane, string> = {
  any: "any file",
  tests: "test files only",
  "no-e2e": "anything except E2E tests",
  none: "no files (your role is read-only)",
  docs: "documentation files only (Markdown, docs/, the changelog)",
  release: "version files, lockfiles, the changelog and release notes only",
};

/** Path relative to root, or null when the path escapes root. */
export function relativeInside(root: string, filePath: string): string | null {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

const WRITE_TOOLS: Record<string, string> = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/** Decide whether an agent's tool call may run. Used as a PreToolUse hook in the pipeline. */
export function checkToolUse(toolName: string, input: unknown, opts: { root: string; lane: Lane }): Verdict {
  const args = (input ?? {}) as Record<string, unknown>;

  if (toolName === "Bash" && typeof args.command === "string") {
    // The pipeline never publishes: pass an empty env so SHIPYARD_ALLOW_PUBLISH cannot unlock it.
    const verdict = checkCommand(args.command, {});
    return verdict.blocked ? { allowed: false, reason: verdict.reason } : { allowed: true };
  }

  const pathKey = WRITE_TOOLS[toolName];
  if (pathKey) {
    const target = args[pathKey];
    if (typeof target !== "string") return { allowed: true };
    const rel = relativeInside(opts.root, target);
    if (rel === null) return { allowed: false, reason: `Blocked: ${target} is outside your working directory (${opts.root}).` };
    if (!inLane(rel, opts.lane)) {
      return { allowed: false, reason: `Blocked: your role may edit ${LANE_WORDS[opts.lane]}; ${rel} is outside that lane.` };
    }
  }
  return { allowed: true };
}
