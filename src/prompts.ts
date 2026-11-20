import type { ExecResult } from "./exec.ts";
import { tail } from "./exec.ts";
import type { RunKind } from "./store.ts";
import type { Target } from "./config.ts";

const kindLabel = (kind: RunKind) => (kind === "bug" ? "Bug report" : "Feature request");

export function implementPrompt(kind: RunKind, request: string, target: Target): string {
  const how =
    kind === "bug"
      ? "Reproduce the bug with a failing unit test first, then fix the root cause."
      : "Implement the feature with unit tests for the main behaviour, edge cases and error paths.";
  return [
    `${kindLabel(kind)}:`,
    `<task>\n${request.trim()}\n</task>`,
    how,
    `When you finish, the pipeline runs this gate: \`${target.test}\`. Your work only counts if it passes, so run it yourself before you stop.`,
  ].join("\n\n");
}

export function e2ePrompt(kind: RunKind, request: string, implementSummary: string, target: Target): string {
  return [
    `The implementation engineer just finished this ${kind === "bug" ? "bug fix" : "feature"}. It is the latest commit (\`git show HEAD\`).`,
    `${kindLabel(kind)}:\n<task>\n${request.trim()}\n</task>`,
    `Their summary:\n<summary>\n${implementSummary.trim() || "(no summary)"}\n</summary>`,
    kind === "bug"
      ? "Add an E2E test, through the public interface, that would have caught this bug."
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

export function noChangesPrompt(): string {
  return `You finished without changing any files, so there is nothing to verify. The task needs a change to the repository: make it, then run the gate command yourself.`;
}

export function lanePrompt(reverted: string[]): string {
  return `Note: you changed files outside your role's lane, and the pipeline reverted them: ${reverted.join(", ")}.`;
}
