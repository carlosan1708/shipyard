import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkExecutable, git } from "./exec.ts";
import { isTestPath } from "./guards.ts";
import { isTriageReport } from "./prompts.ts";
import type { BugVerification, RegressionObservation, RunRecord } from "./store.ts";
import { detachedWorktree } from "./worktree.ts";

const reporter = new URL("./regression-reporter.mjs", import.meta.url).href;

interface TestEvent {
  name: string;
  file?: string;
  passed: boolean;
  skipped: boolean;
  failureType?: string;
  assertion?: string;
}

export function bugEvidence(run: RunRecord, head?: string) {
  const evidence = run.bugVerification;
  if (run.kind !== "bug" && !evidence) return;
  if (!evidence) return { status: "Needs review", reason: "No regression verification was recorded.", evidence };
  if (evidence.gap && !evidence.before && !evidence.after) return { status: "Needs review", reason: evidence.gap, evidence };
  if (evidence.head !== head) {
    const gap = evidence.recheck && evidence.recheck.head === head ? evidence.recheck.gap : undefined;
    return { status: "Out of date", reason: gap ? `The newer commit still needs review. ${gap}` : "The evidence applies to an earlier commit.", evidence };
  }
  if (evidence.gap) return { status: "Needs review", reason: evidence.gap, evidence };
  if (!evidence.approved || evidence.before?.outcome !== "expected-failure" || evidence.after?.outcome !== "passed") {
    return { status: "Needs review", reason: "The approved before-and-after evidence is incomplete.", evidence };
  }
  return { status: "Verified", evidence, reason: undefined };
}

export function recordBugExpectation(run: RunRecord, head: string): BugVerification {
  const review = run.stages.find((stage) => stage.name === "triage" && stage.commit)?.attempts.at(-1);
  const report = isTriageReport(review?.output) ? review.output : undefined;
  const previous = run.bugVerification;
  return {
    baseSha: previous?.baseSha ?? run.baseSha,
    head,
    expected: previous?.expected ?? report?.expected.trim(),
    actual: previous?.actual ?? report?.actual?.trim().slice(0, 500),
    testFile: previous?.testFile ?? report?.reproduction_test.trim(),
    testName: previous?.testName ?? report?.test_name?.trim(),
    assertionMessage: previous?.assertionMessage ?? report?.assertion_message,
    approved: previous?.approved ?? (review?.review?.action === "continue"),
    gap: "The final regression test has not been checked on both versions.",
  };
}

export async function verifyBugFix(run: RunRecord, head: string, root: string, timeoutMs?: number, signal?: AbortSignal): Promise<BugVerification> {
  const evidence = recordBugExpectation(run, head);
  const { baseSha, testFile, testName, assertionMessage } = evidence;
  if (!evidence.approved || !evidence.expected) {
    evidence.gap = "The expected behavior was not approved at triage.";
    return evidence;
  }
  if (!testFile || !testName || !assertionMessage || testName.length > 300 || assertionMessage.length > 500 ||
      /[\x00-\x1f\x7f]/.test(testName + assertionMessage) || !isTestPath(testFile) ||
      !/^(?:[\w.-]+\/)*[\w.-]+\.[cm]?[jt]s$/.test(testFile) || testFile.split("/").some((part) => /^(?:\.{1,2}|\.git)$/i.test(part))) {
    evidence.gap = "Triage did not identify a supported Node test file, exact test name, and assertion message.";
    return evidence;
  }

  try {
    const entry = await git(["--literal-pathspecs", "ls-tree", head, "--", testFile], run.repo);
    if (!/^100(?:644|755) blob /.test(entry)) {
      evidence.gap = "The final commit does not contain the named regression test file.";
      return evidence;
    }
    const args = ["--test", `--test-reporter=${reporter}`, "--", `./${testFile}`];
    let baselineTestBlob: string | undefined;
    const observe = async (commit: string, baseline: boolean): Promise<RegressionObservation> => {
      signal?.throwIfAborted();
      const scratch = await detachedWorktree(run.repo, root, commit);
      try {
        if (baseline) {
          // Use the final bytes of the test even when implementation changed it after triage.
          await git(["--literal-pathspecs", "restore", `--source=${head}`, "--staged", "--worktree", "--", testFile], scratch.worktree);
        }
        const testBlob = () => git(["hash-object", "--no-filters", "--", testFile], scratch.worktree);
        const startingBlob = await testBlob();
        if (baseline) baselineTestBlob = startingBlob;
        const result = await checkExecutable(process.execPath, args, scratch.worktree, timeoutMs, signal);
        const measurement = { exitCode: result.code, durationMs: result.durationMs };
        const inconclusive = (detail: string): RegressionObservation => ({ ...measurement, outcome: "inconclusive", detail });
        if (result.timedOut || signal?.aborted) return inconclusive(result.timedOut ? "The test command timed out." : "Verification was interrupted.");
        if (baselineTestBlob !== startingBlob) return inconclusive("The checked-out test contents differ between the two versions.");
        if (await testBlob() !== startingBlob || await git(["rev-parse", "HEAD"], scratch.worktree) !== commit) {
          return inconclusive("The test file or checked-out commit changed during verification.");
        }
        const events = result.output.split("\n").filter((line) => line.startsWith("shipyard-test "))
          .map((line) => JSON.parse(line.slice("shipyard-test ".length)) as TestEvent);
        const cwd = await realpath(scratch.worktree);
        const matches = events.filter((event) => event.name === testName && event.file &&
          resolve(cwd, event.file) === join(cwd, testFile));
        if (matches.length !== 1 || matches[0]!.skipped) return inconclusive("The runner did not report exactly one execution of the named test.");
        const event = matches[0]!;
        if (!baseline && result.code === 0 && event.passed) return { ...measurement, outcome: "passed", detail: "The runner reported that the named test passed." };
        if (baseline && result.code === 1 && !event.passed && event.failureType === "testCodeFailure" && event.assertion === assertionMessage &&
            events.filter((entry) => !entry.passed && entry.failureType !== "subtestsFailed").length === 1) {
          return { ...measurement, outcome: "expected-failure", detail: `The named test failed with the approved assertion: ${assertionMessage}` };
        }
        return inconclusive(baseline ? "The final test did not reproduce only the approved assertion failure on the original code." : "The named test did not pass on the final commit.");
      } finally {
        await scratch.close();
      }
    };
    evidence.before = await observe(baseSha, true);
    evidence.after = await observe(head, false);
    evidence.gap = [evidence.before, evidence.after].find(({ outcome }) => outcome === "inconclusive")?.detail;
  } catch {
    evidence.gap = "Shipyard could not run the regression check in a clean checkout of both versions.";
  }
  return evidence;
}
