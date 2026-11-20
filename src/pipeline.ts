import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { addTokenUsage, type AgentAnswer, type AgentAsk, type AgentResult, type AgentRunner, type TokenUsage } from "./agent.ts";
import { providerOptions, type Provider, type RunEffort, type ShipyardConfig, type Target } from "./config.ts";
import { git, sh, tail, type ExecResult } from "./exec.ts";
import { inLane, type Lane } from "./guards.ts";
import {
  blockingFindings,
  blockingSecurityFindings,
  docsPrompt,
  e2ePrompt,
  formatFindings,
  formatSecurityFindings,
  formatTriage,
  gateFailurePrompt,
  hardenPrompt,
  humanAvailableNote,
  implementPrompt,
  isReviewVerdict,
  isSecurityVerdict,
  isTriageReport,
  lanePrompt,
  noChangesPrompt,
  notReproducedPrompt,
  planMissingPrompt,
  planPrompt,
  releasePrompt,
  repairPrompt,
  REVIEW_SCHEMA,
  reviewerFeedbackPrompt,
  reviewPrompt,
  revisePrompt,
  SECURITY_SCHEMA,
  securityPrompt,
  TRIAGE_SCHEMA,
  triagePrompt,
  type TriageReport,
} from "./prompts.ts";
import { requireRole, type Role } from "./roles.ts";
import type { RunControl } from "./run-control.ts";
import type { AttemptRecord, GateRecord, RunKind, RunRecord, RunStatus, RunStore, StageRecord } from "./store.ts";
import { changedFiles, commitAll, createWorktree, removeWorktree, repoRoot, revertFiles } from "./worktree.ts";

/** Agent stops that still deserve grading: the agent ran out of room, but may have done the work. */
const LIMIT_ERRORS = new Set(["error_max_turns", "error_max_budget_usd"]);

/** Below this much budget left, an attempt can't do useful work (one turn can cost more), so it isn't started. */
const MIN_ATTEMPT_BUDGET_USD = 0.1;

/** The run spent its budget. It ends as failed, keeping whatever earlier stages committed. */
class BudgetReachedError extends Error {}
class RunStoppedError extends Error {}

/** Every stage, in the order a run goes through them. */
export const STAGES = ["triage", "plan", "implement", "review", "revise", "security", "harden", "e2e", "repair", "docs", "release"] as const;
export type StageName = (typeof STAGES)[number];

/**
 * Stages you switch on per run. implement always runs; revise runs when the reviewer asks for
 * changes, harden when the security audit requires fixes, and repair when the E2E tests fail.
 * triage only applies to bug runs, and plan doesn't apply to dependency runs.
 */
export const OPTIONAL_STAGES = ["triage", "plan", "review", "security", "e2e", "repair", "docs", "release"] as const;
export type OptionalStage = (typeof OPTIONAL_STAGES)[number];
/** Without a choice, runs keep the original crew. */
export const DEFAULT_CREW: OptionalStage[] = ["e2e", "repair"];

export const IMPLEMENTERS = ["backend", "frontend"] as const;
export type Implementer = (typeof IMPLEMENTERS)[number];

/** What a checkpoint shows the human. */
export interface CheckpointContext {
  runId: string;
  provider?: Provider;
  stage: StageName;
  role: string;
  /** passed: the gates are green. failed: the stage ran out of retries (or made no changes). */
  outcome: "passed" | "failed";
  /**
   * Whether "continue" is a choice. After a pass it means approve; after a failure it only exists
   * where the pipeline has a next step for it (an E2E failure goes to the implementer for repair).
   */
  canContinue: boolean;
  attempt: number;
  summary: string;
  gates: GateRecord[];
  noChanges: boolean;
  worktree: string;
  sessionId?: string;
}

export type CheckpointDecision = { action: "continue" } | { action: "feedback"; message: string } | { action: "stop" };

export interface Checkpoints {
  /** Stages to pause after. */
  stages: readonly StageName[];
  review: (ctx: CheckpointContext, signal?: AbortSignal) => Promise<CheckpointDecision>;
}

export interface PipelineDeps {
  config: Pick<ShipyardConfig, "model" | "maxGateRetries" | "worktreeRoot"> & Partial<Pick<ShipyardConfig, "effort" | "maxBudgetUsdPerRun" | "defaultProvider" | "codex">>;
  runner: AgentRunner;
  runnerForProvider?: (provider: Provider) => AgentRunner;
  control?: RunControl;
  store: RunStore;
  roles: Map<string, Role>;
  log?: (line: string) => void;
  /** Gate timeout per command. */
  gateTimeoutMs?: number;
  /** Pause for a human after these stages. Off when unset. */
  checkpoints?: Checkpoints;
  /** A human who answers agents' questions and permission requests while they work. Headless when unset. */
  ask?: (from: { runId: string; stage: StageName; role: string }, ask: AgentAsk, signal?: AbortSignal) => Promise<AgentAnswer>;
}

export interface PipelineRequest {
  target: Target;
  kind: RunKind;
  request: string;
  tags?: string[];
  /** Use this run id (so a caller can track the run before it finishes). Generated when unset. */
  id?: string;
  /** Model and effort for every agent in this run. The config's defaults when unset. */
  provider?: Provider;
  model?: string;
  effort?: RunEffort;
  /** The optional stages that run (DEFAULT_CREW when unset). Implement always runs. */
  crew?: OptionalStage[];
  /** Who implements, revises and repairs: backend (default) or frontend. Dependency runs always use dependency-updater. */
  implementer?: Implementer;
  /** Estimated cost limit for the whole run. config.maxBudgetUsdPerRun when unset. */
  budgetUsd?: number;
}

interface AgentSession { provider: Provider; id: string }

interface StageSpec {
  name: StageName;
  role: Role;
  lane: Lane;
  prompt: string;
  gates: string[];
  /** The gates must FAIL (bug triage: a failing reproduction proves the bug). */
  expectGateFailure?: boolean;
  /** What to tell the agent when a gate goes the wrong way. Defaults to the gate output. */
  failurePrompt?: (gate: ExecResult) => string;
  /** Gate failures in a row before the stage gives up (1 + retries). Human feedback resets the count. */
  maxAttempts: number;
  resumeSession?: AgentSession;
  /** The pipeline has a next step for this stage's failure (E2E failure -> repair, review -> revise). */
  failureContinues?: boolean;
  /** Read-only roles (planner, reviewer): anything they change is reverted, and no diff is expected. */
  readOnly?: boolean;
  /** Stages that may rightly change nothing (docs when nothing user-facing changed, release without a version). */
  allowNoChanges?: boolean;
  /** Ask the agent for a final answer matching this JSON schema. */
  outputSchema?: Record<string, unknown>;
  /** Decides pass/fail from what the agent said, after the gates pass (plan present? review verdict?). */
  judge?: (result: AgentResult) => Judgement;
}

export interface Judgement {
  passed: boolean;
  /** Sent back to the agent on a retry, or handed to the next stage (review findings -> revise). */
  feedback?: string;
  /** Replaces the agent's own summary in the record and at the checkpoint (e.g. formatted findings). */
  summary?: string;
  /** Data worth keeping in the run record (e.g. the review verdict). */
  output?: unknown;
}

interface StageOutcome {
  lane: Lane;
  record: StageRecord;
  passed: boolean;
  stopped: boolean;
  session?: AgentSession;
  summary: string;
  lastFailure?: ExecResult;
  /** The judge's feedback on the last failed attempt. */
  judgeFeedback?: string;
  output?: unknown;
}

/**
 * The shipyard pipeline. Optional stages are in [brackets]; implement always runs.
 *
 *   [triage]   bug-triager (tests only)       --gate: unit tests must FAIL-----> [checkpoint] --> commit   (bug runs only)
 *   [plan]     planner (read-only)            --judge: a plan was written------> [checkpoint]
 *   implement  backend|frontend|dependency-updater --gate: unit tests---------> [checkpoint] --> commit
 *   [review]   reviewer (read-only, fresh)    --judge: no blocker/major finding> [checkpoint]
 *     revise   implementer, resumed           --gate: unit tests---------------> [checkpoint] --> commit   (if changes requested)
 *   [security] security-auditor (read-only)   --judge: no critical/high--------> [checkpoint]
 *     harden   implementer, resumed           --gate: unit tests---------------> [checkpoint] --> commit   (if fixes required)
 *   [e2e]      e2e-tester (tests only)        --gate: e2e----------------------> [checkpoint] --> commit
 *     [repair] implementer, resumed (no e2e)  --gate: unit + e2e---------------> [checkpoint] --> commit   (if e2e failed)
 *   [docs]     docs-writer (docs only)        ---------------------------------> [checkpoint] --> commit
 *   [release]  release-manager (versions)     --gate: unit tests---------------> [checkpoint] --> commit
 *
 * Every stage runs in an isolated git worktree on its own branch. Gates are run by the
 * pipeline itself, never trusted from the agent's own report. A failed gate is fed back
 * to the same agent session, up to maxGateRetries times. With checkpoints on, a human
 * reviews each stage's result and can approve it, send feedback into the agent's session,
 * or stop the run.
 */
export async function runPipeline(req: PipelineRequest, deps: PipelineDeps): Promise<RunRecord> {
  const log = deps.log ?? (() => {});
  const { target, kind, request } = req;
  const crew = new Set<OptionalStage>(req.crew ?? DEFAULT_CREW);
  // Stages that don't apply to this kind of run are dropped, so the record shows what really ran.
  if (kind !== "bug") crew.delete("triage");
  if (kind === "deps") crew.delete("plan");
  const implementer = requireRole(deps.roles, kind === "deps" ? "dependency-updater" : (req.implementer ?? "backend"));
  const tester = target.e2e && crew.has("e2e") ? requireRole(deps.roles, "e2e-tester") : undefined;
  // Fail fast on a missing role file, before any worktree is created.
  const triager = crew.has("triage") ? requireRole(deps.roles, "bug-triager") : undefined;
  const planner = crew.has("plan") ? requireRole(deps.roles, "planner") : undefined;
  const reviewer = crew.has("review") ? requireRole(deps.roles, "reviewer") : undefined;
  const auditor = crew.has("security") ? requireRole(deps.roles, "security-auditor") : undefined;
  const docsWriter = crew.has("docs") ? requireRole(deps.roles, "docs-writer") : undefined;
  const releaser = crew.has("release") ? requireRole(deps.roles, "release-manager") : undefined;

  const provider = req.provider ?? deps.config.defaultProvider ?? "claude";
  if (provider === "codex" && req.budgetUsd !== undefined) throw new Error("Dollar budgets are only supported for Claude runs");
  const defaults = providerOptions(deps.config, provider);
  const model = req.model ?? defaults.model;
  const id = req.id ?? makeRunId(request);
  const repo = await repoRoot(target.path);
  const worktree = join(deps.config.worktreeRoot, id);
  const branch = `shipyard/${id}`;
  const baseSha = await createWorktree(repo, worktree, branch);

  const run: RunRecord = {
    id,
    kind,
    target: target.name,
    request,
    tags: req.tags ?? [],
    status: "running",
    createdAt: new Date().toISOString(),
    repo,
    branch,
    worktree,
    baseSha,
    provider,
    model,
    effort: req.effort ?? defaults.effort,
    crew: OPTIONAL_STAGES.filter((s) => crew.has(s)),
    implementer: implementer.name,
    budgetUsd: provider === "claude" ? req.budgetUsd ?? deps.config.maxBudgetUsdPerRun : undefined,
    stages: [],
    totals: { costUsd: provider === "codex" ? null : 0, durationMs: 0, turns: 0, attempts: 0, reviewWaitMs: 0 },
  };
  deps.store.save(run);
  log(`run ${id}`);
  log(`  branch   ${branch}`);
  log(`  worktree ${worktree}`);
  log(`  provider ${provider} · ${run.model ?? "Codex CLI default"}${run.effort ? ` · effort ${run.effort}` : ""}${run.budgetUsd !== undefined ? ` · budget ~$${run.budgetUsd} est.` : ""}`);
  log(`  crew     ${["implement", ...run.crew!].join(", ")} · implementer ${implementer.name}`);
  if (deps.checkpoints?.stages.length) log(`  checkpoints after: ${deps.checkpoints.stages.join(", ")}`);

  const maxAttempts = 1 + deps.config.maxGateRetries;
  const started = Date.now();

  const finish = (status: RunStatus): RunRecord => {
    run.status = deps.control?.stopped ? "stopped" : status;
    if (run.status === "stopped") {
      for (const stage of run.stages) if (stage.status === "running") stage.status = "stopped";
    }
    return run;
  };

  const commit = async (outcome: StageOutcome) => {
    if (deps.control?.stopped) throw new RunStoppedError();
    if (run.provider === "codex") {
      const outOfLane = (await changedFiles(worktree)).filter((file) => !inLane(file, outcome.lane));
      if (outOfLane.length) throw new Error(`Cannot commit ${outcome.record.name}: files outside the stage lane: ${outOfLane.join(", ")}`);
    }
    if (deps.control?.stopped) throw new RunStoppedError();
    outcome.record.commit = (await commitAll(worktree, commitMessage(outcome.record.name, run))) ?? undefined;
    deps.store.save(run);
  };

  try {
    // 0. Triage (bugs only): prove the bug with a failing test before anyone tries to fix it.
    let triage: TriageReport | undefined;
    if (triager) {
      const triaged = await runStage(
        {
          name: "triage",
          role: triager,
          lane: "tests",
          prompt: triagePrompt(request, target),
          gates: [target.test],
          expectGateFailure: true,
          failurePrompt: () => notReproducedPrompt(true),
          maxAttempts,
          outputSchema: TRIAGE_SCHEMA as unknown as Record<string, unknown>,
          judge: (r) => {
            if (!isTriageReport(r.structured)) return { passed: false, feedback: notReproducedPrompt(false), summary: r.summary || "The triager returned no report." };
            const report = r.structured;
            return { passed: report.reproduced, feedback: notReproducedPrompt(false), summary: formatTriage(report), output: report };
          },
        },
        run,
        deps,
      );
      if (triaged.stopped) return finish("stopped");
      if (!triaged.passed) {
        log(`  the bug could not be reproduced`);
        return finish("failed");
      }
      triage = triaged.output as TriageReport;
      await commit(triaged);
    }

    // 1. Plan: the planner studies the repo (and may ask you questions) before any code is written.
    let plan: string | undefined;
    if (planner) {
      const planned = await runStage(
        {
          name: "plan",
          role: planner,
          lane: "none",
          readOnly: true,
          prompt: planPrompt(kind, request, target),
          gates: [],
          maxAttempts,
          judge: (r) => (r.summary.trim().length >= 80 ? { passed: true } : { passed: false, feedback: planMissingPrompt() }),
        },
        run,
        deps,
      );
      if (planned.stopped) return finish("stopped");
      if (!planned.passed) return finish("failed");
      plan = planned.summary;
    }

    // 2. Implement, gated by the unit tests.
    const impl = await runStage(
      {
        name: "implement",
        role: implementer,
        lane: "any",
        prompt: implementPrompt(kind, request, target, plan, triage),
        gates: [target.test],
        maxAttempts,
        // Everything already current is a fine result for a dependency update.
        allowNoChanges: kind === "deps",
      },
      run,
      deps,
    );
    if (impl.stopped) return finish("stopped");
    if (!impl.passed) return finish("failed");
    await commit(impl);
    let implementerSession = impl.session;

    // 3. Review: a fresh session that never saw the implementer's reasoning. Read-only.
    if (reviewer) {
      const review = await runStage(
        {
          name: "review",
          role: reviewer,
          lane: "none",
          readOnly: true,
          prompt: reviewPrompt(kind, request, baseSha, plan),
          gates: [],
          maxAttempts: 1,
          failureContinues: true,
          outputSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
          judge: (r) => {
            if (!isReviewVerdict(r.structured)) return { passed: false, summary: r.summary || "The reviewer returned no verdict." };
            const verdict = r.structured;
            const blocking = blockingFindings(verdict);
            return { passed: blocking.length === 0, summary: formatFindings(verdict), output: verdict, feedback: blocking.length ? revisePrompt(verdict) : undefined };
          },
        },
        run,
        deps,
      );
      if (review.stopped) return finish("stopped");
      if (!review.passed) {
        if (!review.judgeFeedback) {
          log(`  the reviewer gave no verdict`);
          return finish("failed");
        }
        // 3b. Revise: the implementer addresses the findings in its own session, gated by the tests.
        const revise = await runStage(
          {
            name: "revise",
            role: implementer,
            lane: "any",
            prompt: review.judgeFeedback,
            gates: [target.test],
            maxAttempts,
            resumeSession: implementerSession,
            // The implementer may disagree with a finding and explain why instead of changing code.
            allowNoChanges: true,
          },
          run,
          deps,
        );
        if (revise.stopped) return finish("stopped");
        if (!revise.passed) return finish("failed");
        await commit(revise);
        implementerSession = revise.session ?? implementerSession;
      }
    }

    // 3c. Security audit: read-only, like an attacker would look at it. Critical/high -> harden.
    if (auditor) {
      const audit = await runStage(
        {
          name: "security",
          role: auditor,
          lane: "none",
          readOnly: true,
          prompt: securityPrompt(kind, request, baseSha),
          gates: [],
          maxAttempts: 1,
          failureContinues: true,
          outputSchema: SECURITY_SCHEMA as unknown as Record<string, unknown>,
          judge: (r) => {
            if (!isSecurityVerdict(r.structured)) return { passed: false, summary: r.summary || "The security auditor returned no verdict." };
            const verdict = r.structured;
            const blocking = blockingSecurityFindings(verdict);
            return {
              passed: blocking.length === 0,
              summary: formatSecurityFindings(verdict),
              output: verdict,
              feedback: blocking.length ? hardenPrompt(verdict) : undefined,
            };
          },
        },
        run,
        deps,
      );
      if (audit.stopped) return finish("stopped");
      if (!audit.passed) {
        if (!audit.judgeFeedback) {
          log(`  the security auditor gave no verdict`);
          return finish("failed");
        }
        const harden = await runStage(
          {
            name: "harden",
            role: implementer,
            lane: "any",
            prompt: audit.judgeFeedback,
            gates: [target.test],
            maxAttempts,
            resumeSession: implementerSession,
            // As with revise: an explained disagreement is allowed, and you see it at the checkpoint.
            allowNoChanges: true,
          },
          run,
          deps,
        );
        if (harden.stopped) return finish("stopped");
        if (!harden.passed) return finish("failed");
        await commit(harden);
        implementerSession = harden.session ?? implementerSession;
      }
    }

    // 4. E2E tester proves the change from the outside. One attempt: a failure here is a finding, not a retry.
    if (tester && target.e2e) {
      const e2e = await runStage(
        {
          name: "e2e",
          role: tester,
          lane: "tests",
          prompt: e2ePrompt(kind, request, impl.summary, target, baseSha),
          gates: [target.e2e],
          maxAttempts: 1,
          failureContinues: true,
        },
        run,
        deps,
      );
      if (e2e.stopped) return finish("stopped");
      // Commit the tests even when they fail: they are the spec the repair stage must meet.
      await commit(e2e);

      if (!e2e.passed && e2e.lastFailure && !crew.has("repair")) {
        log(`  E2E failed and repair is switched off for this run`);
        return finish("failed");
      } else if (!e2e.passed && e2e.lastFailure) {
        // 4b. Cross-agent feedback: the implementer gets the tester's failure, in its own session.
        const repair = await runStage(
          {
            name: "repair",
            role: implementer,
            lane: "no-e2e",
            prompt: repairPrompt(e2e.lastFailure, e2e.summary),
            gates: [target.test, target.e2e],
            maxAttempts,
            resumeSession: implementerSession,
          },
          run,
          deps,
        );
        if (repair.stopped) return finish("stopped");
        if (!repair.passed) return finish("failed");
        await commit(repair);
      } else if (!e2e.passed) {
        return finish("failed");
      }
    }

    // 5. Docs: bring the README, changelog and docs in line with the change.
    if (docsWriter) {
      const docs = await runStage(
        { name: "docs", role: docsWriter, lane: "docs", allowNoChanges: true, prompt: docsPrompt(kind, request, baseSha), gates: [], maxAttempts },
        run,
        deps,
      );
      if (docs.stopped) return finish("stopped");
      if (!docs.passed) return finish("failed");
      await commit(docs);
    }

    // 6. Release: version bump and release notes. Publishing stays with a human.
    if (releaser) {
      const release = await runStage(
        {
          name: "release",
          role: releaser,
          lane: "release",
          allowNoChanges: true,
          prompt: releasePrompt(kind, request, baseSha),
          gates: [target.test],
          maxAttempts,
        },
        run,
        deps,
      );
      if (release.stopped) return finish("stopped");
      if (!release.passed) return finish("failed");
      await commit(release);
    }
    return finish("passed");
  } catch (err) {
    if (deps.control?.stopped || err instanceof RunStoppedError) return finish("stopped");
    run.error = err instanceof Error ? err.message : String(err);
    if (err instanceof BudgetReachedError) {
      log(`  ${run.error}`);
      return finish("failed");
    }
    log(`  error: ${run.error}`);
    // Don't leave an empty branch and worktree behind in the target repo for a run that produced nothing.
    if (
      run.stages.every((s) => !s.commit) &&
      (await changedFiles(worktree).catch(() => ["?"])).length === 0 &&
      (await git(["rev-parse", "HEAD"], worktree).catch(() => "")) === baseSha &&
      (await git(["symbolic-ref", "HEAD"], worktree).catch(() => "")) === `refs/heads/${branch}`
    ) {
      await removeWorktree(repo, worktree);
      await git(["branch", "-D", branch], repo).catch(() => {});
      run.cleanedUp = true;
      log(`  removed the empty worktree and branch`);
    }
    return finish("error");
  } finally {
    run.finishedAt = new Date().toISOString();
    run.totals = { ...sumAttempts(run), durationMs: Date.now() - started };
    deps.store.save(run);
    const mark = run.status === "passed" ? "✓" : run.status === "stopped" ? "■" : "✗";
    const { durationMs, reviewWaitMs } = run.totals;
    const time = reviewWaitMs > 0 ? `${secs(durationMs - reviewWaitMs)} working + ${secs(reviewWaitMs)} waiting for you` : secs(durationMs);
    const spend = run.totals.costUsd === null
      ? `cost unavailable${run.totals.usage ? ` · ${run.totals.usage.inputTokens} input / ${run.totals.usage.outputTokens} output tokens` : ""}`
      : `~$${run.totals.costUsd.toFixed(2)} est.`;
    log(`${mark} ${run.status} · ${spend} · ${time} · ${run.totals.attempts} attempts`);
  }
}

/** What is left of the run's budget, or undefined when the run has no limit. */
function budgetLeft(run: RunRecord): number | undefined {
  return run.provider === "codex" || run.budgetUsd === undefined ? undefined : run.budgetUsd - (sumAttempts(run).costUsd ?? 0);
}

const outOfBudget = (run: RunRecord): boolean => {
  const left = budgetLeft(run);
  return left !== undefined && left < MIN_ATTEMPT_BUDGET_USD;
};

function budgetReached(run: RunRecord, stage: StageName): BudgetReachedError {
  const spent = sumAttempts(run).costUsd ?? 0;
  return new BudgetReachedError(
    `Stopped before ${stage}: the run used ~$${spent.toFixed(2)} of its ~$${run.budgetUsd} budget (est.). ` +
      `Start it again with a higher budget, or raise maxBudgetUsdPerRun in shipyard.config.yaml.`,
  );
}

async function runStage(spec: StageSpec, run: RunRecord, deps: PipelineDeps): Promise<StageOutcome> {
  const log = deps.log ?? (() => {});
  const control = deps.control;
  if (control?.stopped) throw new RunStoppedError();
  // Runs without live controls keep the existing budget check before creating a stage record.
  if (!control && outOfBudget(run)) throw budgetReached(run, spec.name);
  const stage: StageRecord = { name: spec.name, role: spec.role.name, status: "running", attempts: [] };
  run.stages.push(stage);
  deps.store.save(run);

  const reviewed = deps.checkpoints?.stages.includes(spec.name) ?? false;
  let session = spec.resumeSession;
  let prompt = spec.prompt;
  let summary = "";
  let lastFailure: ExecResult | undefined;
  let judgeFeedback: string | undefined;
  let output: unknown;
  let failuresInARow = 0;

  const done = (status: "passed" | "failed" | "stopped"): StageOutcome => {
    stage.status = status;
    deps.store.save(run);
    return { lane: spec.lane, record: stage, passed: status === "passed", stopped: status === "stopped", session, summary, lastFailure, judgeFeedback, output };
  };

  for (let attempt = 1; ; attempt++) {
    if (control?.stopped) return done("stopped");
    const directive = control?.takeDirective();
    const switching = directive?.provider && directive.provider !== run.provider;
    if (switching && directive?.provider) {
      const provider = directive.provider;
      const defaults = providerOptions(deps.config, provider);
      run.provider = provider;
      run.model = defaults.model;
      run.effort = defaults.effort;
      if (provider === "claude") run.budgetUsd ??= deps.config.maxBudgetUsdPerRun;
      deps.store.save(run);
    }
    const provider = run.provider ?? "claude";
    if (switching || session?.provider !== provider) session = undefined;
    if (outOfBudget(run)) {
      if (attempt === 1) {
        run.stages.pop();
        deps.store.save(run);
      } else {
        done("failed");
      }
      throw budgetReached(run, spec.name);
    }
    if (directive) failuresInARow = 0;
    const signal = control?.beginAttempt();
    const retry = failuresInARow > 0 ? ` · retry ${failuresInARow}/${spec.maxAttempts - 1}` : "";
    log(`▸ ${spec.name} · ${spec.role.name} · attempt ${attempt}${retry}`);
    const ask = provider === "claude" ? deps.ask : undefined;
    let askWaitMs = 0;
    const askHuman = ask
      ? async (question: AgentAsk) => {
          const asked = Date.now();
          try {
            return await ask({ runId: run.id, stage: spec.name, role: spec.role.name }, question, signal);
          } finally {
            askWaitMs += Date.now() - asked;
          }
        }
      : undefined;
    const instructions = control?.instructions;
    const needsContext = !session && (switching || attempt > 1 || spec.resumeSession);
    const context = needsContext
      ? [`Original request: ${run.request}`, prompt === spec.prompt ? "" : spec.prompt, summary && `Previous attempt summary: ${summary}`,
          "Continue on the existing worktree. Inspect its current changes before editing."]
      : [];
    const attemptPrompt = [
      ...context,
      prompt,
      askHuman ? humanAvailableNote() : "",
      instructions?.length ? `Updated instructions from the user (latest last):\n${instructions.join("\n\n")}` : "",
    ].filter(Boolean).join("\n\n");
    deps.store.event(run.id, { stage: spec.name, attempt, provider, type: "attempt_start", prompt: attemptPrompt });

    // A runner that throws is treated like one that reports an error, so the stage is closed
    // properly (failed) instead of being left "running" in the record.
    const runner = deps.runnerForProvider?.(provider) ?? deps.runner;
    const result = await runner
      .run({
        role: spec.role,
        prompt: attemptPrompt,
        signal,
        cwd: run.worktree,
        lane: spec.lane,
        resumeSessionId: session?.id,
        ask: askHuman,
        model: run.model,
        effort: run.effort,
        outputSchema: spec.outputSchema,
        maxBudgetUsd: budgetLeft(run),
        onEvent: (event) => {
          deps.store.event(run.id, { stage: spec.name, attempt, ...event });
          if (event.type === "tool") log(`    · ${event.tool} ${event.detail}`);
          if (event.type === "denied") log(`    ✗ denied ${event.tool}: ${event.reason}`);
        },
      })
      .catch(
        (err: unknown): AgentResult => ({
          ok: false,
          costUsd: provider === "codex" ? null : 0,
          turns: 0,
          durationMs: 0,
          summary: "",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    if (result.sessionId) session = { provider, id: result.sessionId };
    summary = result.summary || summary;
    if (!result.ok) log(`    agent stopped: ${result.error ?? "unknown error"}`);

    const base = {
      attempt,
      provider,
      sessionId: result.sessionId,
      agentOk: result.ok,
      agentError: result.error,
      costUsd: provider === "codex" ? null : result.costUsd,
      usage: result.usage,
      turns: result.turns,
      durationMs: result.durationMs,
      summary: result.summary,
      askWaitMs: askWaitMs || undefined,
    };

    // Backstop for the lane hook: an agent can still write files through Bash.
    // For read-only roles every change is out of lane, so this undoes anything they touched.
    const outOfLane = (await changedFiles(run.worktree)).filter((f) => !inLane(f, spec.lane));
    if (outOfLane.length > 0) {
      await revertFiles(run.worktree, outOfLane);
      log(`    reverted out-of-lane changes: ${outOfLane.join(", ")}`);
    }

    const recordInterruption = (gates: GateRecord[] = []) => {
      const interrupted = control?.stopped ? "stopped" : "redirected";
      stage.attempts.push({ ...base, interrupted, revertedFiles: outOfLane.length ? outOfLane : undefined, gates, passed: false });
      run.totals = { ...sumAttempts(run), durationMs: run.totals.durationMs };
      deps.store.event(run.id, { stage: spec.name, attempt, type: "attempt_interrupted", interrupted });
      deps.store.save(run);
    };
    if (signal?.aborted) {
      recordInterruption();
      if (control?.stopped) return done("stopped");
      continue;
    }

    // An agent that could not work (sign-in, API error, crash) is an infrastructure failure, not a
    // result. Running the gates now would grade the untouched code and could report a false pass,
    // and retrying would fail the same way. Only hitting a turn or budget cap still gets graded.
    if (!result.ok && !LIMIT_ERRORS.has(result.error ?? "")) {
      stage.attempts.push({ ...base, revertedFiles: outOfLane.length ? outOfLane : undefined, gates: [], passed: false });
      done("failed");
      throw new Error(`${spec.role.name} agent could not run: ${result.error ?? "unknown error"}`);
    }

    // Green tests on an unchanged tree prove nothing: stages that build must change something.
    const requireChanges = !spec.readOnly && !spec.allowNoChanges;
    const noChanges = requireChanges && (await changedFiles(run.worktree)).length === 0;
    if (noChanges) log(`    ✗ no changes in the worktree`);

    // Gates run here, by the pipeline, regardless of what the agent claims.
    const gates: GateRecord[] = [];
    let failed: ExecResult | undefined;
    if (!noChanges) {
      for (const command of spec.gates) {
        const gate = await sh(command, run.worktree, deps.gateTimeoutMs, signal);
        if (signal?.aborted) break;
        // Normally a gate must pass. For triage it must fail (and not just time out): that proves the bug.
        const wrongWay = spec.expectGateFailure ? gate.code === 0 || gate.timedOut : gate.code !== 0;
        gates.push({
          command,
          expectFailure: spec.expectGateFailure || undefined,
          code: gate.code,
          durationMs: gate.durationMs,
          timedOut: gate.timedOut,
          outputTail: tail(gate.output, 4000),
        });
        const note = spec.expectGateFailure ? (wrongWay ? " (passes: bug not reproduced)" : " (fails as expected: bug reproduced)") : "";
        log(`    ${wrongWay ? "✗" : "✓"} gate \`${command}\`${note} (${(gate.durationMs / 1000).toFixed(1)}s)`);
        if (wrongWay) {
          failed = gate;
          break;
        }
      }
    }

    if (signal?.aborted) {
      recordInterruption(gates);
      if (control?.stopped) return done("stopped");
      continue;
    }

    // Then the judge, for stages whose result is what the agent says (a plan, a review verdict).
    const judgement: Judgement | undefined = !noChanges && !failed && spec.judge ? spec.judge(result) : undefined;
    if (judgement?.summary !== undefined) summary = judgement.summary;
    if (judgement?.output !== undefined) output = judgement.output;
    const judgeFailed = judgement !== undefined && !judgement.passed;
    if (judgement) log(`    ${judgement.passed ? "✓" : "✗"} ${spec.name === "review" ? "review verdict" : "check"}`);
    const passed = !noChanges && !failed && !judgeFailed;

    const record: AttemptRecord = {
      ...base,
      summary: judgement?.summary ?? base.summary,
      revertedFiles: outOfLane.length ? outOfLane : undefined,
      noChanges: noChanges || undefined,
      gates,
      output: judgement?.output,
      passed,
    };
    stage.attempts.push(record);
    run.totals = { ...sumAttempts(run), durationMs: run.totals.durationMs };
    deps.store.save(run);

    if (!passed) {
      failuresInARow++;
      lastFailure = failed ?? lastFailure;
      judgeFeedback = judgeFailed ? judgement!.feedback : undefined;
      prompt =
        (failed ? (spec.failurePrompt ?? gateFailurePrompt)(failed) : judgeFailed ? (judgement!.feedback ?? "Try again.") : noChangesPrompt()) +
        (outOfLane.length ? `\n\n${lanePrompt(outOfLane)}` : "");
      if (failuresInARow < spec.maxAttempts) continue; // automatic retry, no human needed yet
    }

    if (!reviewed) return done(passed ? "passed" : "failed");

    // Checkpoint: the human decides.
    const reviewStarted = Date.now();
    const decision = await deps.checkpoints!.review({
      runId: run.id,
      provider: run.provider,
      stage: spec.name,
      role: spec.role.name,
      outcome: passed ? "passed" : "failed",
      canContinue: passed || Boolean(spec.failureContinues && (failed || judgeFailed)),
      attempt,
      summary: record.summary,
      gates,
      noChanges,
      worktree: run.worktree,
      sessionId: session?.id,
    }, signal);
    if (signal?.aborted && !control?.stopped) {
      record.interrupted = "redirected";
      record.interruptionWaitMs = Date.now() - reviewStarted;
      run.totals = { ...sumAttempts(run), durationMs: run.totals.durationMs };
      deps.store.event(run.id, { stage: spec.name, attempt, type: "attempt_interrupted", interrupted: "redirected" });
      deps.store.save(run);
      continue;
    }
    record.review = {
      action: decision.action,
      message: decision.action === "feedback" ? decision.message : undefined,
      at: new Date().toISOString(),
      waitMs: Date.now() - reviewStarted,
    };
    run.totals = { ...sumAttempts(run), durationMs: run.totals.durationMs };
    deps.store.save(run);
    deps.store.event(run.id, { stage: spec.name, attempt, type: "checkpoint", ...record.review });

    if (decision.action === "stop") {
      log(`    ■ stopped at the ${spec.name} checkpoint`);
      return done("stopped");
    }
    if (decision.action === "continue") {
      log(passed ? `    ✓ approved` : `    → continuing past the failure`);
      return done(passed ? "passed" : "failed");
    }
    log(`    ↻ feedback sent to ${spec.role.name}`);
    // After a pass the agent only needs the feedback; after a failure it also needs the gate output
    // it never saw (the pipeline paused instead of retrying).
    prompt = passed ? reviewerFeedbackPrompt(decision.message, "passed") : reviewerFeedbackPrompt(decision.message, "failed", prompt);
    failuresInARow = 0;
  }
}

function sumAttempts(run: RunRecord) {
  let costUsd = 0;
  let hasClaude = run.provider !== "codex";
  let turns = 0;
  let attempts = 0;
  let reviewWaitMs = 0;
  let usage: TokenUsage | undefined;
  for (const s of run.stages) {
    for (const a of s.attempts) {
      hasClaude ||= a.provider === "claude";
      costUsd += a.costUsd ?? 0;
      if (a.usage) usage = addTokenUsage(usage, a.usage);
      turns += a.turns;
      attempts++;
      reviewWaitMs += (a.review?.waitMs ?? 0) + (a.askWaitMs ?? 0) + (a.interruptionWaitMs ?? 0);
    }
  }
  return { costUsd: hasClaude ? costUsd : null, usage, turns, attempts, reviewWaitMs };
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** The first line of the request, cut at a word boundary so commit titles never end mid-word. */
export function commitTitle(request: string, max = 60): string {
  const line = request.split("\n")[0]!.trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "") + "…";
}

function commitMessage(stage: string, run: RunRecord): string {
  const title = commitTitle(run.request);
  return `shipyard(${stage}): ${title}\n\nRun: ${run.id}\nKind: ${run.kind}\nTarget: ${run.target}`;
}

export function makeRunId(request: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug =
    request
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .join("-")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `${stamp}-${slug}-${randomBytes(2).toString("hex")}`;
}
