import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunKind = "feature" | "bug";
export type RunStatus = "running" | "passed" | "failed" | "error";

export interface GateRecord {
  command: string;
  code: number;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
}

export interface AttemptRecord {
  attempt: number;
  sessionId?: string;
  agentOk: boolean;
  agentError?: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  summary: string;
  /** Files the agent changed outside its lane; the pipeline reverted them. */
  revertedFiles?: string[];
  /** The agent finished but left the worktree unchanged; gates were not run. */
  noChanges?: boolean;
  gates: GateRecord[];
  passed: boolean;
}

export interface StageRecord {
  name: string;
  role: string;
  status: "running" | "passed" | "failed";
  attempts: AttemptRecord[];
  commit?: string;
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
  repo: string;
  branch: string;
  worktree: string;
  baseSha: string;
  model: string;
  stages: StageRecord[];
  totals: { costUsd: number; durationMs: number; turns: number; attempts: number };
  error?: string;
  /** The run errored before producing anything, so its worktree and branch were removed. */
  cleanedUp?: boolean;
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

  get(runId: string): RunRecord | null {
    const file = join(this.dir(runId), "run.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunRecord) : null;
  }

  list(): RunRecord[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .map((id) => this.get(id))
      .filter((r): r is RunRecord => r !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
