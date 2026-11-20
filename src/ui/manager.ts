import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentAnswer, AgentAsk, AgentQuestion, AgentRunner } from "../agent.ts";
import { SHIPYARD_ROOT, resolveProvider, validateRunOptions, type Provider, type RunEffort, type ShipyardConfig, type Target } from "../config.ts";
import { addTargetToConfigFile, defaultRepoRoots, findLocalRepos, inspectRepo, validateTargetName, type RepoInspection } from "../targets.ts";
import { DEFAULT_DEPS_REQUEST } from "../prompts.ts";
import {
  IMPLEMENTERS,
  makeRunId,
  OPTIONAL_STAGES,
  runPipeline,
  STAGES,
  type CheckpointContext,
  type CheckpointDecision,
  type Implementer,
  type OptionalStage,
  type StageName,
} from "../pipeline.ts";
import type { Role } from "../roles.ts";
import { RunControl } from "../run-control.ts";
import { RunStore, type RunKind, type RunRecord } from "../store.ts";
import { diffSinceHead, type WorktreeDiff } from "../worktree.ts";

/** Everything the UI is told about, as it happens. */
export type LiveMessage =
  | { type: "run"; run: RunRecord }
  | { type: "event"; runId: string; event: Record<string, unknown> }
  | { type: "inbox"; item: InboxItem }
  | { type: "inbox-resolved"; id: string; runId: string }
  | { type: "active"; runIds: string[] }
  | { type: "targets"; targets: Array<{ name: string; path: string; e2e: boolean }> }
  | { type: "run-error"; runId: string; request: string; error: string };

/** A run store that also broadcasts every save and event. */
export class LiveRunStore extends RunStore {
  constructor(
    runsDir: string,
    private readonly emit: (message: LiveMessage) => void,
  ) {
    super(runsDir);
  }

  override save(run: RunRecord): void {
    super.save(run);
    this.emit({ type: "run", run: structuredClone(run) });
  }

  override event(runId: string, event: Record<string, unknown>): void {
    super.event(runId, event);
    this.emit({ type: "event", runId, event: { at: new Date().toISOString(), ...event } });
  }
}

interface InboxBase {
  id: string;
  runId: string;
  stage: StageName;
  role: string;
  createdAt: string;
}

/** One thing a human needs to answer. Each item has its own pending answer, so they can be answered in any order. */
export type InboxItem = InboxBase &
  (
    | { kind: "checkpoint"; checkpoint: CheckpointContext; diff: WorktreeDiff }
    | { kind: "question"; questions: AgentQuestion[] }
    | { kind: "permission"; tool: string; input: Record<string, unknown>; title?: string; reason?: string }
  );

export type InboxAnswer =
  | { kind: "checkpoint"; action: "continue" | "stop" }
  | { kind: "checkpoint"; action: "feedback"; message: string }
  | { kind: "question"; answers: Record<string, string> }
  /** allow-run: allow this tool for the rest of the run without asking again. */
  | { kind: "permission"; decision: "allow" | "allow-run" | "deny"; message?: string };

export interface StartRequest {
  target: string;
  kind: RunKind;
  request: string;
  checkpoints: StageName[];
  provider?: string;
  /** One of the chosen provider’s models. The default model when unset. */
  model?: string;
  effort?: RunEffort;
  /** The optional stages that run (implement always runs). The pipeline default when unset. */
  crew?: OptionalStage[];
  /** backend (default) or frontend. */
  implementer?: Implementer;
  /** Estimated-cost limit for this run. config.maxBudgetUsdPerRun when unset. */
  budgetUsd?: number;
}

export interface ManagerOptions {
  config: ShipyardConfig;
  roles: Map<string, Role>;
  runner: AgentRunner;
  codexRunner?: AgentRunner;
  /** Optional: where run records go (defaults to config.runsDir). */
  runsDir?: string;
  log?: (line: string) => void;
  /** The config file new targets are saved to. Without it (demo mode), adding repos is off. */
  configFile?: string;
}

/**
 * Runs pipelines in parallel for the UI and keeps one inbox of everything that needs a human:
 * checkpoints, agents' questions and permission requests, across all runs and agents.
 */
export class RunManager {
  readonly bus = new EventEmitter();
  readonly store: LiveRunStore;
  private readonly pending = new Map<string, { item: InboxItem; resolve: (answer: InboxAnswer | undefined) => void }>();
  private readonly allowedForRun = new Map<string, Set<string>>();
  private readonly active = new Map<string, Promise<RunRecord | undefined>>();
  private readonly controls = new Map<string, RunControl>();
  private shuttingDown = false;

  constructor(private readonly opts: ManagerOptions) {
    this.bus.setMaxListeners(100);
    this.store = new LiveRunStore(opts.runsDir ?? opts.config.runsDir, (m) => this.emit(m));
  }

  targets(): Target[] {
    return Object.values(this.opts.config.targets);
  }

  /** The agent roles, for showing the crew. */
  roles(): Array<{ name: string; description: string; tools: string[] }> {
    return [...this.opts.roles.values()].map((r) => ({ name: r.name, description: r.description, tools: r.tools }));
  }

  /** Whether this UI can add repos (not in demo mode). */
  get canAddTargets(): boolean {
    return Boolean(this.opts.configFile);
  }

  /** Repos on this machine that could be added, for the Add repo list. */
  repoSuggestions() {
    const taken = this.targets().map((t) => t.path);
    return findLocalRepos(defaultRepoRoots(SHIPYARD_ROOT), [SHIPYARD_ROOT, ...taken]);
  }

  inspectRepo(path: string): Promise<RepoInspection> {
    return inspectRepo(path, process.cwd(), this.opts.config.targets);
  }

  /** Check a repo, save it to the config file, and make it available to new runs straight away. */
  async addTarget(input: { name: string; path: string; test: string; e2e?: string }): Promise<Target> {
    if (!this.opts.configFile) throw new UserError("Adding repos is off in demo mode");
    const name = input.name?.trim() ?? "";
    const test = input.test?.trim() ?? "";
    const e2e = input.e2e?.trim() || undefined;
    const nameProblem = validateTargetName(name, this.opts.config.targets);
    if (nameProblem) throw new UserError(nameProblem);
    if (!test) throw new UserError("Enter the command that runs this repo's tests. Shipyard uses it to check every change.");
    const repo = await this.inspectRepo(input.path ?? "");
    if (!repo.ok) throw new UserError(repo.errors[0]!);

    const target: Target = { name, path: repo.path, test, e2e };
    addTargetToConfigFile(this.opts.configFile, target);
    this.opts.config.targets[name] = target;
    this.emit({ type: "targets", targets: this.targets().map((t) => ({ name: t.name, path: t.path, e2e: Boolean(t.e2e) })) });
    return target;
  }

  inbox(): InboxItem[] {
    return [...this.pending.values()].map((p) => p.item);
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /** Resolves when the run finishes (for tests and shutdown). */
  whenDone(runId: string): Promise<RunRecord | undefined> {
    return this.active.get(runId) ?? Promise.resolve(this.store.get(runId) ?? undefined);
  }

  /** Start a run in the background and return its id straight away. */
  start(req: StartRequest): string {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const target = this.opts.config.targets[req.target];
    if (!target) throw new UserError(`Unknown target "${req.target}"`);
    if (!existsSync(target.path)) throw new UserError(`Target path does not exist: ${target.path}`);
    if (!["feature", "bug", "deps"].includes(req.kind)) throw new UserError(`kind must be "feature", "bug" or "deps"`);
    // A dependency update needs no description: the notes are optional.
    const request = req.request?.trim() || (req.kind === "deps" ? DEFAULT_DEPS_REQUEST : "");
    if (!request) throw new UserError("Describe the feature or bug first");
    const unknown = req.checkpoints.filter((s) => !(STAGES as readonly string[]).includes(s));
    if (unknown.length) throw new UserError(`Unknown stage(s): ${unknown.join(", ")}`);
    let provider: Provider;
    try {
      provider = resolveProvider(req.provider ?? this.opts.config.defaultProvider);
      validateRunOptions(this.opts.config, provider, req);
      if (provider === "codex" && !this.opts.codexRunner) throw new Error("Codex runs are unavailable in this UI session");
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    const badCrew = (req.crew ?? []).filter((s) => !(OPTIONAL_STAGES as readonly string[]).includes(s));
    if (badCrew.length) throw new UserError(`Unknown crew stage(s): ${badCrew.join(", ")}. Optional stages are ${OPTIONAL_STAGES.join(", ")} (implement always runs)`);
    if (req.implementer && !(IMPLEMENTERS as readonly string[]).includes(req.implementer)) {
      throw new UserError(`implementer must be ${IMPLEMENTERS.join(" or ")}`);
    }

    const id = makeRunId(request);
    const control = new RunControl();
    this.controls.set(id, control);
    const done = runPipeline(
      {
        target,
        kind: req.kind,
        request,
        id,
        provider,
        model: req.model,
        effort: req.effort,
        crew: req.crew,
        implementer: req.implementer,
        budgetUsd: req.budgetUsd,
      },
      {
        config: this.opts.config,
        runner: this.opts.runner,
        runnerForProvider: (current) => current === "codex" ? this.opts.codexRunner! : this.opts.runner,
        control,
        store: this.store,
        roles: this.opts.roles,
        log: this.opts.log ? (line) => this.opts.log!(`[${id.slice(-4)}] ${line}`) : undefined,
        checkpoints: req.checkpoints.length ? { stages: req.checkpoints, review: (ctx, signal) => this.review(ctx, signal) } : undefined,
        ask: (from, ask, signal) => this.ask(from, ask, signal),
      },
    )
      .catch((err: unknown) => {
        // Errors before the run record exists (e.g. the target is not a git repo).
        this.emit({ type: "run-error", runId: id, request, error: err instanceof Error ? err.message : String(err) });
        return undefined;
      })
      .finally(() => {
        this.active.delete(id);
        this.controls.delete(id);
        this.allowedForRun.delete(id);
        this.emit({ type: "active", runIds: this.activeRunIds() });
      });
    this.active.set(id, done);
    this.emit({ type: "active", runIds: this.activeRunIds() });
    return id;
  }

  controlRun(runId: string, input: { action?: unknown; message?: unknown; provider?: unknown }): void {
    const control = this.controls.get(runId);
    if (!control || control.stopped) throw new UserError("This run has finished or is stopping");
    const { action } = input;
    if (action === "stop") {
      this.store.event(runId, { type: "stop_requested" });
      control.stop();
      return;
    }
    if (action !== "steer" && action !== "switch-provider") throw new UserError("Unknown run action");
    if (input.message !== undefined && typeof input.message !== "string") throw new UserError("Instructions must be text");
    const message = input.message?.trim() ?? "";
    if (action === "steer" && !message) throw new UserError("Enter an instruction for the agent");
    let provider: Provider | undefined;
    if (action === "switch-provider") {
      if (input.provider !== "claude" && input.provider !== "codex") throw new UserError("Provider must be claude or codex");
      provider = input.provider;
      if (provider === "codex" && !this.opts.codexRunner) throw new UserError("Codex runs are unavailable in this UI session");
    }
    this.store.event(runId, { type: action === "steer" ? "steer_requested" : "provider_requested", provider, message });
    control.redirect(provider, message);
  }

  setArchived(runId: string, archived: boolean): RunRecord {
    if (this.active.has(runId)) throw new UserError("Stop the run before archiving it");
    const run = this.store.get(runId);
    if (!run) throw new UserError("No such run");
    run.archivedAt = archived ? run.archivedAt ?? new Date().toISOString() : undefined;
    this.store.save(run);
    return run;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const control of this.controls.values()) control.stop();
    await Promise.all(this.active.values());
  }

  /** Answer one inbox item. Other items, and other agents, are unaffected. */
  answer(id: string, answer: InboxAnswer): void {
    const entry = this.pending.get(id);
    if (!entry) throw new UserError("That item was already answered or no longer exists");
    validateAnswer(entry.item, answer);
    this.pending.delete(id);
    if (answer.kind === "permission" && answer.decision === "allow-run" && entry.item.kind === "permission") {
      const tools = this.allowedForRun.get(entry.item.runId) ?? new Set<string>();
      tools.add(entry.item.tool);
      this.allowedForRun.set(entry.item.runId, tools);
    }
    this.store.event(entry.item.runId, { stage: entry.item.stage, type: "answered", kind: entry.item.kind, answer });
    this.emit({ type: "inbox-resolved", id, runId: entry.item.runId });
    entry.resolve(answer);
  }

  private async review(ctx: CheckpointContext, signal?: AbortSignal): Promise<CheckpointDecision> {
    const diff = await diffSinceHead(ctx.worktree);
    const answer = await this.enqueue({ kind: "checkpoint", runId: ctx.runId, stage: ctx.stage, role: ctx.role, checkpoint: ctx, diff }, signal);
    if (answer?.kind !== "checkpoint") return { action: "stop" };
    return answer.action === "feedback" ? { action: "feedback", message: answer.message } : { action: answer.action };
  }

  private async ask(from: { runId: string; stage: StageName; role: string }, ask: AgentAsk, signal?: AbortSignal): Promise<AgentAnswer> {
    if (signal?.aborted) return { kind: "permission", allow: false };
    if (ask.kind === "permission" && this.allowedForRun.get(from.runId)?.has(ask.tool)) {
      this.store.event(from.runId, { stage: from.stage, type: "auto-allowed", tool: ask.tool });
      return { kind: "permission", allow: true };
    }
    const answer =
      ask.kind === "question"
        ? await this.enqueue({ kind: "question", ...from, questions: ask.questions }, signal)
        : await this.enqueue({ kind: "permission", ...from, tool: ask.tool, input: ask.input, title: ask.title, reason: ask.reason }, signal);
    if (answer?.kind === "question") return answer;
    if (answer?.kind === "permission") return { kind: "permission", allow: answer.decision !== "deny", message: answer.message };
    return { kind: "permission", allow: false };
  }

  private enqueue(item: DistributiveOmit<InboxItem, "id" | "createdAt">, signal?: AbortSignal): Promise<InboxAnswer | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    const full = { ...item, id: randomBytes(6).toString("hex"), createdAt: new Date().toISOString() } as InboxItem;
    return new Promise((resolve) => {
      const cancel = () => {
        if (this.pending.delete(full.id)) this.emit({ type: "inbox-resolved", id: full.id, runId: full.runId });
        resolve(undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(full.id, { item: full, resolve: (answer) => {
        signal?.removeEventListener("abort", cancel);
        resolve(answer);
      } });
      this.store.event(full.runId, { stage: full.stage, type: "waiting", kind: full.kind, item: full.id });
      this.emit({ type: "inbox", item: full });
    });
  }

  private emit(message: LiveMessage): void {
    this.bus.emit("message", message);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An error caused by the request, shown to the user as-is (HTTP 400). */
export class UserError extends Error {}

function validateAnswer(item: InboxItem, answer: InboxAnswer): void {
  if (answer?.kind !== item.kind) throw new UserError(`This item needs a ${item.kind} answer`);
  if (answer.kind === "checkpoint") {
    if (!["continue", "feedback", "stop"].includes(answer.action)) throw new UserError("Unknown checkpoint action");
    if (answer.action === "feedback" && !answer.message?.trim()) throw new UserError("Feedback can't be empty");
    if (answer.action === "continue" && item.kind === "checkpoint" && !item.checkpoint.canContinue) {
      throw new UserError("This stage failed; give feedback or stop");
    }
  }
  if (answer.kind === "question" && item.kind === "question") {
    const missing = item.questions.filter((q) => !answer.answers?.[q.question]?.trim());
    if (missing.length) throw new UserError(`Answer every question (${missing.map((q) => q.header).join(", ")})`);
  }
  if (answer.kind === "permission" && !["allow", "allow-run", "deny"].includes(answer.decision)) {
    throw new UserError("Unknown permission decision");
  }
}
