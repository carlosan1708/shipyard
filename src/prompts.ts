import type { ExecResult } from "./exec.ts";
import { tail } from "./exec.ts";
import type { RunKind } from "./store.ts";
import type { Target } from "./config.ts";

const kindLabel = (kind: RunKind) => (kind === "bug" ? "Bug report" : kind === "deps" ? "Dependency update request" : "Feature request");
const kindNoun = (kind: RunKind) => (kind === "bug" ? "bug fix" : kind === "deps" ? "dependency update" : "feature");

/** What a dependency run is asked to do when you give no notes. */
export const DEFAULT_DEPS_REQUEST = "Update dependencies: patch and minor versions, plus anything needed to fix a known vulnerability.";

const taskBlock = (kind: RunKind, request: string) => `${kindLabel(kind)}:\n<task>\n${request.trim()}\n</task>`;

export function planPrompt(kind: RunKind, request: string, target: Target): string {
  return [
    taskBlock(kind, request),
    `Plan this ${kindNoun(kind)} for the implementer. Explore the repository, but do not change any files.`,
    `The implementer's work will be gated by \`${target.test}\`${target.e2e ? ` and then \`${target.e2e}\`` : ""}, so plan the tests that make those pass.`,
    "End with the plan as your final message: Goal, Approach, Files, Tasks (numbered), Tests, Risks / open questions.",
  ].join("\n\n");
}

export function planMissingPrompt(): string {
  return "Your final message didn't contain a plan. Write it now as your final message: Goal, Approach, Files, Tasks (numbered), Tests, Risks / open questions.";
}

export function implementPrompt(kind: RunKind, request: string, target: Target, plan?: string, triage?: TriageReport): string {
  const how =
    kind === "deps"
      ? "Update the dependencies as asked, adapt the code only where an upgrade breaks it, and keep every test passing."
      : kind === "bug" && triage
        ? `A bug triager already reproduced this bug with a failing test in ${triage.reproduction_test}. Fix the root cause so that test passes; keep the test.`
        : kind === "bug"
          ? "Reproduce the bug with a failing unit test first, then fix the root cause."
          : "Implement the feature with unit tests for the main behaviour, edge cases and error paths.";
  return [
    taskBlock(kind, request),
    triage ? `The triage report:\n<triage>\n${formatTriage(triage)}\n</triage>` : "",
    plan?.trim()
      ? `A planner already studied the repo and wrote this plan. Follow it unless the code shows it is wrong, and say so in your summary if you deviate:\n<plan>\n${plan.trim()}\n</plan>`
      : "",
    how,
    `When you finish, the pipeline runs this gate: \`${target.test}\`. Your work only counts if it passes, so run it yourself before you stop.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The reviewer's answer, enforced by the SDK as structured output. */
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string", description: "Two or three sentences on the overall state of the change." },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "issue"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string", description: "What is wrong, concretely." },
          suggestion: { type: "string", description: "What to do instead." },
        },
      },
    },
  },
} as const;

export interface ReviewFinding {
  severity: "blocker" | "major" | "minor" | "nit";
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

export interface ReviewVerdict {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: ReviewFinding[];
}

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  const v = value as ReviewVerdict;
  return Boolean(v) && (v.verdict === "approve" || v.verdict === "request_changes") && Array.isArray(v.findings);
}

/** Blocking findings: the change needs another round. */
export const blockingFindings = (v: ReviewVerdict) => v.findings.filter((f) => f.severity === "blocker" || f.severity === "major");

export function formatFindings(v: ReviewVerdict): string {
  const lines = [v.summary.trim()];
  if (v.findings.length === 0) lines.push("", "No findings.");
  for (const f of v.findings) {
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    lines.push("", `[${f.severity}]${where}: ${f.issue}${f.suggestion ? `\n  → ${f.suggestion}` : ""}`);
  }
  return lines.join("\n");
}

// ── Triage ───────────────────────────────────────────────

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reproduced", "reproduction_test", "steps", "expected", "actual", "suspected_cause", "suspected_files"],
  properties: {
    reproduced: { type: "boolean", description: "True only if your new test fails on the current code for the reported reason." },
    reproduction_test: { type: "string", description: "Path of the test file you added, relative to the repo root." },
    steps: { type: "string" },
    expected: { type: "string" },
    actual: { type: "string" },
    suspected_cause: { type: "string" },
    suspected_files: { type: "array", items: { type: "string" } },
  },
} as const;

export interface TriageReport {
  reproduced: boolean;
  reproduction_test: string;
  steps: string;
  expected: string;
  actual: string;
  suspected_cause: string;
  suspected_files: string[];
}

export function isTriageReport(value: unknown): value is TriageReport {
  const t = value as TriageReport;
  return Boolean(t) && typeof t.reproduced === "boolean" && typeof t.reproduction_test === "string";
}

export function formatTriage(t: TriageReport): string {
  return [
    `${t.reproduced ? "Reproduced" : "Not reproduced"} by ${t.reproduction_test || "(no test)"}.`,
    `Steps: ${t.steps}`,
    `Expected: ${t.expected}`,
    `Actual: ${t.actual}`,
    `Suspected cause: ${t.suspected_cause}`,
    t.suspected_files.length ? `Likely files: ${t.suspected_files.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function triagePrompt(request: string, target: Target): string {
  return [
    taskBlock("bug", request),
    "Triage this bug: reproduce it with the smallest failing test you can, through the code's public interface. Do not fix it and do not change application code.",
    `The pipeline then runs \`${target.test}\` and expects it to FAIL because of your new test. That failure is the proof the bug is real; the implementer's job is to make it pass.`,
    "If you cannot reproduce it, report reproduced: false with what you tried.",
  ].join("\n\n");
}

export function notReproducedPrompt(gatePassed: boolean): string {
  return gatePassed
    ? "The test command passes on the current code, so your test doesn't reproduce the bug yet. Make it fail for the reported reason (an assertion about the wrong behaviour), then run the command to confirm it fails."
    : "Your report says the bug was not reproduced. Try a different angle on the report; if it really can't be reproduced, explain what extra information would help.";
}

// ── Security audit ───────────────────────────────────────

export const SECURITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fix_required"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "issue"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          category: { type: "string", description: "secrets, injection, input-validation, access-control, unsafe-default, dependency, other" },
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string", description: "What is wrong and how it could be abused." },
          fix: { type: "string" },
        },
      },
    },
  },
} as const;

export interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  file?: string;
  line?: number;
  issue: string;
  fix?: string;
}

export interface SecurityVerdict {
  verdict: "pass" | "fix_required";
  summary: string;
  findings: SecurityFinding[];
}

export function isSecurityVerdict(value: unknown): value is SecurityVerdict {
  const v = value as SecurityVerdict;
  return Boolean(v) && (v.verdict === "pass" || v.verdict === "fix_required") && Array.isArray(v.findings);
}

export const blockingSecurityFindings = (v: SecurityVerdict) => v.findings.filter((f) => f.severity === "critical" || f.severity === "high");

export function formatSecurityFindings(v: SecurityVerdict): string {
  const lines = [v.summary.trim()];
  if (v.findings.length === 0) lines.push("", "No findings.");
  for (const f of v.findings) {
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    lines.push("", `[${f.severity} · ${f.category}]${where}: ${f.issue}${f.fix ? `\n  → ${f.fix}` : ""}`);
  }
  return lines.join("\n");
}

export function securityPrompt(kind: RunKind, request: string, baseSha: string): string {
  return [
    `Audit this ${kindNoun(kind)} for security problems. The whole change is \`git diff ${baseSha.slice(0, 12)}..HEAD\`.`,
    taskBlock(kind, request),
    "You are read-only: do not change files. Require fixes only for critical or high findings; otherwise pass.",
  ].join("\n\n");
}

export function hardenPrompt(v: SecurityVerdict): string {
  return [
    "A security auditor reviewed your change and requires fixes:",
    `<audit>\n${formatSecurityFindings(v)}\n</audit>`,
    "Fix the critical and high findings (for a vulnerable dependency, upgrade or replace it). Medium and low ones are optional. If you believe a finding is wrong, leave the code and explain why in your summary. Run the gate yourself before you stop.",
  ].join("\n\n");
}

export function reviewPrompt(kind: RunKind, request: string, baseSha: string, plan?: string): string {
  return [
    `Review this ${kindNoun(kind)}. The whole change is \`git diff ${baseSha.slice(0, 12)}..HEAD\`.`,
    taskBlock(kind, request),
    plan?.trim() ? `The plan it was built from:\n<plan>\n${plan.trim()}\n</plan>` : "",
    "You are read-only: do not change files. Request changes only for blocker or major findings; otherwise approve.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function revisePrompt(v: ReviewVerdict): string {
  return [
    "A reviewer looked at your change with fresh eyes (they never saw your session) and requested changes:",
    `<review>\n${formatFindings(v)}\n</review>`,
    "Fix the blocker and major findings. Minor ones and nits are optional. If you disagree with a finding, leave the code and explain why in your summary. Run the gate yourself before you stop.",
  ].join("\n\n");
}

export function docsPrompt(kind: RunKind, request: string, baseSha: string): string {
  return [
    `Update the documentation for this ${kindNoun(kind)}. The whole change is \`git diff ${baseSha.slice(0, 12)}..HEAD\`.`,
    taskBlock(kind, request),
    "Only edit documentation (Markdown, docs/, the changelog). If nothing user-facing changed, change nothing and say so.",
  ].join("\n\n");
}

export function releasePrompt(kind: RunKind, request: string, baseSha: string): string {
  return [
    `Prepare a release for this ${kindNoun(kind)}. The whole change is \`git diff ${baseSha.slice(0, 12)}..HEAD\`.`,
    taskBlock(kind, request),
    "Bump the version (semantic versioning) and turn the changelog's Unreleased entries into a section for the new version. Never publish, tag or push. End with release notes for users.",
  ].join("\n\n");
}

export function e2ePrompt(kind: RunKind, request: string, implementSummary: string, target: Target, baseSha?: string): string {
  return [
    `The implementation engineer just finished this ${kindNoun(kind)}. The whole change is \`git diff ${baseSha ? baseSha.slice(0, 12) : "HEAD~1"}..HEAD\`.`,
    `${kindLabel(kind)}:\n<task>\n${request.trim()}\n</task>`,
    `Their summary:\n<summary>\n${implementSummary.trim() || "(no summary)"}\n</summary>`,
    kind === "bug"
      ? "Add an E2E test, through the public interface, that would have caught this bug."
      : kind === "deps"
        ? "Check, through the public interface, that the main paths still work after the upgrades, and add E2E tests where coverage of them is missing."
        : "Add E2E tests, through the public interface, for the feature's main path and at least one failure path.",
    `The pipeline gate is \`${target.e2e}\`. Run it yourself before you stop.`,
  ].join("\n\n");
}

export function gateFailurePrompt(gate: ExecResult): string {
  return [
    `The pipeline gate failed.`,
    `Command: \`${gate.command}\` (exit code ${gate.code}${gate.timedOut ? ", timed out" : ""})`,
    `<output>\n${tail(gate.output)}\n</output>`,
    `Fix the cause, then run the command yourself to confirm it passes.`,
  ].join("\n\n");
}

export function repairPrompt(gate: ExecResult, testerSummary: string): string {
  return [
    `The E2E engineer tested your change through the public interface, and the E2E gate fails.`,
    `Their notes:\n<summary>\n${testerSummary.trim() || "(no notes)"}\n</summary>`,
    `Command: \`${gate.command}\` (exit code ${gate.code}${gate.timedOut ? ", timed out" : ""})`,
    `<output>\n${tail(gate.output)}\n</output>`,
    `Fix the application code so the E2E tests pass. Do not edit the E2E tests. If you believe a test is wrong, explain why in your summary instead.`,
  ].join("\n\n");
}

/** Added to a stage's first prompt when a human is watching (shipyard ui). */
export function humanAvailableNote(): string {
  return [
    "A human is available while you work.",
    "If the task is ambiguous in a way that changes the result, ask with the AskUserQuestion tool instead of guessing. Don't ask about things you can find out from the code.",
    "Some tools, such as web access, need the human's approval each time you use them.",
  ].join(" ");
}

/** A human's checkpoint feedback, sent into the same agent session. */
export function reviewerFeedbackPrompt(message: string, outcome: "passed" | "failed", context = ""): string {
  const intro =
    outcome === "passed"
      ? "A human reviewer checked your work. The gates pass, but they want changes:"
      : "A human reviewer looked at the failure and says:";
  return [
    context,
    intro,
    `<feedback>\n${message.trim()}\n</feedback>`,
    "Act on the feedback, then run the gate command yourself before you stop. The reviewer will look again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function noChangesPrompt(): string {
  return `You finished without changing any files, so there is nothing to verify. The task needs a change to the repository: make it, then run the gate command yourself.`;
}

export function lanePrompt(reverted: string[]): string {
  return `Note: you changed files outside your role's lane, and the pipeline reverted them: ${reverted.join(", ")}.`;
}
