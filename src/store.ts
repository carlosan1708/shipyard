import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage } from "./agent.ts";
import type { FeedbackAttachment } from "./attachments.ts";
import type { DeploymentProvider, Provider, RunEffort } from "./config.ts";
import type { ReferenceCheck } from "./references.ts";

/** feature: ship something new · bug: fix a reported problem · deps: update dependencies. */
export type RunKind = "feature" | "bug" | "deps";
/** Stopping a run preserves its branch and worktree. */
export type RunStatus = "running" | "passed" | "failed" | "error" | "stopped";

export interface DeploymentRecord {
  provider: DeploymentProvider;
  sourceRunId: string;
  pullRequest?: string;
  phase: "verifying" | "approval" | "publishing" | "published" | "failed" | "cancelled";
  review?: import("./ui/firebase-release.ts").FirebaseHostingReview;
  workflowReview?: import("./ui/workflow-deployment.ts").WorkflowDeploymentReview;
  dispatchStarted?: boolean;
  workflowRun?: import("./ui/workflow-deployment.ts").DeploymentWorkflowRun;
}

/** What a human decided at a checkpoint. */
export type ReviewAction = "continue" | "feedback" | "stop";
export interface ReviewRecord {
  action: ReviewAction;
  message?: string;
  attachments?: FeedbackAttachment[];
  at: string;
  /** How long the run waited for the human at this checkpoint. */
  waitMs: number;
}

export interface GateRecord {
  command: string;
  /** Bug triage expects the project test command to fail. */
  expectFailure?: boolean;
  code: number;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
  checkedAt?: string;
}

export interface BugVerification {
  baseSha: string;
  head: string;
  expected?: string;
  actual?: string;
  testFile?: string;
  testName?: string;
  assertionMessage?: string;
  approved: boolean;
  before?: RegressionObservation;
  after?: RegressionObservation;
  gap?: string;
  recheck?: { head: string; gap: string };
}

export interface RegressionObservation {
  outcome: "expected-failure" | "passed" | "inconclusive";
  exitCode: number;
  durationMs: number;
  detail: string;
}

/** Did this gate go the way it should? Normally that means it passed; for a triage, that it failed. */
export const gateOk = (g: GateRecord): boolean => (g.expectFailure ? g.code !== 0 && !g.timedOut : g.code === 0);

export interface AttemptRecord {
  attempt: number;
  role?: string;
  rechecked?: boolean;
  provider?: Provider;
  interrupted?: "stopped" | "redirected" | "interrupted";
  interruptionWaitMs?: number;
  sessionId?: string;
  agentOk: boolean;
  agentError?: string;
  costUsd: number | null;
  usage?: TokenUsage;
  turns: number;
  durationMs: number;
  summary: string;
  /** Files the agent changed outside its lane; the pipeline reverted them. */
  revertedFiles?: string[];
  /** The agent finished but left the worktree unchanged; gates were not run. */
  noChanges?: boolean;
  gates: GateRecord[];
  passed: boolean;
  /** Set when a checkpoint paused after this attempt. */
  review?: ReviewRecord;
  /** Time the agent spent blocked on a human's answer (questions, permission requests) during this attempt. */
  askWaitMs?: number;
  /** Structured result of the attempt, e.g. the reviewer's verdict and findings. */
  output?: unknown;
  /** Reports from browser inspections the specialist requested during this attempt. */
  browserInspections?: string[];
}

export function recoverableStage(run: RunRecord): StageRecord | undefined {
  if (!run.finishedAt || run.cleanedUp || !["failed", "stopped", "error"].includes(run.status)) return;
  const stage = run.stages.at(-1);
  if (!stage || stage.finalized || stage.commit || !["failed", "stopped"].includes(stage.status)) return;
  if (stage.attempts.some((attempt) => !attempt.interrupted && attempt.gates.some((gate) => !gate.expectFailure && !gateOk(gate)))) return stage;
}

export function repairableRevisionStage(run: RunRecord): StageRecord | undefined {
  const stage = recoverableStage(run);
  if (run.followUp?.orchestrated && stage && canRepairRevisionRole(stage.name)) return stage;
}

export const canRepairRevisionRole = (role: string): boolean => ["frontend", "ui-ux", "backend"].includes(role);

export interface StageRecord {
  name: string;
  role: string;
  parallel?: boolean;
  repairRole?: string;
  autoRepair?: { command: string; afterAttempt: number };
  status: "running" | "passed" | "failed" | "stopped";
  attempts: AttemptRecord[];
  commit?: string;
  finalized?: boolean;
}

export interface RunFollowUp {
  runId: string;
  brief: string;
  baseSha: string;
  orchestrated?: true;
  attachments?: FeedbackAttachment[];
}

export interface RunRecord {
  id: string;
  kind: RunKind | "deployment";
  target: string;
  request: string;
  tags: string[];
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  completionRead?: boolean;
  publication?: { head: string; destination: string; pushedAt: string; pullRequestUrl?: string };
  cloudRelease?: import("./ui/cloud-release.ts").CloudRunRelease;
  firebaseRelease?: import("./ui/firebase-release.ts").FirebaseHostingRelease;
  deployment?: DeploymentRecord;
  archivedAt?: string;
  ownerPid?: number;
  checkpointStages?: string[];
  repo: string;
  branch: string;
  worktree: string;
  baseSha: string;
  /** The fork point of the shared branch, before any rounds of feedback. */
  branchBaseSha?: string;
  followUp?: RunFollowUp;
  attachments?: FeedbackAttachment[];
  provider?: Provider;
  model?: string;
  effort?: RunEffort;
  /** The optional stages switched on for this run (implement always runs). */
  crew?: string[];
  parallelReviews?: boolean;
  /** The role that implemented the request. */
  implementer?: string;
  /** Estimated cost limit for the whole run. Stages stop starting once it is spent. */
  budgetUsd?: number;
  /** Stage that was blocked by the estimated run budget. */
  budgetBlockedStage?: string;
  stages: StageRecord[];
  /** durationMs is wall-clock time; reviewWaitMs is the part spent waiting for a human (checkpoints, questions, permissions). */
  totals: { costUsd: number | null; usage?: TokenUsage; durationMs: number; turns: number; attempts: number; reviewWaitMs: number };
  error?: string;
  /** The run errored before producing anything, so its worktree and branch were removed. */
  cleanedUp?: boolean;
  /** Most recent browser verification requested from the completed result. */
  browserCheck?: GateRecord;
  verification?: { head: string; checks: GateRecord[]; editsDigest?: string };
  bugVerification?: BugVerification;
  browserAccess?: boolean;
  referenceUrls?: string[];
  browserReferenceHelp?: boolean;
  references?: ReferenceCheck[];
}

function lockOwner(path: string): string | undefined {
  try {
    // Older builds recorded the PID as a symlink target.
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function claimLock(path: string, candidate: string, owner: string, lockDir: string): (() => void) | undefined {
  const tryClaim = () => {
    try {
      // Publish a fully written owner atomically, with no Windows symlink privilege required.
      linkSync(candidate, path);
      return () => { if (lockOwner(path) === owner) rmSync(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };
  const acquired = tryClaim();
  if (acquired) return acquired;
  const previous = lockOwner(path);
  if (previous === undefined) return tryClaim();
  const pid = Number(/^(\d+)(?::[\da-f-]+)?$/i.exec(previous)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return;
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  // Give this stale generation one reaper, so competing callers cannot unlink a newer claim.
  const recovery = join(lockDir, `.recovery-${createHash("sha256").update(`${path}\0${previous}`).digest("hex")}`);
  const releaseRecovery = claimLock(recovery, candidate, owner, lockDir);
  if (!releaseRecovery) return;
  try {
    if (lockOwner(path) === previous) rmSync(path, { force: true });
    return tryClaim();
  } finally {
    releaseRecovery();
  }
}

/** File-backed run history: `<runsDir>/<runId>/run.json` plus an append-only `events.jsonl`. */
export class RunStore {
  constructor(readonly runsDir: string) {}

  dir(runId: string): string {
    return join(this.runsDir, runId);
  }

  /** Reserve a branch while starting a revision, including across dashboard processes. */
  claimBranch(run: Pick<RunRecord, "repo" | "branch">): (() => void) | undefined {
    const lockDir = join(this.runsDir, ".branch-locks");
    mkdirSync(lockDir, { recursive: true });
    const key = createHash("sha256").update(`${run.repo}\0${run.branch}`).digest("hex");
    const lock = join(lockDir, key);
    const token = randomUUID();
    const owner = `${process.pid}:${token}`;
    const candidate = join(lockDir, `.candidate-${token}`);
    writeFileSync(candidate, owner, { flag: "wx", mode: 0o600 });
    try {
      return claimLock(lock, candidate, owner, lockDir);
    } finally {
      rmSync(candidate, { force: true });
    }
  }

  save(run: RunRecord): void {
    const dir = this.dir(run.id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "run.json.tmp");
    writeFileSync(tmp, JSON.stringify(run, null, 2) + "\n");
    renameSync(tmp, join(dir, "run.json"));
  }

  event(runId: string, event: Record<string, unknown>): void {
    const dir = this.dir(runId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  }

  /** The last `limit` events of a run, oldest first. */
  events(runId: string, limit = 2000): Array<Record<string, unknown>> {
    const file = join(this.dir(runId), "events.jsonl");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }

  get(runId: string): RunRecord | null {
    const file = join(this.dir(runId), "run.json");
    if (!existsSync(file)) return null;
    const { designFollowUp, firebaseDeployment, ...run } = JSON.parse(readFileSync(file, "utf8")) as RunRecord & {
      designFollowUp?: RunFollowUp;
      firebaseDeployment?: Omit<DeploymentRecord, "provider">;
    };
    if (firebaseDeployment) run.deployment ??= { ...firebaseDeployment, provider: "firebase" };
    run.provider ??= "claude";
    run.followUp ??= designFollowUp;
    for (const reference of run.references ?? []) {
      if (reference.shared && reference.status === "read" && reference.url?.startsWith("https://www.linkedin.com/") &&
          (!reference.coverage?.length || !reference.missing)) {
        reference.status = "partial";
        reference.detail = "Reviewed notes are available, but LinkedIn coverage was not recorded.";
      }
    }
    return run;
  }

  delete(runId: string): void {
    if (!/^[\w-]+$/.test(runId)) throw new Error("Invalid run ID");
    rmSync(this.dir(runId), { recursive: true, force: true });
  }

  list(): RunRecord[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .map((id) => this.get(id))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
