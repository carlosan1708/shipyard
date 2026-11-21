import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { AuthMode } from "./auth.ts";

/** The shipyard repository root (works from `npm run` and from bin/shipyard.mjs). */
export const SHIPYARD_ROOT = process.env.SHIPYARD_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Target {
  name: string;
  /** Absolute path to the target git repository. */
  path: string;
  /** Unit test command, run as the gate after the implement stage. */
  test: string;
  /** E2E command, run as the gate after the E2E stage. Optional. */
  e2e?: string;
  /** Verify static pages in a host-managed Chrome session. */
  browserCheck?: boolean;
  /** Default browser-tool permission for new runs against this target. */
  browserAccess?: boolean;
}

export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];
export type RunEffort = EffortLevel | CodexEffort;
export const CODEX_TIMEOUT_MS = 20 * 60_000;

export interface CodexConfig {
  model?: string;
  models: string[];
  effort?: CodexEffort;
  timeoutMsPerAttempt: number;
}

export interface ShipyardConfig {
  defaultProvider?: Provider;
  codex?: CodexConfig;
  model: string;
  /** Models you can pick per run (the default model is always first). */
  models: string[];
  effort: EffortLevel;
  auth: AuthMode;
  /** Estimated cost cap for each agent invocation. */
  maxBudgetUsdPerStage: number;
  /** Estimated cost cap for a whole run: every stage and retry together. Can be changed per run. */
  maxBudgetUsdPerRun: number;
  maxTurnsPerStage: number;
  maxGateRetries: number;
  /** Tools agents may use only after a human approves each call (in `shipyard ui`). */
  askTools: string[];
  /** Where worktrees are created. Kept outside this repo so its CLAUDE.md never leaks into target sessions. */
  worktreeRoot: string;
  /** Where run records are written. */
  runsDir: string;
  targets: Record<string, Target>;
}

export const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** A run budget must be a positive, finite number of (estimated) dollars. */
export function isBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveProvider(value: unknown = "claude"): Provider {
  if (value === "claude" || value === "codex") return value;
  throw new Error("Provider must be claude or codex");
}

export function providerOptions(config: Pick<ShipyardConfig, "model"> & Partial<ShipyardConfig>, provider: Provider) {
  return provider === "codex"
    ? { model: config.codex?.model, models: config.codex?.models ?? [], effort: config.codex?.effort, efforts: CODEX_EFFORTS }
    : { model: config.model, models: config.models ?? [config.model], effort: config.effort, efforts: EFFORTS };
}

export function validateRunOptions(
  config: ShipyardConfig,
  provider: Provider,
  { model, effort, budgetUsd }: { model?: string; effort?: RunEffort; budgetUsd?: number },
): void {
  const options = providerOptions(config, provider);
  if (model !== undefined && !options.models.includes(model)) {
    const choices = options.models.length ? `Pick one of ${options.models.join(", ")}, or add another` : "Add model choices";
    throw new Error(`Unknown model "${model}" for ${provider}. ${choices} under ${provider === "codex" ? "codex.models" : "models"} in shipyard.config.yaml`);
  }
  if (effort !== undefined && !(options.efforts as readonly RunEffort[]).includes(effort)) {
    throw new Error(`effort must be one of ${options.efforts.join(", ")} for ${provider}`);
  }
  if (budgetUsd !== undefined) {
    if (provider === "codex") throw new Error("Dollar budgets are only supported for Claude runs");
    if (!isBudget(budgetUsd)) throw new Error("The budget must be a positive number of dollars");
  }
}

function parseCodexConfig(value: unknown): CodexConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("config.codex must be a mapping");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  const validModel = (model: unknown): model is string => typeof model === "string" && model.trim().length > 0;
  const { model, models, effort, timeoutMsPerAttempt = CODEX_TIMEOUT_MS } = raw;
  if (model !== undefined && !validModel(model)) throw new Error("config.codex.model must be a non-empty string");
  if (models !== undefined && (!Array.isArray(models) || !models.every(validModel))) {
    throw new Error("config.codex.models must be a list of model names");
  }
  if (effort !== undefined && !CODEX_EFFORTS.includes(effort as CodexEffort)) {
    throw new Error(`config.codex.effort must be one of ${CODEX_EFFORTS.join(", ")}`);
  }
  if (typeof timeoutMsPerAttempt !== "number" || !Number.isInteger(timeoutMsPerAttempt) || timeoutMsPerAttempt <= 0 || timeoutMsPerAttempt > 2_147_483_647) {
    throw new Error("config.codex.timeoutMsPerAttempt must be a positive integer within the Node timer range");
  }
  return {
    model,
    models: [...new Set([...(model ? [model] : []), ...(models ?? [])])],
    effort: effort as CodexEffort | undefined,
    timeoutMsPerAttempt,
  };
}

export function expandPath(p: string, baseDir: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

export function loadConfig(file = join(SHIPYARD_ROOT, "shipyard.config.yaml")): ShipyardConfig {
  if (!existsSync(file)) throw new Error(`Config not found: ${file}`);
  const raw = (YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  return parseConfig(raw, dirname(file));
}

export function parseConfig(raw: Record<string, unknown>, baseDir: string): ShipyardConfig {
  const num = (key: string, fallback: number): number => {
    const v = raw[key] ?? fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`config.${key} must be a non-negative number`);
    return v;
  };
  const effort = (raw.effort ?? "high") as EffortLevel;
  if (!EFFORTS.includes(effort)) throw new Error(`config.effort must be one of ${EFFORTS.join(", ")}`);
  const auth = (raw.auth ?? "subscription") as AuthMode;
  if (auth !== "subscription" && auth !== "api-key") throw new Error(`config.auth must be "subscription" or "api-key"`);

  const targets: Record<string, Target> = {};
  const rawTargets = (raw.targets ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, t] of Object.entries(rawTargets)) {
    if (typeof t?.path !== "string") throw new Error(`targets.${name}.path is required`);
    if (typeof t.test !== "string") throw new Error(`targets.${name}.test is required`);
    if (t.browserCheck !== undefined && typeof t.browserCheck !== "boolean") throw new Error(`targets.${name}.browserCheck must be true or false`);
    if (t.browserAccess !== undefined && typeof t.browserAccess !== "boolean") throw new Error(`targets.${name}.browserAccess must be true or false`);
    targets[name] = {
      name,
      path: expandPath(t.path, baseDir),
      test: t.test,
      e2e: typeof t.e2e === "string" ? t.e2e : undefined,
      ...(t.browserCheck === undefined ? {} : { browserCheck: t.browserCheck }),
      ...(t.browserAccess === undefined ? {} : { browserAccess: t.browserAccess }),
    };
  }

  const model = typeof raw.model === "string" ? raw.model : "claude-opus-5-5";
  const listed = Array.isArray(raw.models) ? raw.models.map(String) : ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

  return {
    defaultProvider: resolveProvider(raw.defaultProvider),
    codex: parseCodexConfig(raw.codex),
    model,
    models: [model, ...listed.filter((m) => m !== model)],
    effort,
    auth,
    maxBudgetUsdPerStage: num("maxBudgetUsdPerStage", 3),
    maxBudgetUsdPerRun: num("maxBudgetUsdPerRun", 10),
    maxTurnsPerStage: num("maxTurnsPerStage", 60),
    maxGateRetries: num("maxGateRetries", 2),
    askTools: Array.isArray(raw.askTools) ? raw.askTools.map(String) : ["WebFetch", "WebSearch"],
    worktreeRoot: expandPath(typeof raw.worktreeRoot === "string" ? raw.worktreeRoot : "~/.shipyard/worktrees", baseDir),
    runsDir: expandPath(typeof raw.runsDir === "string" ? raw.runsDir : ".shipyard/runs", baseDir),
    targets,
  };
}
