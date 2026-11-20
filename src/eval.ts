import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { addTokenUsage, type TokenUsage } from "./agent.ts";
import { providerOptions, SHIPYARD_ROOT, type Provider, type Target } from "./config.ts";
import { sh, type ExecResult } from "./exec.ts";
import { runPipeline, type PipelineDeps } from "./pipeline.ts";
import type { RunKind, RunStatus } from "./store.ts";
import { initRepoWithCommit } from "./worktree.ts";

export const EVALS_DIR = join(SHIPYARD_ROOT, "evals");
export const DEMO_APP_DIR = join(SHIPYARD_ROOT, "examples", "demo-shop");

export interface FileEdit {
  file: string;
  find: string;
  replace: string;
}

/**
 * One eval task. A bug task seeds a bug into the demo app; a feature task asks for something missing.
 * The hidden test is the grader: the agents never see it. It is copied in only after the pipeline finishes.
 */
export interface EvalTask {
  id: string;
  kind: RunKind;
  title: string;
  /** What the agents are told: a user-style bug report or feature request. */
  request: string;
  /** Bug tasks: edits that introduce the bug. */
  seed?: FileEdit[];
  /** Feature tasks: a known-good solution, used only to validate the hidden test. */
  reference?: FileEdit[];
  /** Path under evals/ of the grading test. */
  hidden: string;
}

export interface EvalResult {
  id: string;
  kind: RunKind;
  runId?: string;
  pipeline: RunStatus;
  solved: boolean;
  costUsd: number | null;
  usage?: TokenUsage;
  durationMs: number;
  attempts: number;
  hiddenOutputTail?: string;
}

export interface EvalReport {
  startedAt: string;
  provider?: Provider;
  model: string;
  results: EvalResult[];
}

const APP_TEST = "npm test";
const APP_E2E = "npm run e2e";

export function loadTasks(dir = join(EVALS_DIR, "tasks")): EvalTask[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalTask);
}

export function applyEdits(root: string, edits: FileEdit[]): void {
  for (const edit of edits) {
    const file = join(root, edit.file);
    const text = readFileSync(file, "utf8");
    const count = text.split(edit.find).length - 1;
    if (count !== 1) throw new Error(`${edit.file}: expected the find text exactly once, found ${count}`);
    writeFileSync(file, text.replace(edit.find, () => edit.replace));
  }
}

/** Copy the demo app into a fresh temp folder, apply edits, and make it a git repo with one commit. */
export async function makeSandbox(task: EvalTask, edits: FileEdit[] = task.seed ?? [], appDir = DEMO_APP_DIR): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), `shipyard-${task.id}-`)), "repo");
  cpSync(appDir, dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
  applyEdits(dir, edits);
  // A single commit, so `git log` gives no hint about the seeded bug.
  await initRepoWithCommit(dir);
  return dir;
}

/** Run the hidden grading test inside `repoDir`, then remove it again. */
export async function runHidden(task: EvalTask, repoDir: string): Promise<ExecResult> {
  const evalDir = join(repoDir, ".eval");
  mkdirSync(evalDir, { recursive: true });
  const dest = join(evalDir, basename(task.hidden));
  cpSync(join(EVALS_DIR, task.hidden), dest);
  try {
    return await sh(`node --test ${JSON.stringify(dest)}`, repoDir, 120_000);
  } finally {
    rmSync(evalDir, { recursive: true, force: true });
  }
}

/**
 * Check that a task is a fair test before spending money on it:
 *  - bug: the hidden test passes on the clean app and fails once the bug is seeded
 *  - feature: the hidden test fails on the clean app and passes with the reference solution
 *  - the app's own unit and E2E tests pass on the clean (or reference) app
 */
export async function validateTask(task: EvalTask): Promise<string[]> {
  const problems: string[] = [];
  const cleanup: string[] = [];
  try {
    const good = await makeSandbox(task, task.kind === "bug" ? [] : (task.reference ?? []));
    const bad = await makeSandbox(task, task.kind === "bug" ? (task.seed ?? []) : []);
    cleanup.push(good, bad);

    if (task.kind === "bug" && !task.seed?.length) problems.push("bug task has no seed edits");
    if (task.kind === "feature" && !task.reference?.length) problems.push("feature task has no reference solution");
    if (!existsSync(join(EVALS_DIR, task.hidden))) problems.push(`hidden test not found: ${task.hidden}`);
    if (problems.length) return problems;

    if ((await runHidden(task, good)).code !== 0) problems.push("hidden test fails on the correct app");
    if ((await runHidden(task, bad)).code === 0) problems.push("hidden test passes on the broken app (it cannot tell them apart)");
    if ((await sh(APP_TEST, good)).code !== 0) problems.push(`\`${APP_TEST}\` fails on the correct app`);
    if ((await sh(APP_E2E, good)).code !== 0) problems.push(`\`${APP_E2E}\` fails on the correct app`);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    for (const dir of cleanup) rmSync(join(dir, ".."), { recursive: true, force: true });
  }
  return problems;
}

export async function runEval(tasks: EvalTask[], deps: PipelineDeps, provider = deps.config.defaultProvider ?? "claude"): Promise<EvalReport> {
  const log = deps.log ?? (() => {});
  const report: EvalReport = {
    startedAt: new Date().toISOString(),
    provider,
    model: providerOptions(deps.config, provider).model ?? "Codex CLI default",
    results: [],
  };

  for (const task of tasks) {
    log(`\n━━ eval ${task.id} (${task.kind}): ${task.title}`);
    let run;
    try {
      const repo = await makeSandbox(task);
      const target: Target = { name: `eval-${task.id}`, path: repo, test: APP_TEST, e2e: APP_E2E };
      run = await runPipeline({ target, kind: task.kind, request: task.request, provider, tags: ["eval", task.id] }, deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  setup error: ${message}`);
      report.results.push({ id: task.id, kind: task.kind, pipeline: "error", solved: false, costUsd: provider === "codex" ? null : 0, durationMs: 0, attempts: 0, hiddenOutputTail: message });
      continue;
    }
    // Grade the final state of the branch, whatever the pipeline concluded.
    const hidden = run.cleanedUp ? undefined : await runHidden(task, run.worktree);
    const solved = hidden?.code === 0;
    log(`  hidden test: ${solved ? "✓ solved" : "✗ not solved"}`);
    report.results.push({
      id: task.id,
      kind: task.kind,
      runId: run.id,
      pipeline: run.status,
      solved,
      costUsd: run.totals.costUsd,
      usage: run.totals.usage,
      durationMs: run.totals.durationMs,
      attempts: run.totals.attempts,
      hiddenOutputTail: solved ? undefined : hidden?.output.slice(-2000) ?? run.error,
    });
  }

  const outDir = join(EVALS_DIR, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${report.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(report, null, 2) + "\n");
  return report;
}

export function formatReport(report: EvalReport): string {
  const codex = report.provider === "codex";
  const usageText = (usage?: TokenUsage) => usage ? `${usage.inputTokens} in / ${usage.outputTokens} out` : "unavailable";
  const usageWidth = codex ? 24 : 7;
  const rows = report.results.map((r) => {
    const usage = codex ? usageText(r.usage) : r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(2)}`;
    return [r.id.padEnd(22), r.kind.padEnd(8), (r.solved ? "✓" : "✗").padEnd(7), r.pipeline.padEnd(8), usage.padStart(usageWidth), `${(r.durationMs / 1000).toFixed(0)}s`.padStart(6), String(r.attempts).padStart(8)].join(" ");
  });
  const solved = report.results.filter((r) => r.solved);
  const cost = report.results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const usage = report.results.reduce<TokenUsage | undefined>((total, r) => r.usage ? addTokenUsage(total, r.usage) : total, undefined);
  const spend = codex
    ? `tokens ${usageText(usage)} · dollar cost unavailable`
    : `est. total $${cost.toFixed(2)} · est. $${solved.length ? (cost / solved.length).toFixed(2) : "n/a"} per solved task`;
  const n = report.results.length;
  const durations = report.results.map((r) => r.durationMs).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)]! : 0;
  return [
    ["task".padEnd(22), "kind".padEnd(8), "solved".padEnd(7), "pipeline".padEnd(8), (codex ? "tokens" : "cost").padStart(usageWidth), "time".padStart(6), "attempts".padStart(8)].join(" "),
    ...rows,
    "",
    `solved ${solved.length}/${n} (${n ? Math.round((solved.length / n) * 100) : 0}%) · ${spend} · median ${(median / 1000).toFixed(0)}s · provider ${report.provider ?? "claude"} · model ${report.model}`,
    ...(!codex ? ["(costs are the SDK's estimate at API prices; on a subscription they measure usage, not a bill)"] : []),
  ].join("\n");
}
