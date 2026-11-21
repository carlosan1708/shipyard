import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage } from "./agent.ts";
import type { FeedbackAttachment } from "./attachments.ts";
import type { Provider, RunEffort } from "./config.ts";
import type { ReferenceCheck } from "./references.ts";

/** feature: ship something new · bug: fix a reported problem · deps: update dependencies. */
export type RunKind = "feature" | "bug" | "deps";
/** Stopping a run preserves its branch and worktree. */
export type RunStatus = "running" | "passed" | "failed" | "error" | "stopped";

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
  /** For a bug triage the tests are expected to fail: that failure proves the bug. */
  expectFailure?: boolean;
  code: number;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
  checkedAt?: string;
}

/** Did this gate go the way it should? Normally that means it passed; for a triage, that it failed. */
export const gateOk = (g: GateRecord): boolean => (g.expectFailure ? g.code !== 0 && !g.timedOut : g.code === 0);

export interface AttemptRecord {
  attempt: number;
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

export interface StageRecord {
  name: string;
  role: string;
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
  kind: RunKind;
  target: string;
  request: string;
  tags: string[];
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  completionRead?: boolean;
  publication?: { head: string; destination: string; pushedAt: string; pullRequestUrl?: string };
  cloudRelease?: import("./ui/cloud-release.ts").CloudRunRelease;
  archivedAt?: string;
  ownerPid?: number;
  checkpointStages?: string[];
  repo: string;
  branch: string;
  worktree: string;
  baseSha: string;
  followUp?: RunFollowUp;
  attachments?: FeedbackAttachment[];
  provider?: Provider;
  model?: string;
  effort?: RunEffort;
  /** The optional stages switched on for this run (implement always runs). */
  crew?: string[];
  /** The role that implemented the request. */
  implementer?: string;
  /** Estimated cost limit for the whole run. Stages stop starting once it is spent. */
  budgetUsd?: number;
  stages: StageRecord[];
  /** durationMs is wall-clock time; reviewWaitMs is the part spent waiting for a human (checkpoints, questions, permissions). */
  totals: { costUsd: number | null; usage?: TokenUsage; durationMs: number; turns: number; attempts: number; reviewWaitMs: number };
  error?: string;
  /** The run errored before producing anything, so its worktree and branch were removed. */
  cleanedUp?: boolean;
  /** Most recent browser verification requested from the completed result. */
  browserCheck?: GateRecord;
  verification?: { head: string; checks: GateRecord[]; editsDigest?: string };
  browserAccess?: boolean;
  referenceUrls?: string[];
  browserReferenceHelp?: boolean;
  references?: ReferenceCheck[];
}

/** File-backed run history: `<runsDir>/<runId>/run.json` plus an append-only `events.jsonl`. */
export class RunStore {
  constructor(readonly runsDir: string) {}

  dir(runId: string): string {
    return join(this.runsDir, runId);
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
    const { designFollowUp, ...run } = JSON.parse(readFileSync(file, "utf8")) as RunRecord & { designFollowUp?: RunFollowUp };
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
