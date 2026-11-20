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
}

export interface ShipyardConfig {
  model: string;
  effort: EffortLevel;
  auth: AuthMode;
  maxBudgetUsdPerStage: number;
  maxTurnsPerStage: number;
  maxGateRetries: number;
  /** Where worktrees are created. Kept outside this repo so its CLAUDE.md never leaks into target sessions. */
  worktreeRoot: string;
  /** Where run records are written. */
  runsDir: string;
  targets: Record<string, Target>;
}

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

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
    targets[name] = {
      name,
      path: expandPath(t.path, baseDir),
      test: t.test,
      e2e: typeof t.e2e === "string" ? t.e2e : undefined,
    };
  }

  return {
    model: typeof raw.model === "string" ? raw.model : "claude-opus-5-5",
    effort,
    auth,
    maxBudgetUsdPerStage: num("maxBudgetUsdPerStage", 3),
    maxTurnsPerStage: num("maxTurnsPerStage", 60),
    maxGateRetries: num("maxGateRetries", 2),
    worktreeRoot: expandPath(typeof raw.worktreeRoot === "string" ? raw.worktreeRoot : "~/.shipyard/worktrees", baseDir),
    runsDir: expandPath(typeof raw.runsDir === "string" ? raw.runsDir : ".shipyard/runs", baseDir),
    targets,
  };
}
