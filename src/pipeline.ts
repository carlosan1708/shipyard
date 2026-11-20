import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentRunner } from "./agent.ts";
import type { ShipyardConfig, Target } from "./config.ts";
import { git, sh, tail, type ExecResult } from "./exec.ts";
import { inLane, type Lane } from "./guards.ts";
import { e2ePrompt, gateFailurePrompt, implementPrompt, lanePrompt, noChangesPrompt, repairPrompt } from "./prompts.ts";
import { requireRole, type Role } from "./roles.ts";
import type { GateRecord, RunKind, RunRecord, RunStatus, RunStore, StageRecord } from "./store.ts";
import { changedFiles, commitAll, createWorktree, removeWorktree, repoRoot, revertFiles } from "./worktree.ts";

/** Agent stops that still deserve grading: the agent ran out of room, but may have done the work. */
const LIMIT_ERRORS = new Set(["error_max_turns", "error_max_budget_usd"]);

export interface PipelineDeps {
  config: Pick<ShipyardConfig, "model" | "maxGateRetries" | "worktreeRoot">;
  runner: AgentRunner;
  store: RunStore;
  roles: Map<string, Role>;
  log?: (line: string) => void;
  /** Gate timeout per command. */
  gateTimeoutMs?: number;
}

export interface PipelineRequest {
  target: Target;
  kind: RunKind;
  request: string;
  tags?: string[];
}

interface StageSpec {
  name: string;
  role: Role;
  lane: Lane;
  prompt: string;
  gates: string[];
  maxAttempts: number;
  resumeSessionId?: string;
}

interface StageOutcome {
  record: StageRecord;
  passed: boolean;
  sessionId?: string;
  summary: string;
  lastFailure?: ExecResult;
}

/**
 * The shipyard pipeline:
 *
 *   implement (backend) --gate: unit tests--> commit
 *   e2e (e2e-tester, tests-only lane) --gate: e2e--> commit
 *   repair (backend, resumed, may not touch E2E tests) --gate: unit + e2e--> commit   [only if e2e failed]
 *
 * Every stage runs in an isolated git worktree on its own branch. Gates are run by the
 * pipeline itself, never trusted from the agent's own report. A failed gate is fed back
 * to the same agent session, up to maxGateRetries times.
 */
export async function runPipeline(req: PipelineRequest, deps: PipelineDeps): Promise<RunRecord> {
  const log = deps.log ?? (() => {});
  const { target, kind, request } = req;
  const backend = requireRole(deps.roles, "backend");
  const tester = target.e2e ? requireRole(deps.roles, "e2e-tester") : undefined;

  const id = makeRunId(request);
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
    model: deps.config.model,
    stages: [],
    totals: { costUsd: 0, durationMs: 0, turns: 0, attempts: 0 },
  };
  deps.store.save(run);
  log(`run ${id}`);
  log(`  branch   ${branch}`);
  log(`  worktree ${worktree}`);

  const maxAttempts = 1 + deps.config.maxGateRetries;
  const started = Date.now();

  const finish = (status: RunStatus): RunRecord => {
    run.status = status;
    return run;
  };

  try {
    // 1. Implement, gated by the unit tests.
    const impl = await runStage(
      { name: "implement", role: backend, lane: "any", prompt: implementPrompt(kind, request, target), gates: [target.test], maxAttempts },
      run,
      deps,
    );
    if (!impl.passed) return finish("failed");
    impl.record.commit = (await commitAll(worktree, commitMessage("implement", run))) ?? undefined;

    if (tester && target.e2e) {
      // 2. E2E tester proves the change from the outside. One attempt: a failure here is a finding, not a retry.
      const e2e = await runStage(
        { name: "e2e", role: tester, lane: "tests", prompt: e2ePrompt(kind, request, impl.summary, target), gates: [target.e2e], maxAttempts: 1 },
        run,
        deps,
      );
      // Commit the tests even when they fail: they are the spec the repair stage must meet.
      e2e.record.commit = (await commitAll(worktree, commitMessage("e2e", run))) ?? undefined;

      if (!e2e.passed && e2e.lastFailure) {
        // 3. Cross-agent feedback: the implementer gets the tester's failure, in its original session.
        const repair = await runStage(
          {
            name: "repair",
            role: backend,
            lane: "no-e2e",
            prompt: repairPrompt(e2e.lastFailure, e2e.summary),
            gates: [target.test, target.e2e],
            maxAttempts,
            resumeSessionId: impl.sessionId,
          },
          run,
          deps,
        );
        if (!repair.passed) return finish("failed");
        repair.record.commit = (await commitAll(worktree, commitMessage("repair", run))) ?? undefined;
      } else if (!e2e.passed) {
        return finish("failed");
      }
    }
    return finish("passed");
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
    log(`  error: ${run.error}`);
    // Don't leave an empty branch and worktree behind in the target repo for a run that produced nothing.
    if ((await changedFiles(worktree).catch(() => ["?"])).length === 0 && run.stages.every((s) => !s.commit)) {
      await removeWorktree(repo, worktree);
      await git(["branch", "-D", branch], repo).catch(() => {});
      run.cleanedUp = true;
      log(`  removed the empty worktree and branch`);
    }
    return finish("error");
  } finally {
    run.finishedAt = new Date().toISOString();
    run.totals = { ...sumAttempts(run.stages), durationMs: Date.now() - started };
    deps.store.save(run);
    log(`${run.status === "passed" ? "✓" : "✗"} ${run.status} · ~$${run.totals.costUsd.toFixed(2)} est. ·${(run.totals.durationMs / 1000).toFixed(0)}s · ${run.totals.attempts} attempts`);
  }
}

async function runStage(spec: StageSpec, run: RunRecord, deps: PipelineDeps): Promise<StageOutcome> {
  const log = deps.log ?? (() => {});
  const stage: StageRecord = { name: spec.name, role: spec.role.name, status: "running", attempts: [] };
  run.stages.push(stage);
  deps.store.save(run);

  let sessionId = spec.resumeSessionId;
  let prompt = spec.prompt;
  let summary = "";
  let lastFailure: ExecResult | undefined;

  for (let attempt = 1; attempt <= spec.maxAttempts; attempt++) {
    log(`▸ ${spec.name} · ${spec.role.name} · attempt ${attempt}/${spec.maxAttempts}`);
    deps.store.event(run.id, { stage: spec.name, attempt, type: "attempt_start", prompt });

    const result = await deps.runner.run({
      role: spec.role,
      prompt,
      cwd: run.worktree,
      lane: spec.lane,
      resumeSessionId: sessionId,
      onEvent: (event) => {
        deps.store.event(run.id, { stage: spec.name, attempt, ...event });
        if (event.type === "tool") log(`    · ${event.tool} ${event.detail}`);
        if (event.type === "denied") log(`    ✗ denied ${event.tool}: ${event.reason}`);
      },
    });
    sessionId = result.sessionId ?? sessionId;
    summary = result.summary || summary;
    if (!result.ok) log(`    agent stopped: ${result.error ?? "unknown error"}`);

    const record = {
      attempt,
      sessionId: result.sessionId,
      agentOk: result.ok,
      agentError: result.error,
      costUsd: result.costUsd,
      turns: result.turns,
      durationMs: result.durationMs,
      summary: result.summary,
    };

    // An agent that could not work (sign-in, API error, crash) is an infrastructure failure, not a
    // result. Running the gates now would grade the untouched code and could report a false pass,
    // and retrying would fail the same way. Only hitting a turn or budget cap still gets graded.
    if (!result.ok && !LIMIT_ERRORS.has(result.error ?? "")) {
      stage.attempts.push({ ...record, gates: [], passed: false });
      stage.status = "failed";
      deps.store.save(run);
      throw new Error(`${spec.role.name} agent could not run: ${result.error ?? "unknown error"}`);
    }

    // Backstop for the lane hook: an agent can still write files through Bash.
    const outOfLane = (await changedFiles(run.worktree)).filter((f) => !inLane(f, spec.lane));
    if (outOfLane.length > 0) {
      await revertFiles(run.worktree, outOfLane);
      log(`    reverted out-of-lane changes: ${outOfLane.join(", ")}`);
    }

    // Green tests on an unchanged tree prove nothing: every stage must change something.
    const noChanges = (await changedFiles(run.worktree)).length === 0;
    if (noChanges) log(`    ✗ no changes in the worktree`);

    // Gates run here, by the pipeline, regardless of what the agent claims.
    const gates: GateRecord[] = [];
    let failed: ExecResult | undefined;
    if (!noChanges) {
      for (const command of spec.gates) {
        const gate = await sh(command, run.worktree, deps.gateTimeoutMs);
        gates.push({ command, code: gate.code, durationMs: gate.durationMs, timedOut: gate.timedOut, outputTail: tail(gate.output, 4000) });
        log(`    ${gate.code === 0 ? "✓" : "✗"} gate \`${command}\` (${(gate.durationMs / 1000).toFixed(1)}s)`);
        if (gate.code !== 0) {
          failed = gate;
          break;
        }
      }
    }
    const passed = !noChanges && !failed;

    stage.attempts.push({
      ...record,
      revertedFiles: outOfLane.length ? outOfLane : undefined,
      noChanges: noChanges || undefined,
      gates,
      passed,
    });
    run.totals = { ...sumAttempts(run.stages), durationMs: run.totals.durationMs };
    deps.store.save(run);

    if (passed) {
      stage.status = "passed";
      return { record: stage, passed: true, sessionId, summary };
    }
    lastFailure = failed ?? lastFailure;
    prompt = (failed ? gateFailurePrompt(failed) : noChangesPrompt()) + (outOfLane.length ? `\n\n${lanePrompt(outOfLane)}` : "");
  }

  stage.status = "failed";
  deps.store.save(run);
  return { record: stage, passed: false, sessionId, summary, lastFailure };
}

function sumAttempts(stages: StageRecord[]) {
  let costUsd = 0;
  let turns = 0;
  let attempts = 0;
  for (const s of stages) {
    for (const a of s.attempts) {
      costUsd += a.costUsd;
      turns += a.turns;
      attempts++;
    }
  }
  return { costUsd, turns, attempts };
}

function commitMessage(stage: string, run: RunRecord): string {
  const title = run.request.split("\n")[0]!.trim().slice(0, 60);
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
