import { isAbsolute, relative, resolve } from "node:path";
// One implementation of the publish guard, shared with the Claude Code plugin hook.
import { checkCommand } from "../plugins/shipyard/hooks/guard-publish.mjs";

export { checkCommand };

/**
 * A lane limits which files a role may write.
 * - any: anything inside the worktree
 * - tests: only test files (the E2E tester)
 * - no-e2e: anything except E2E tests (the implementer fixing an E2E failure must not edit the test)
 */
export type Lane = "any" | "tests" | "no-e2e";

const TEST_PATH = /(^|\/)(e2e|tests?|__tests__|spec)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;
const E2E_PATH = /(^|\/)e2e\/|\.e2e\.[cm]?[jt]sx?$/;

export const isTestPath = (rel: string): boolean => TEST_PATH.test(rel);
export const isE2EPath = (rel: string): boolean => E2E_PATH.test(rel);

export function inLane(rel: string, lane: Lane): boolean {
  if (lane === "tests") return isTestPath(rel);
  if (lane === "no-e2e") return !isE2EPath(rel);
  return true;
}

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
      const what = opts.lane === "tests" ? "test files only" : "anything except E2E tests";
      return { allowed: false, reason: `Blocked: your role may edit ${what}; ${rel} is outside that lane.` };
    }
  }
  return { allowed: true };
}
