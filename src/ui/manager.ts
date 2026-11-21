import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentAnswer, AgentAsk, AgentQuestion, AgentRunner } from "../agent.ts";
import { attachmentContext, parseFeedbackAttachments, resolveAttachments, writeFeedbackAttachments, type FeedbackAttachment } from "../attachments.ts";
import { BROWSER_CHECK, checkBrowser } from "../browser-check.ts";
import { SHIPYARD_ROOT, resolveProvider, validateRunOptions, type Provider, type RunEffort, type ShipyardConfig, type Target } from "../config.ts";
import { addTargetToConfigFile, cloneRepo, defaultRepoRoots, findLocalRepos, inspectRepo, validateTargetName, type RepoInspection } from "../targets.ts";
import { DEFAULT_DEPS_REQUEST } from "../prompts.ts";
import {
  DEFAULT_CREW,
  IMPLEMENTERS,
  makeRunId,
  OPTIONAL_STAGES,
  runPipeline,
  STAGES,
  type CheckpointContext,
  type CheckpointDecision,
  type Implementer,
  type OptionalStage,
  type PipelineDeps,
  type PipelineRequest,
  type StageName,
} from "../pipeline.ts";
import { requireRole, type Role } from "../roles.ts";
import { RunControl } from "../run-control.ts";
import { git, sh } from "../exec.ts";
import { MAX_PUBLIC_REFERENCES, missingReferencePermissions, parseReferencePermissions, readPublicReference, referenceLinks, sharedReference, validReferenceText, type ReviewedReference } from "../references.ts";
import { canPreview, startPreview, type LocalPreview } from "./preview.ts";
import { launchLocalApp, LOCAL_APP_SCHEMA } from "./local-app.ts";
import { createRunPullRequest, draftBase, fetchDraftBase, linkedPullRequestState, pullRequestOptions, pushDestination, pushRunCommit } from "./publication.ts";
import { describePullRequest, markdownCode, MAX_PULL_REQUEST_DESCRIPTION, reviewDraftBranch, type DraftReview } from "./draft-pr.ts";
import { CloudRunReleases } from "./cloud-release.ts";
import { parseReferenceDraft, ReferenceHandoffs, type ReferenceScope } from "./reference-handoff.ts";
import { gateOk, recoverableStage, repairableRevisionStage, RunStore, type GateRecord, type RunKind, type RunRecord } from "../store.ts";
import { changedFiles, commitTree, createWorktree, detachedWorktree, diffSinceHead, repoRoot, squashCommit, withRepoLock, worktreeSnapshot, type WorktreeDiff } from "../worktree.ts";

/** Everything the UI is told about, as it happens. */
export type LiveMessage =
  | { type: "run"; run: RunRecord }
  | { type: "run-deleted"; runId: string }
  | { type: "preview"; runId: string; url?: string }
  | { type: "local-app"; runId: string; app?: { url?: string; starting: boolean } }
  | { type: "git-remote"; repo: string }
  | { type: "reference-handoff"; runId: string; url?: string; status?: "ready" | "blocked" }
  | { type: "event"; runId: string; event: Record<string, unknown> }
  | { type: "inbox"; item: InboxItem }
  | { type: "inbox-resolved"; id: string; runId: string }
  | { type: "active"; runIds: string[] }
  | { type: "targets"; targets: Array<{ name: string; path: string; e2e: boolean; browserAccess?: boolean }> }
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
    | { kind: "reference"; url: string; detail: string; needsApproval?: boolean }
  );

export type InboxAnswer<Files = unknown> = (
  | { kind: "checkpoint"; action: "continue" | "stop" }
  | { kind: "checkpoint"; action: "feedback"; message: string }
  | { kind: "question"; answers: Record<string, string> }
  /** allow-run: allow this tool for the rest of the run without asking again. */
  | { kind: "permission"; decision: "allow" | "allow-run" | "deny"; message?: string }
  | { kind: "reference"; action: "share"; text: string; review?: Pick<ReviewedReference, "coverage" | "missing"> }
  | { kind: "reference"; action: "approve" }
  | { kind: "reference"; action: "skip"; blocked?: string }
) & { attachments?: Files };

export interface StartRequest {
  target: string;
  kind: RunKind;
  request: string;
  attachments?: unknown;
  checkpoints: StageName[];
  provider?: string;
  /** One of the chosen provider’s models. The default model when unset. */
  model?: string;
  effort?: RunEffort;
  /** The optional stages that run (implement always runs). The pipeline default when unset. */
  crew?: OptionalStage[];
  /** backend (default) or frontend. */
  implementer?: Implementer;
  browserAccess?: boolean;
  referenceUrls?: string[];
  browserReferenceHelp?: boolean;
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

interface LocalAppSession {
  controller: AbortController;
  ready: Promise<LocalPreview>;
  url?: string;
}

/**
 * Runs pipelines in parallel for the UI and keeps one inbox of everything that needs a human:
 * checkpoints, agents' questions and permission requests, across all runs and agents.
 */
export class RunManager {
  readonly bus = new EventEmitter();
  readonly store: LiveRunStore;
  private readonly pending = new Map<string, { item: InboxItem; resolve: (answer: InboxAnswer<FeedbackAttachment[]> | undefined) => void }>();
  private readonly allowedForRun = new Map<string, Set<string>>();
  private readonly active = new Map<string, Promise<RunRecord | undefined>>();
  private readonly controls = new Map<string, RunControl>();
  private shuttingDown = false;
  private readonly previews = new Map<string, Promise<LocalPreview>>();
  private readonly localApps = new Map<string, LocalAppSession>();
  private readonly browserChecks = new Map<string, Promise<GateRecord>>();
  private readonly verifications = new Map<string, Promise<NonNullable<RunRecord["verification"]>>>();
  private readonly referenceChecks = new Map<string, Promise<RunRecord>>();
  private readonly referenceHandoffs = new ReferenceHandoffs();
  private readonly publications = new Map<string, Promise<void>>();
  private readonly draftReviews = new Map<string, DraftReview>();
  private readonly clones = new Map<string, Promise<RepoInspection>>();
  private readonly stopResultChecks = new AbortController();
  private readonly cloudReleases = new CloudRunReleases(this.stopResultChecks.signal);

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

  cloneTarget(input: unknown): Promise<RepoInspection> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    if (!this.opts.configFile) throw new UserError("Cloning repos is off in demo mode");
    const url = gitRemoteUrl(input);
    const pending = this.clones.get(url);
    if (pending) return pending;
    const root = join(dirname(this.opts.configFile), ".shipyard", "repos");
    const cloning = cloneRepo(url, root, this.stopResultChecks.signal)
      .then(async ({ path, name }) => {
        const info = await this.inspectRepo(path);
        return { ...info, suggestedName: info.existingName ?? name };
      })
      .catch((error: Error) => { throw new UserError(error.message); })
      .finally(() => this.clones.delete(url));
    this.clones.set(url, cloning);
    return cloning;
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
    const existing = this.targets().find((target) => target.path === repo.path);
    if (existing) throw new UserError(`Already added as "${existing.name}"`);

    const target: Target = { name, path: repo.path, test, e2e };
    addTargetToConfigFile(this.opts.configFile, target);
    this.opts.config.targets[name] = target;
    this.emit({ type: "targets", targets: this.targets().map((t) => ({ name: t.name, path: t.path, e2e: Boolean(t.e2e), ...(t.browserAccess === undefined ? {} : { browserAccess: t.browserAccess }) })) });
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
    let referenceUrls: string[];
    try {
      provider = resolveProvider(req.provider ?? this.opts.config.defaultProvider);
      referenceUrls = parseReferencePermissions(req.referenceUrls);
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
    if (req.browserAccess !== undefined && typeof req.browserAccess !== "boolean") throw new UserError("Browser access must be true or false");
    if (req.browserReferenceHelp !== undefined && typeof req.browserReferenceHelp !== "boolean") throw new UserError("Browser reference help must be true or false");

    const id = makeRunId(request);
    const attachments = this.saveAttachments(id, req.attachments, true);
    return this.startPipeline({
      target,
      kind: req.kind,
      request,
      attachments,
      provider,
      model: req.model,
      effort: req.effort,
      crew: req.crew,
      implementer: req.implementer,
      browserAccess: req.browserAccess,
      referenceUrls,
      browserReferenceHelp: req.browserReferenceHelp,
      budgetUsd: req.budgetUsd,
    }, req.checkpoints, id);
  }

  resume(runId: string, mode: "resume" | "recheck" | "fix" = "resume"): void {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    const stage = mode === "recheck" ? recoverableStage(run) : mode === "fix" ? repairableRevisionStage(run) : undefined;
    if (mode === "fix" && !stage) throw new UserError("There is no failed revision stage the crew can repair here");
    if (mode === "recheck" && !stage) throw new UserError("This run has no failed check that can be rechecked on the saved edits");
    if (mode === "resume" && run.status !== "running" && run.status !== "stopped") throw new UserError("Only stopped or interrupted runs can be resumed");
    if (this.verifications.has(runId)) throw new UserError("Wait for the current project checks to finish");
    if (run.cleanedUp || !existsSync(run.worktree)) throw new UserError("The original worktree is unavailable");
    const target = this.opts.config.targets[run.target];
    if (!target) throw new UserError(`Configure the original target "${run.target}" before resuming`);
    const provider = run.provider ?? "claude";
    if (provider === "codex" && !this.opts.codexRunner) throw new UserError("Codex runs are unavailable in this UI session");
    // Older records predate saved checkpoint settings. Review each remaining stage on resume.
    const checkpoints = STAGES.filter((stage) => run.checkpointStages?.includes(stage) ?? true);
    run.ownerPid = process.pid;
    this.store.save(run);
    this.startPipeline({
      target,
      kind: run.kind,
      request: run.request,
      provider,
      model: run.model,
      effort: run.effort,
      crew: OPTIONAL_STAGES.filter((stage) => run.crew?.includes(stage) ?? DEFAULT_CREW.includes(stage)),
      implementer: IMPLEMENTERS.find((role) => role === run.implementer),
      resume: run,
    }, checkpoints, run.id, { recheckStage: mode === "recheck" ? stage?.name : undefined, repairStage: mode === "fix" ? stage?.name : undefined });
  }

  async startFollowUp(runId: string, input: { message?: unknown; provider?: unknown; browserAccess?: unknown; referenceUrls?: unknown; browserReferenceHelp?: unknown; attachments?: unknown }): Promise<string> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > 8000) throw new UserError("Enter feedback of 1 to 8,000 characters");
    const { browserAccess, browserReferenceHelp } = input;
    if (browserAccess !== undefined && typeof browserAccess !== "boolean") throw new UserError("Browser access must be true or false");
    if (browserReferenceHelp !== undefined && typeof browserReferenceHelp !== "boolean") throw new UserError("Browser reference help must be true or false");
    let referenceUrls: string[];
    try {
      const explicit = input.referenceUrls === undefined ? referenceLinks(message) : [];
      const approved = parseReferencePermissions(input.referenceUrls ?? run.referenceUrls);
      referenceUrls = [...new Set([...parseReferencePermissions(explicit), ...approved])].slice(0, MAX_PUBLIC_REFERENCES);
    }
    catch (error) { throw new UserError((error as Error).message); }
    if (!this.canGiveFeedback(run)) throw new UserError("Feedback needs a completed run or a finished revision on this branch");
    const target = this.opts.config.targets[run.target];
    if (!target || await repoRoot(target.path).catch(() => undefined) !== run.repo) {
      throw new UserError(`Configure the original target "${run.target}" to start a revision`);
    }
    const provider = input.provider ?? run.provider ?? "claude";
    if (provider !== "claude" && provider !== "codex") throw new UserError("Provider must be claude or codex");
    if (provider === "codex" && !this.opts.codexRunner) throw new UserError("Codex runs are unavailable in this UI session");
    const release = this.store.claimBranch(run);
    if (!release) throw new UserError("A revision is already starting or running on this branch. Open its latest revision to follow progress.");
    try {
      return await withRepoLock(run.repo, async () => {
        const source = this.inactiveBranchRun(runId);
        if (this.verifications.has(runId) || this.browserChecks.has(runId)) throw new UserError("Wait for the current checks to finish before adding feedback");
        const [baseSha, checkedOut] = await Promise.all([
          git(["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`], run.repo).catch(() => undefined),
          git(["symbolic-ref", "HEAD"], run.worktree).catch(() => undefined),
        ]);
        const originalCommit = source.stages.findLast((stage) => stage.commit)?.commit ?? source.baseSha;
        const matchesRun = baseSha && await git(["merge-base", "--is-ancestor", originalCommit, baseSha], run.repo).then(() => true, () => false);
        if (!baseSha || !matchesRun || checkedOut !== `refs/heads/${run.branch}`) {
          throw new UserError("Shipyard couldn’t find the original branch in its worktree");
        }
        if ((await changedFiles(run.worktree)).length) throw new UserError("This branch has saved edits. Finish or recover its current work before starting a revision.");
        if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
        const revisitingLinkedIn = /\blinkedin\b/i.test(message);
        const sharedReferences = source.references?.map((check) => {
          if (check.shared && check.status === "read" && revisitingLinkedIn && check.url?.startsWith("https://www.linkedin.com/")) {
            return { ...check, status: "partial" as const, browserHelpSkipped: undefined,
              detail: "Earlier notes are available. Check LinkedIn coverage again for this feedback." };
          }
          return { ...check, browserHelpSkipped: undefined };
        });
        const id = makeRunId(message);
        const attachments = this.saveAttachments(id, input.attachments, true);
        this.startPipeline({
          target, kind: "feature", request: message, provider, crew: [],
          browserAccess: browserAccess ?? run.browserAccess,
          referenceUrls,
          browserReferenceHelp: browserReferenceHelp ?? true,
          sharedReferences,
          continueBranch: { ...source, baseSha, branchBaseSha: source.branchBaseSha ?? source.baseSha },
          followUp: { runId, brief: run.followUp?.brief ?? run.request, baseSha, orchestrated: true, attachments },
        }, [], id);
        void this.whenDone(id).finally(release);
        return id;
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  private saveAttachments(runId: string, input: unknown, newRun = false): FeedbackAttachment[] | undefined {
    let files: ReturnType<typeof parseFeedbackAttachments>;
    try {
      files = parseFeedbackAttachments(input);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    return files.length ? writeFeedbackAttachments(this.store.dir(runId), files, newRun) : undefined;
  }

  private startPipeline(req: PipelineRequest, checkpoints: readonly StageName[], id = req.resume?.id ?? makeRunId(req.request),
    recovery?: Pick<PipelineDeps, "recheckStage" | "repairStage">): string {
    const control = new RunControl();
    if (req.resume) {
      for (const event of this.store.events(id, Infinity)) {
        if (event.type === "steer_requested" || event.type === "provider_requested") {
          if (typeof event.message === "string" && event.message) control.instructions.push(event.message);
          if (Array.isArray(event.attachments)) control.attachments.push(...event.attachments as FeedbackAttachment[]);
        }
      }
    }
    this.controls.set(id, control);
    const done = runPipeline(
      { ...req, id },
      {
        config: this.opts.config,
        runner: this.opts.runner,
        runnerForProvider: (current) => current === "codex" ? this.opts.codexRunner! : this.opts.runner,
        control,
        ...recovery,
        store: this.store,
        roles: this.opts.roles,
        log: this.opts.log ? (line) => this.opts.log!(`[${id.slice(-4)}] ${line}`) : undefined,
        checkpoints: checkpoints.length ? { stages: checkpoints, review: (ctx, signal) => this.review(ctx, signal) } : undefined,
        ask: (from, ask, signal) => this.ask(from, ask, signal),
        approveReference: async (runId, url, signal) => {
          const answer = await this.enqueue({ kind: "reference", runId, stage: "reference", role: "Shipyard",
            url, detail: "Shipyard will check public access and ask for browser help if needed.", needsApproval: true }, signal);
          return answer?.kind === "reference" && answer.action === "approve";
        },
        reviewReference: async (runId, url, detail, signal) => {
          const answer = await this.enqueue({ kind: "reference", runId, stage: "reference", role: "Shipyard", url, detail }, signal);
          if (answer?.kind !== "reference") return;
          if (answer.action === "share") return { text: answer.text, ...answer.review,
            attachments: answer.attachments ? { runId, files: answer.attachments } : undefined };
          if (answer.action === "skip" && answer.blocked) return { blocked: answer.blocked };
        },
      },
    )
      .catch((err: unknown) => {
        // Errors before the run record exists (e.g. the target is not a git repo).
        const saved = req.resume && this.store.get(id);
        if (saved?.ownerPid === process.pid) {
          delete saved.ownerPid;
          this.store.save(saved);
        }
        if (!req.resume && (req.attachments?.length || req.followUp?.attachments?.length) && !this.store.get(id)) this.store.delete(id);
        this.emit({ type: "run-error", runId: id, request: req.request, error: err instanceof Error ? err.message : String(err) });
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

  controlRun(runId: string, input: { action?: unknown; message?: unknown; provider?: unknown; attachments?: unknown }): void {
    const control = this.controls.get(runId);
    if (!control || control.stopped) throw new UserError("This run has finished or is stopping");
    const { action } = input;
    if (action === "stop") {
      this.store.event(runId, { type: "stop_requested" });
      this.referenceHandoffs.revoke(runId);
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
    const attachments = this.saveAttachments(runId, input.attachments);
    this.store.event(runId, { type: action === "steer" ? "steer_requested" : "provider_requested", provider, message, attachments });
    control.redirect(provider, message, attachments);
    if (provider) {
      this.referenceHandoffs.revoke(runId);
      this.emit({ type: "reference-handoff", runId });
    }
  }

  private inactiveRun(runId: string): RunRecord {
    const run = this.store.get(runId);
    if (!run) throw new UserError("No such run");
    if (this.active.has(runId)) throw new UserError("This run is active");
    if (run.ownerPid) {
      try {
        process.kill(run.ownerPid, 0);
        throw new UserError("This run is active in another Shipyard process");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return run;
  }

  private latestBranchRun(run: RunRecord): RunRecord {
    return this.store.list().find((entry) => entry.repo === run.repo && entry.branch === run.branch) ?? run;
  }

  private inactiveBranchRun(runId: string): RunRecord {
    const run = this.inactiveRun(runId);
    if (this.latestBranchRun(run).id !== runId) throw new UserError("Open the latest revision to continue working on this branch");
    return run;
  }

  private canGiveFeedback(run: RunRecord): boolean {
    return Boolean(run.finishedAt && !run.cleanedUp && run.branch.startsWith("shipyard/") &&
      (run.status === "passed" || (run.followUp && run.status !== "running")));
  }

  private canPrepareBranch(run: RunRecord): boolean {
    return this.canGiveFeedback(run) && run.status === "failed" && Boolean(run.followUp) && !recoverableStage(run) &&
      run.stages.at(-1)?.attempts.at(-1)?.noChanges === true && !run.stages.some((stage) => stage.commit) &&
      /\bsquash\b/i.test(run.request) && /\b(?:branch|commits?|history)\b/i.test(run.request);
  }

  async prepareBranch(runId: string, approval?: { name?: unknown; head?: unknown; base?: unknown; confirm?: unknown }) {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    if (!this.canPrepareBranch(run)) throw new UserError("This revision has no branch cleanup to prepare");
    const release = approval && this.store.claimBranch(run);
    if (approval && !release) throw new UserError("This branch is already being updated");
    try {
      const target = this.opts.config.targets[run.target];
      if (!target || await repoRoot(target.path).catch(() => undefined) !== run.repo || (await changedFiles(run.worktree)).length) {
        throw new UserError("Branch cleanup needs the original repository and a clean worktree");
      }
      const head = await git(["rev-parse", "HEAD"], run.worktree);
      if (await git(["symbolic-ref", "HEAD"], run.worktree).catch(() => "") !== `refs/heads/${run.branch}`) {
        throw new UserError("Shipyard couldn’t find the original branch in its worktree");
      }
      let base = run.branchBaseSha ?? run.baseSha;
      const visited = new Set([runId]);
      for (let parentId = run.followUp?.runId; parentId && !visited.has(parentId);) {
        visited.add(parentId);
        const parent = this.store.get(parentId);
        if (parent?.repo !== run.repo) break;
        const candidate = parent.branchBaseSha ?? parent.baseSha;
        if (!await git(["merge-base", "--is-ancestor", candidate, base], run.repo).then(() => true, () => false)) break;
        base = candidate;
        parentId = parent.followUp?.runId;
      }
      if (!await git(["merge-base", "--is-ancestor", base, head], run.repo).then(() => true, () => false)) {
        throw new UserError("The proposed base is outside the current branch history");
      }
      const commits = Number(await git(["rev-list", "--count", `${base}..${head}`], run.repo));
      if (!commits) throw new UserError("There are no branch commits to squash");
      const name = `${run.target.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project"}-update`;
      if (!approval) return { plan: { head, base, commits, name } };
      if (approval.confirm !== true || approval.head !== head || approval.base !== base) {
        throw new UserError("The branch or base changed. Reopen the review before approving");
      }
      if (typeof approval.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(approval.name)) {
        throw new UserError("Enter a branch name with letters, numbers, or hyphens");
      }
      const branch = `shipyard/${approval.name}`;
      if (await git(["show-ref", "--verify", `refs/heads/${branch}`], run.repo).then(() => true, () => false)) {
        throw new UserError("This branch name is already in use. Choose another name");
      }
      if (this.verifications.has(runId) || this.browserChecks.has(runId)) throw new UserError("Wait for the current checks to finish");
      const verification = await this.verifyResult(runId, true);
      if (!verification.checks.every(gateOk)) throw new UserError("A project check failed during verification. See the latest check output in the handoff");
      if (this.shuttingDown || verification.head !== head || (await changedFiles(run.worktree)).length ||
          await git(["rev-parse", "HEAD"], run.worktree) !== head) throw new UserError("The run changed during verification. Review it again");
      const commit = await squashCommit(run.repo, head, base, `Shipyard: ${approval.name.replaceAll("-", " ")}`);
      const worktree = join(this.opts.config.worktreeRoot, `${runId}-squashed`);
      await createWorktree(run.repo, worktree, branch, commit);
      await this.stopLocalPreview(runId);
      const saved = this.store.get(runId) ?? run;
      const durationMs = verification.checks.reduce((total, check) => total + check.durationMs, 0);
      saved.stages.push({ name: "branch-preparation", role: "Shipyard", status: "passed", commit, finalized: true, attempts: [{
        attempt: 1, agentOk: true, costUsd: null, turns: 0, durationMs, passed: true, gates: verification.checks,
        summary: `Combined ${commits} commits into one on ${branch} and verified the project. The original branch is available as a backup.`,
      }] });
      Object.assign(saved, { branch, worktree, baseSha: base, branchBaseSha: base, status: "passed", error: undefined,
        publication: undefined, browserCheck: undefined, verification: { ...verification, head: commit }, finishedAt: new Date().toISOString(), completionRead: false });
      saved.totals.durationMs += durationMs;
      saved.totals.attempts++;
      this.store.save(saved);
      this.store.event(runId, { type: "branch-prepared", branch, base, head, commit, previousBranch: run.branch });
      return { run: saved };
    } finally {
      if (release) release();
    }
  }

  setArchived(runId: string, archived: boolean): RunRecord {
    const run = this.inactiveRun(runId);
    run.archivedAt = archived ? run.archivedAt ?? new Date().toISOString() : undefined;
    this.store.save(run);
    return run;
  }

  acknowledgeCompletion(runId: string, finishedAt: string): RunRecord {
    const run = this.store.get(runId);
    if (!run) throw new UserError("No such run");
    if (run.status === "running" || run.finishedAt !== finishedAt) throw new UserError("This run's result has changed");
    if (!run.completionRead) {
      run.completionRead = true;
      this.store.save(run);
    }
    return run;
  }

  async result(runId: string) {
    const run = this.store.get(runId);
    if (!run) throw new UserError("No such run");
    const latest = this.latestBranchRun(run);
    const historical = latest.id !== runId;
    const [remotes, preview, head] = await Promise.all([
      git(["remote"], run.repo).catch(() => undefined),
      this.previews.get(runId)?.catch(() => undefined),
      historical ? run.stages.findLast((stage) => stage.commit)?.commit ?? run.baseSha :
        git(["rev-parse", "--verify", `refs/heads/${run.branch}`], run.repo).catch(() => undefined),
    ]);
    const [committed, uncommitted] = await Promise.all([
      head ? git(["diff", "--name-status", "-z", "--no-renames", `${run.baseSha}..${head}`, "--"], run.repo, { raw: true }).catch(() => undefined) : undefined,
      !run.cleanedUp && !historical ? changedFiles(run.worktree).catch(() => undefined) : undefined,
    ]);
    const files: Array<{ status: string; path: string }> = [];
    const changes = committed?.split("\0") ?? [];
    for (let i = 0; i + 1 < changes.length; i += 2) files.push({ status: changes[i]!, path: changes[i + 1]! });
    const target = this.opts.config.targets[run.target];
    const destination = remotes ? await pushDestination(run.repo, remotes).catch(() => undefined) : undefined;
    const canPush = !historical && run.status === "passed" && Boolean(run.finishedAt) &&
      Boolean(head && head !== (run.branchBaseSha ?? run.baseSha)) && run.branch.startsWith("shipyard/");
    const pushed = Boolean(destination && run.publication?.head === head && run.publication?.destination === destination.key);
    const linkedUrl = destination && run.publication?.destination === destination.key ? run.publication.pullRequestUrl : undefined;
    const closedUrl = canPush && destination?.repository && linkedUrl &&
      await linkedPullRequestState(run.repo, destination.repository, linkedUrl, this.stopResultChecks.signal) === "closed" ? linkedUrl : undefined;
    const pullRequestUrl = closedUrl ? undefined : linkedUrl;
    const pullRequest = pushed && destination?.repository && head && !pullRequestUrl
      ? await pullRequestOptions(run.repo, destination.repository, head, this.stopResultChecks.signal)
      : {};
    const localApp = this.localApps.get(runId);
    const stage = target && uncommitted?.length ? recoverableStage(run) : undefined;
    const verifiedEdits = stage && run.verification?.editsDigest &&
      run.verification.editsDigest === await editsDigest(run.worktree).catch(() => undefined);
    return {
      latestRevisionId: historical ? latest.id : undefined,
      canGiveFeedback: !historical && uncommitted?.length === 0 && this.canGiveFeedback(run),
      canPrepareBranch: !historical && uncommitted?.length === 0 && this.canPrepareBranch(run),
      publish: destination && canPush ? {
        remote: destination.remote, label: destination.label, destination: destination.key, head,
        pushed, canDraftPullRequest: Boolean(destination.repository && pullRequest.pullRequestBlocked !== "no-changes"),
        pullRequestUrl, closedPullRequestUrl: closedUrl, ...pullRequest,
      } : undefined,
      publishUnavailable: remotes && canPush && !destination ? "Choose one push destination by configuring origin with a single supported Git URL." : undefined,
      canReleaseToCloudRun: Boolean(!historical && head && run.status === "passed" && run.finishedAt &&
        run.stages.some((stage) => stage.name === "cloud-release" && stage.status === "passed")),
      cloudRelease: run.cloudRelease,
      hasRemote: remotes === undefined ? undefined : Boolean(remotes),
      canPreview: !historical && Boolean(run.finishedAt) && ["passed", "failed"].includes(run.status) && !run.cleanedUp && canPreview(run.worktree),
      recheckStage: stage?.name,
      canFixRevision: Boolean(target && uncommitted && repairableRevisionStage(run)),
      savedEditsCheck: stage ? this.verifications.has(runId) ? "checking" : verifiedEdits ?
        run.verification!.checks.every(gateOk) ? "passed" : "failed" : "unchecked" : undefined,
      previewUrl: preview?.url,
      canRunLocally: !historical && run.status === "passed" && Boolean(run.finishedAt) && !run.cleanedUp && existsSync(run.worktree),
      localApp: localApp ? { url: localApp.url, starting: !localApp.url } : undefined,
      handoff: {
        head, fileCount: committed === undefined ? undefined : files.length, files: files.slice(0, 40),
        uncommittedCount: uncommitted?.length,
        uncommittedFiles: uncommitted?.slice(0, 40),
        configuredChecks: [target?.test, target?.e2e, target?.browserCheck ? BROWSER_CHECK : undefined].filter(Boolean),
      },
    };
  }

  async cloudRelease(runId: string, input: Record<string, unknown>) {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    if (run.status !== "passed" || !run.finishedAt || !run.stages.some((stage) => stage.name === "cloud-release" && stage.status === "passed")) {
      throw new UserError("Complete a run with the Google Cloud release specialist first");
    }
    const head = await git(["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`], run.repo).catch(() => undefined);
    if (!head) throw new UserError("The run’s branch is unavailable");
    try {
      if (input.action === "prepare") return { review: await this.cloudReleases.prepare(runId, head, input) };
      if (input.action !== "deploy" || input.confirm !== true) throw new Error("Review and approve the exact Cloud Run revision first.");
      const release = await this.cloudReleases.deploy(runId, head, input.token);
      const saved = this.store.get(runId);
      if (saved) {
        saved.cloudRelease = release;
        this.store.save(saved);
        this.store.event(runId, { type: "cloud-release-deployed", ...release });
      }
      return { release };
    } catch (error) {
      throw new UserError((error as Error).message);
    }
  }

  async connectRemote(runId: string, input: unknown): Promise<void> {
    const url = gitRemoteUrl(input);
    const run = this.inactiveRun(runId);
    if (!run.finishedAt || run.cleanedUp || await repoRoot(run.repo).catch(() => undefined) !== run.repo) {
      throw new UserError("The run’s repository is unavailable");
    }
    await withRepoLock(run.repo, async () => {
      const remotes = await git(["remote"], run.repo);
      if (remotes) {
        const origin = await git(["config", "--local", "--get", "remote.origin.url"], run.repo).catch(() => undefined);
        if (origin === url) return;
        throw new UserError("This repository already has a Git remote. Its settings were kept.");
      }
      try {
        await git(["remote", "add", "--", "origin", url], run.repo);
      } catch {
        throw new UserError("Git could not save origin. Check the repository’s Git configuration and try again.");
      }
    });
    this.emit({ type: "git-remote", repo: run.repo });
  }

  publish(runId: string, input: { destination?: unknown; head?: unknown; draft?: unknown }, action: "push" | "pull-request" = "push",
    review?: Pick<DraftReview, "base" | "description">): Promise<void> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    if (action === "pull-request" && input.draft !== undefined && typeof input.draft !== "boolean") {
      throw new UserError("Draft must be true or false");
    }
    const run = this.inactiveBranchRun(runId);
    if (run.status !== "passed" || !run.finishedAt || !run.branch.startsWith("shipyard/")) {
      throw new UserError("Only a completed Shipyard run can publish its branch");
    }
    if (this.publications.has(runId)) throw new UserError("A GitHub or push operation is already running for this result");
    const publishing = withRepoLock(run.repo, async () => {
      const saved = this.inactiveBranchRun(runId);
      if (saved.finishedAt !== run.finishedAt || saved.status !== "passed" || saved.branch !== run.branch || this.shuttingDown) {
        throw new UserError("The run changed. Reopen the handoff to see its current details");
      }
      const [remotes, head] = await Promise.all([
        git(["remote"], run.repo).catch(() => ""),
        git(["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`], run.repo).catch(() => undefined),
      ]);
      const destination = await pushDestination(run.repo, remotes).catch(() => undefined);
      if (!destination || !head || head === (run.branchBaseSha ?? run.baseSha) || input.head !== head || input.destination !== destination.key) {
        throw new UserError("The branch or destination changed. Reopen the handoff and review the current branch and remote");
      }
      const publication = saved.publication?.head === head && saved.publication.destination === destination.key ? saved.publication : undefined;
      if (action === "pull-request") {
        if (!publication || !destination.repository) throw new UserError("Push the completed branch to GitHub before creating a pull request");
        if (!review && publication.pullRequestUrl && await linkedPullRequestState(run.repo, destination.repository,
          publication.pullRequestUrl, this.stopResultChecks.signal) !== "closed") return;
        let pullRequestUrl: string;
        try {
          const description = review?.description ?? await describePullRequest(run.repo, run.branchBaseSha ?? run.baseSha,
            head, describeRunChecks(saved, head));
          pullRequestUrl = await createRunPullRequest(run.repo, destination.repository, run.branch, head,
            this.stopResultChecks.signal, { draft: input.draft === true, description, reviewedBase: review?.base });
        } catch (error) {
          throw new UserError((error as Error).message);
        }
        const updated = this.store.get(runId);
        if (!updated) return;
        updated.publication = { ...publication, pullRequestUrl };
        this.store.save(updated);
        this.store.event(runId, { type: "pull-request-linked", branch: run.branch, head, url: pullRequestUrl });
        return;
      }
      if (publication) return;
      try {
        await pushRunCommit(run.repo, destination, run.branch, head, this.stopResultChecks.signal);
      } catch (error) {
        throw new UserError((error as Error).message);
      }
      const updated = this.store.get(runId);
      if (!updated) return;
      updated.publication = { head, destination: destination.key, pushedAt: new Date().toISOString(),
        pullRequestUrl: saved.publication?.destination === destination.key ? saved.publication.pullRequestUrl : undefined };
      this.store.save(updated);
      this.store.event(runId, { type: "branch-pushed", branch: run.branch, remote: destination.remote, head });
      this.emit({ type: "git-remote", repo: run.repo });
    }).finally(() => this.publications.delete(runId));
    this.publications.set(runId, publishing);
    return publishing;
  }

  async draftPullRequest(runId: string, input: { action?: unknown; destination?: unknown; head?: unknown; token?: unknown; description?: unknown }) {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    if (run.status !== "passed" || !run.finishedAt || run.cleanedUp || !run.branch.startsWith("shipyard/")) {
      throw new UserError("Complete the run before creating a draft pull request");
    }
    if (input.action !== "review" && input.action !== "create") throw new UserError("Choose whether to review or create the draft pull request");
    const review = input.action === "create" ? this.draftReviews.get(runId) : undefined;
    if (input.action === "create" && (!review || input.token !== review.token)) {
      throw new UserError("Reopen the review to confirm the current branch and destination");
    }
    const description = typeof input.description === "string" ? input.description : input.description === undefined ? review?.description ?? "" : "";
    if (review && (!description.trim() || description.length > MAX_PULL_REQUEST_DESCRIPTION)) {
      throw new UserError("Enter a pull request description between 1 and 32,000 characters");
    }
    const release = review && this.store.claimBranch(run);
    if (review && !release) throw new UserError("An operation is already running on this branch");
    let releasePrepared: (() => void) | undefined;
    const signal = this.stopResultChecks.signal;
    try {
      const [remotes, head] = await Promise.all([
        git(["remote"], run.repo).catch(() => ""),
        git(["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`], run.repo),
      ]);
      const destination = await pushDestination(run.repo, remotes);
      if (!destination?.repository || head === (run.branchBaseSha ?? run.baseSha) ||
          (review?.head ?? input.head) !== head || (review?.destination ?? input.destination) !== destination.key) {
        throw new UserError("The branch or GitHub destination changed. Reopen the handoff to review it again");
      }
      const base = await draftBase(run.repo, destination.repository, signal);
      if (!review) {
        await fetchDraftBase(run.repo, destination, base.head, signal);
        const branch = await reviewDraftBranch(run, head, base.head, this.opts.config.worktreeRoot);
        const target = this.opts.config.targets[run.target];
        const checkLines = branch.transplant
          ? [...new Set([target?.test, target?.e2e, target?.browserCheck ? BROWSER_CHECK : undefined])]
            .filter((check): check is string => Boolean(check)).map((check) => `- ${markdownCode(check)} required before publication.`)
          : describeRunChecks(run, head);
        const diffBase = branch.transplant ? base.head : await git(["merge-base", base.head, head], run.repo);
        const description = await describePullRequest(run.repo, diffBase, branch.transplant?.tree ?? head, checkLines);
        const details = { ...branch, base, head, description, repository: destination.repository,
          destination: destination.key, token: randomBytes(24).toString("hex") };
        this.draftReviews.set(runId, details);
        return { review: details };
      }
      if (review.base.branch !== base.branch || review.base.head !== base.head) {
        throw new UserError("GitHub’s default branch moved. Reopen the review to approve the current commit");
      }
      let draftHead = head;
      if (review.transplant) {
        const target = this.opts.config.targets[run.target];
        if (!target || await repoRoot(target.path).catch(() => undefined) !== run.repo || (await changedFiles(run.worktree)).length) {
          throw new UserError("Preparing the draft needs the original repository and a clean run worktree");
        }
        const title = await git(["show", "-s", "--format=%s", head], run.repo);
        draftHead = await commitTree(run.repo, review.transplant.tree, base.head, title || `Shipyard update for ${run.target}`);
        const candidate = await detachedWorktree(run.repo, this.opts.config.worktreeRoot, draftHead);
        let adopted = false;
        try {
          const checks = await this.runProjectChecks(target, candidate.worktree, Boolean(target.browserCheck));
          const failed = checks.find((gate) => !gateOk(gate));
          if (failed) throw new UserError(`${failed.command} failed on the proposed draft branch. ${failed.outputTail.slice(-1200)}`);
          const latestBase = await draftBase(run.repo, destination.repository, signal);
          if (latestBase.branch !== base.branch || latestBase.head !== base.head) throw new UserError("GitHub’s default branch moved. Reopen the review to approve it again");
          if (await git(["rev-parse", "HEAD"], candidate.worktree) !== draftHead || (await changedFiles(candidate.worktree)).length ||
              await git(["rev-parse", "HEAD"], run.worktree) !== head || (await changedFiles(run.worktree)).length) {
            throw new UserError("A worktree changed during verification. Reopen the review before publishing");
          }
          const updated = this.inactiveBranchRun(runId);
          if (updated.branch !== run.branch || updated.finishedAt !== run.finishedAt) throw new UserError("The run changed. Reopen the draft review");
          releasePrepared = this.store.claimBranch({ ...updated, branch: review.branch });
          if (!releasePrepared) throw new UserError("The proposed branch is in use. Reopen the review for a new branch name");
          await git(["-c", "core.hooksPath=/dev/null", "switch", "-c", review.branch], candidate.worktree);
          const durationMs = checks.reduce((sum, gate) => sum + gate.durationMs, 0);
          updated.stages.push({ name: "draft-pr-preparation", role: "Shipyard", status: "passed", commit: draftHead, finalized: true, attempts: [{
            attempt: 1, agentOk: true, costUsd: null, turns: 0, durationMs, passed: true, gates: checks,
            summary: `Prepared and verified ${review.branch} on GitHub’s ${base.branch} branch. The original branch is available as a backup.`,
          }] });
          Object.assign(updated, { branch: review.branch, worktree: candidate.worktree, baseSha: base.head, branchBaseSha: base.head,
            publication: undefined, browserCheck: undefined, verification: { head: draftHead, checks }, finishedAt: new Date().toISOString() });
          updated.totals.durationMs += durationMs;
          updated.totals.attempts++;
          this.store.save(updated);
          adopted = true;
          this.store.event(runId, { type: "draft-branch-prepared", previousBranch: run.branch, branch: review.branch, base: base.head, head: draftHead });
          await this.stopLocalPreview(runId);
        } finally {
          if (!adopted) await candidate.close();
        }
      }
      this.draftReviews.delete(runId);
      const approval = { head: draftHead, destination: destination.key, draft: true };
      await this.publish(runId, approval, "push");
      await this.publish(runId, approval, "pull-request", { base: review.base, description });
      return { result: await this.result(runId) };
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError((error as Error).message);
    } finally {
      releasePrepared?.();
      release?.();
    }
  }

  async startLocalPreview(runId: string): Promise<string> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    if (!run.finishedAt || !["passed", "failed"].includes(run.status) || run.cleanedUp || !canPreview(run.worktree)) {
      throw new UserError("Local preview needs a finished run with an index.html in its worktree");
    }
    let pending = this.previews.get(runId);
    if (!pending) {
      pending = startPreview(run.worktree);
      this.previews.set(runId, pending);
    }
    try {
      const { url } = await pending;
      if (this.previews.get(runId) !== pending) throw new UserError("The preview was stopped while starting");
      this.emit({ type: "preview", runId, url });
      return url;
    } catch (error) {
      if (this.previews.get(runId) === pending) this.previews.delete(runId);
      if (error instanceof UserError) throw error;
      throw new UserError("The local preview server could not start");
    }
  }

  async startLocalApp(runId: string): Promise<string> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    if (run.status !== "passed" || !run.finishedAt || run.cleanedUp || !existsSync(run.worktree)) {
      throw new UserError("Running locally needs a completed run with its worktree");
    }
    let session = this.localApps.get(runId);
    if (!session) {
      const runner = run.provider === "codex" ? this.opts.codexRunner : this.opts.runner;
      if (!runner) throw new UserError("This run’s agent provider is unavailable");
      const controller = new AbortController();
      const clear = () => {
        if (this.localApps.get(runId)?.controller !== controller) return;
        this.localApps.delete(runId);
        this.emit({ type: "local-app", runId });
      };
      const ready = (async () => {
        const branch = await git(["symbolic-ref", "HEAD"], run.worktree).catch(() => "");
        if (branch !== `refs/heads/${run.branch}`) throw new Error("Open the original Shipyard worktree and branch to run this app");
        const inspectSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
        inspectSignal.throwIfAborted();
        const plan = await runner.run({
          role: requireRole(this.opts.roles, "local-app"), prompt: "Identify the main web app to run locally from this completed worktree.",
          cwd: run.worktree, lane: "none", signal: inspectSignal, model: run.model, effort: run.effort,
          maxBudgetUsd: Math.min(run.budgetUsd ?? this.opts.config.maxBudgetUsdPerRun, this.opts.config.maxBudgetUsdPerStage),
          outputSchema: LOCAL_APP_SCHEMA,
        });
        if (inspectSignal.aborted && !controller.signal.aborted) throw new Error("The local app agent did not finish within two minutes");
        controller.signal.throwIfAborted();
        if (!plan.ok) throw new Error(plan.error || "The local app agent could not identify how to start this project");
        return launchLocalApp(run.worktree, run.repo, plan.structured, controller.signal, clear);
      })().catch((error) => {
        clear();
        throw new UserError(controller.signal.aborted ? "Local app startup was stopped" : (error as Error).message);
      });
      session = { controller, ready };
      this.localApps.set(runId, session);
      this.emit({ type: "local-app", runId, app: { starting: true } });
    }
    const { url } = await session.ready;
    if (this.localApps.get(runId) !== session || session.controller.signal.aborted) throw new UserError("The local app stopped before it was ready");
    session.url = url;
    this.emit({ type: "local-app", runId, app: { url, starting: false } });
    return url;
  }

  async stopLocalApp(runId: string): Promise<void> {
    const session = this.localApps.get(runId);
    if (!session) return;
    this.localApps.delete(runId);
    session.controller.abort();
    const app = await session.ready.catch(() => undefined);
    await app?.close();
    if (!this.localApps.has(runId)) this.emit({ type: "local-app", runId });
  }

  checkLocalBrowser(runId: string): Promise<GateRecord> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    if (!run.finishedAt || run.cleanedUp || !canPreview(run.worktree)) {
      throw new UserError("Browser verification needs a finished run with an index.html in its worktree");
    }
    const current = this.browserChecks.get(runId);
    if (current) return current;
    const check = checkBrowser(run.worktree, undefined, this.stopResultChecks.signal).then(({ command, code, timedOut, durationMs, output }) => {
      const gate = { command, code, timedOut, durationMs, outputTail: output.slice(-4000), checkedAt: new Date().toISOString() };
      const saved = this.store.get(runId);
      if (saved?.finishedAt === run.finishedAt && saved && !this.stopResultChecks.signal.aborted) {
        saved.browserCheck = gate;
        this.store.save(saved);
      }
      return gate;
    }).finally(() => this.browserChecks.delete(runId));
    this.browserChecks.set(runId, check);
    return check;
  }

  verifyResult(runId: string, includeBrowser = false): Promise<NonNullable<RunRecord["verification"]>> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveBranchRun(runId);
    const target = this.opts.config.targets[run.target];
    if (!run.finishedAt || run.status === "stopped" || run.cleanedUp || !target || !existsSync(run.worktree)) {
      throw new UserError("Verification needs a finished run with its configured repository and worktree");
    }
    const pending = this.verifications.get(runId);
    if (pending) return pending;
    const check = (async () => {
      if (await repoRoot(target.path).catch(() => undefined) !== run.repo) throw new UserError("Configure the original target first");
      const head = await git(["rev-parse", "HEAD"], run.worktree);
      const branch = await git(["symbolic-ref", "HEAD"], run.worktree).catch(() => "");
      const dirty = (await changedFiles(run.worktree)).length > 0;
      const recovery = dirty ? recoverableStage(run) : undefined;
      if (branch !== `refs/heads/${run.branch}` || (dirty && !recovery)) {
        throw new UserError("Verification needs the original branch and a clean worktree");
      }
      const digest = recovery ? await editsDigest(run.worktree) : undefined;
      const hadBrowserFailure = recovery?.attempts.some(({ gates }) => gates.some(({ command }) => command === BROWSER_CHECK));
      const checks = await this.runProjectChecks(target, run.worktree, Boolean(target.browserCheck && (includeBrowser || hadBrowserFailure)));
      if (await git(["rev-parse", "HEAD"], run.worktree) !== head ||
          await git(["symbolic-ref", "HEAD"], run.worktree).catch(() => "") !== branch ||
          (digest ? await editsDigest(run.worktree).catch(() => undefined) !== digest : (await changedFiles(run.worktree)).length > 0)) {
        throw new UserError("The run or worktree changed during verification. Results were not saved.");
      }
      const saved = this.store.get(runId);
      if (this.shuttingDown || !saved || saved.finishedAt !== run.finishedAt) throw new UserError("The run changed during verification");
      saved.verification = { head, checks, ...(digest ? { editsDigest: digest } : {}) };
      this.store.save(saved);
      return saved.verification;
    })().finally(() => this.verifications.delete(runId));
    this.verifications.set(runId, check);
    return check;
  }

  private async runProjectChecks(target: Target, worktree: string, browser: boolean): Promise<GateRecord[]> {
    const signal = this.stopResultChecks.signal;
    const checks: GateRecord[] = [];
    for (const command of new Set([target.test, target.e2e])) {
      if (!command) continue;
      const { code, timedOut, durationMs, output } = await sh(command, worktree, undefined, signal);
      checks.push({ command, code, timedOut, durationMs, outputTail: output.slice(-4000), checkedAt: new Date().toISOString() });
    }
    if (browser) {
      const { code, timedOut, durationMs, output } = await checkBrowser(worktree, undefined, signal);
      checks.push({ command: BROWSER_CHECK, code, timedOut, durationMs, outputTail: output.slice(-4000), checkedAt: new Date().toISOString() });
    }
    return checks;
  }

  checkResultReferences(runId: string, input: unknown): Promise<RunRecord> {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveRun(runId);
    if (!run.finishedAt) throw new UserError("Wait for the run to finish before checking its references");
    let urls: string[];
    let approved: string[];
    try {
      urls = parseReferencePermissions(input);
      approved = parseReferencePermissions([...new Set([...(run.referenceUrls ?? []), ...urls])]);
    }
    catch (error) { throw new UserError((error as Error).message); }
    if (!urls.length) throw new UserError("Enter at least one public reference URL");
    if (this.referenceChecks.has(runId)) throw new UserError("A reference check is already running");
    const sharedUrls = new Set(run.references?.filter((check) => check.shared).map((check) => check.url));
    const reading = Promise.all(urls.filter((url) => !sharedUrls.has(url)).map((url) =>
      readPublicReference(url, this.stopResultChecks.signal))).then((checks) => {
      const saved = this.store.get(runId);
      if (this.shuttingDown || !saved || saved.finishedAt !== run.finishedAt) throw new UserError("The run changed during the reference check");
      saved.referenceUrls = approved;
      const byUrl = new Map(saved.references?.map((check) => [check.url, check]));
      for (const check of checks) if (!byUrl.get(check.url)?.shared) byUrl.set(check.url, check);
      saved.references = [...missingReferencePermissions(saved.request, approved),
        ...approved.flatMap((url) => byUrl.get(url) ?? [])];
      this.store.save(saved);
      for (const { url, label, status, detail } of saved.references) this.store.event(runId, { type: "reference", source: "manual", url, label, status, detail });
      return saved;
    }).finally(() => this.referenceChecks.delete(runId));
    this.referenceChecks.set(runId, reading);
    return reading;
  }

  referenceHandoffStatuses() { return this.referenceHandoffs.statuses(); }

  openReferenceHandoff(runId: string, input: { url?: unknown; itemId?: unknown }, port: number) {
    const { scope } = this.referenceHandoffScope(runId, input);
    return this.referenceHandoffs.open(scope, port);
  }

  cancelReferenceHandoff(runId: string, input: { url?: unknown; itemId?: unknown }) {
    const { scope } = this.referenceHandoffScope(runId, input);
    this.referenceHandoffs.revoke(runId, scope);
    this.emit({ type: "reference-handoff", runId, url: scope.url });
  }

  private referenceHandoffScope(runId: string, input: { url?: unknown; itemId?: unknown }): { scope: ReferenceScope; run: RunRecord } {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.store.get(runId);
    const url = input.url;
    if (!run || typeof url !== "string" || !run.referenceUrls?.includes(url)) throw new UserError("Approve the reference URL first");
    const itemId = typeof input.itemId === "string" && input.itemId ? input.itemId : undefined;
    const control = this.controls.get(runId);
    if (run.finishedAt) {
      if (itemId) throw new UserError("This reference request is no longer active");
      this.inactiveRun(runId);
    } else {
      const item = itemId ? this.pending.get(itemId)?.item : undefined;
      if (!control || control.stopped || item?.kind !== "reference" || item.needsApproval || item.runId !== runId || item.url !== url) {
        throw new UserError("Open the matching reference request in Needs you first");
      }
    }
    return { scope: { runId, url, itemId, provider: control?.requestedProvider ?? run.provider ?? "claude" }, run };
  }

  referenceHandoffContext(ticket: string) {
    const { handoff, run } = this.authorizeReferenceHandoff(ticket);
    const previous = run.references?.find((check) => check.url === handoff.url);
    const brief = [
      run.request.slice(0, 3500),
      run.followUp?.brief ? `Original project brief: ${run.followUp.brief.slice(0, 2200)}` : "",
      previous?.missing?.length ? `Previously missing: ${previous.missing.join("; ").slice(0, 2000)}` : "",
    ].filter(Boolean).join("\n\n");
    return { url: handoff.url, provider: handoff.provider, brief, submitted: Boolean(handoff.draft) };
  }

  returnReferenceHandoff(ticket: string, value: unknown): void {
    const { handoff } = this.authorizeReferenceHandoff(ticket);
    const draft = parseReferenceDraft(value);
    if (!draft) throw new UserError("Return source notes with coverage, or a short reason access was blocked");
    if (handoff.draft) {
      if (JSON.stringify(handoff.draft) === JSON.stringify(draft)) return;
      throw new UserError("This handoff already has a result. Ask for a fresh handoff to retry.");
    }
    handoff.draft = draft;
    this.store.event(handoff.runId, { type: "reference-handoff", status: draft.status, url: handoff.url, provider: handoff.provider });
    this.emit({ type: "reference-handoff", runId: handoff.runId, url: handoff.url, status: draft.status });
  }

  private authorizeReferenceHandoff(ticket: string) {
    const handoff = this.referenceHandoffs.get(ticket);
    if (!handoff) throw new UserError("This handoff is unavailable or expired. Open the reference again in Shipyard.");
    const { scope, run } = this.referenceHandoffScope(handoff.runId, handoff);
    if (scope.provider !== handoff.provider) throw new UserError("The run’s provider changed. Open the reference again in Shipyard.");
    return { handoff, run };
  }

  saveSharedReference(runId: string, url: unknown, text: unknown, files?: unknown): RunRecord {
    if (this.shuttingDown) throw new UserError("Shipyard is shutting down");
    const run = this.inactiveRun(runId);
    if (!run.finishedAt) throw new UserError("Use the browser request in Needs you for an active run");
    if (typeof url !== "string" || !run.referenceUrls?.includes(url)) throw new UserError("Approve the reference URL before sharing browser text");
    if (!validReferenceText(text)) throw new UserError("Enter between 1 and 24,000 characters of reference text");
    const attachments = this.saveAttachments(runId, files);
    const draft = this.referenceHandoffs.draft(runId, url);
    this.referenceHandoffs.revoke(runId, { url });
    this.emit({ type: "reference-handoff", runId, url });
    const check = sharedReference(url, { text, coverage: draft?.status === "ready" ? draft.coverage : undefined,
      missing: draft?.status === "ready" ? draft.missing : undefined,
      attachments: attachments ? { runId, files: attachments } : run.references?.find((previous) => previous.url === url)?.attachments });
    run.references = [...(run.references ?? []).filter((previous) => previous.url !== url), check];
    this.store.save(run);
    this.store.event(runId, { type: "reference", source: "manual", url, status: check.status, detail: check.detail });
    return run;
  }

  async stopLocalPreview(runId: string): Promise<void> {
    const pending = this.previews.get(runId);
    if (!pending) return;
    this.previews.delete(runId);
    const preview = await pending.catch(() => undefined);
    await preview?.close();
    if (!this.previews.has(runId)) this.emit({ type: "preview", runId });
  }

  async deleteHistory(runId: string): Promise<void> {
    const run = this.inactiveRun(runId);
    const latest = this.latestBranchRun(run).id === runId;
    const release = latest ? this.store.claimBranch(run) : undefined;
    if (latest && !release) throw new UserError("Wait for the current branch operation to finish before deleting this run");
    try {
      this.referenceHandoffs.revoke(runId);
      this.draftReviews.delete(runId);
      this.store.delete(runId);
      await Promise.all([this.stopLocalPreview(runId), this.stopLocalApp(runId)]);
      this.emit({ type: "run-deleted", runId });
    } finally {
      release?.();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopResultChecks.abort();
    for (const control of this.controls.values()) control.stop();
    await Promise.allSettled([...this.active.values(), ...this.browserChecks.values(), ...this.verifications.values(), ...this.referenceChecks.values(), ...this.publications.values(), ...this.clones.values(), ...[...this.previews.keys()].map((id) => this.stopLocalPreview(id)), ...[...this.localApps.keys()].map((id) => this.stopLocalApp(id))]);
    await this.cloudReleases.shutdown();
  }

  /** Answer one inbox item. Other items, and other agents, are unaffected. */
  answer(id: string, incoming: InboxAnswer): void {
    const entry = this.pending.get(id);
    if (!entry) throw new UserError("That item was already answered or no longer exists");
    validateAnswer(entry.item, incoming);
    const { attachments: files, ...response } = incoming;
    const acceptsFiles = response.kind === "question" || response.kind === "permission" ||
      (response.kind === "checkpoint" && response.action === "feedback") || (response.kind === "reference" && response.action === "share");
    if (!acceptsFiles && files !== undefined) throw new UserError("Attachments need feedback, an answer, or reference notes");
    const attachments = this.saveAttachments(entry.item.runId, files);
    let answer: InboxAnswer<FeedbackAttachment[]> = { ...response, attachments };
    this.pending.delete(id);
    if (entry.item.kind === "reference" && !entry.item.needsApproval) {
      const draft = this.referenceHandoffs.draft(entry.item.runId, entry.item.url, id);
      if (answer.kind === "reference" && answer.action === "share") {
        answer = { kind: "reference", action: "share", text: answer.text, attachments,
          review: draft?.status === "ready" ? { coverage: draft.coverage, missing: draft.missing } : undefined };
      } else if (answer.kind === "reference" && answer.action === "skip") {
        answer = { kind: "reference", action: "skip", blocked: draft?.status === "blocked" ? draft.reason : undefined };
      }
      this.referenceHandoffs.revoke(entry.item.runId, { itemId: id });
      this.emit({ type: "reference-handoff", runId: entry.item.runId, url: entry.item.url });
    }
    if (answer.kind === "permission" && answer.decision === "allow-run" && entry.item.kind === "permission") {
      const tools = this.allowedForRun.get(entry.item.runId) ?? new Set<string>();
      tools.add(entry.item.tool);
      this.allowedForRun.set(entry.item.runId, tools);
    }
    this.store.event(entry.item.runId, { stage: entry.item.stage, type: "answered", kind: entry.item.kind,
      answer: answer.kind === "reference" ? { kind: answer.kind, action: answer.action } : answer });
    this.emit({ type: "inbox-resolved", id, runId: entry.item.runId });
    entry.resolve(answer);
  }

  private async review(ctx: CheckpointContext, signal?: AbortSignal): Promise<CheckpointDecision> {
    const diff = await diffSinceHead(ctx.worktree);
    const answer = await this.enqueue({ kind: "checkpoint", runId: ctx.runId, stage: ctx.stage, role: ctx.role, checkpoint: ctx, diff }, signal);
    if (answer?.kind !== "checkpoint") return { action: "stop" };
    return answer.action === "feedback" ? { action: "feedback", message: answer.message, attachments: answer.attachments } : { action: answer.action };
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
    const context = answer?.attachments?.length ? attachmentContext(resolveAttachments(this.store.dir(from.runId), answer.attachments)) : undefined;
    const contextField = context ? { attachmentContext: context } : {};
    if (answer?.kind === "question") return { kind: "question", answers: answer.answers, ...contextField };
    if (answer?.kind === "permission") return { kind: "permission", allow: answer.decision !== "deny", message: answer.message, ...contextField };
    return { kind: "permission", allow: false };
  }

  private enqueue(item: DistributiveOmit<InboxItem, "id" | "createdAt">, signal?: AbortSignal): Promise<InboxAnswer<FeedbackAttachment[]> | undefined> {
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

function describeRunChecks(run: RunRecord, head: string): string[] {
  const verified = run.verification?.head === head && !run.verification.editsDigest ? run.verification.checks : undefined;
  const recorded = run.stages.findLast((stage) => stage.commit)?.commit === head
    ? run.stages.flatMap((stage) => stage.attempts.at(-1)?.gates ?? []) : [];
  const checks = new Map((verified ?? recorded).filter((check) => !check.expectFailure).map((check) => [check.command, check]));
  return [...checks.values()].map((check) => `- ${gateOk(check) ? "Passed" : "Failed"} ${markdownCode(check.command)}.`);
}

async function editsDigest(worktree: string): Promise<string> {
  return createHash("sha256").update(await worktreeSnapshot(worktree)).digest("hex");
}

function gitRemoteUrl(input: unknown): string {
  const invalid = () => new UserError("Enter an HTTPS or SSH clone URL for the repository, with no embedded password or access token.");
  if (typeof input !== "string") throw invalid();
  const url = input.trim();
  if (!url || url.length > 2048 || /[\s\u0000-\u001f\u007f\\?#]/.test(url)) throw invalid();
  if (/^[\w.-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:\/?[\w.-][\w./~+-]*$/i.test(url)) return url;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw invalid(); }
  if (!/^(?:https|ssh):\/\//i.test(url) || !parsed.hostname || parsed.pathname.length <= 1 || parsed.password ||
      (parsed.protocol === "https:" && parsed.username) || (parsed.protocol === "ssh:" && !/^[\w.-]*$/.test(parsed.username))) throw invalid();
  return url;
}

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
  if (answer.kind === "reference" && item.kind === "reference" && answer.action !== "skip") {
    if (item.needsApproval) {
      if (answer.action !== "approve") throw new UserError("Approve or skip this public reference");
    } else if (answer.action !== "share" || !validReferenceText(answer.text)) {
      throw new UserError("Share between 1 and 24,000 characters of reference text or skip the reference");
    }
  }
}
