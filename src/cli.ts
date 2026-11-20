import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeAgentRunner } from "./agent.ts";
import { ignoredBillingVars } from "./auth.ts";
import { SHIPYARD_ROOT, loadConfig, type ShipyardConfig } from "./config.ts";
import { DEMO_APP_DIR, formatReport, loadTasks, runEval, validateTask } from "./eval.ts";
import { runPipeline, type PipelineDeps } from "./pipeline.ts";
import { loadRoles } from "./roles.ts";
import { RunStore, type RunKind } from "./store.ts";
import { initRepoWithCommit } from "./worktree.ts";

const HELP = `shipyard: a local crew of specialist Claude Code agents that build and repair your apps

Usage:
  shipyard fix  <target> "<bug report>"       reproduce with a failing test, fix, add E2E coverage
  shipyard ship <target> "<feature request>"  implement with unit tests, verify end to end
  shipyard eval [--task <id>]... [--validate] run the eval suite (--validate checks tasks, no agents, free)
  shipyard runs [--limit <n>]                  list recent runs
  shipyard roles                               list agent roles
  shipyard demo-init                           create the demo-shop target repo

Targets are defined in shipyard.config.yaml. By default agents run on your Claude Code sign-in
(your Pro/Max subscription) and count against its usage limits. Dollar figures are the SDK's
estimate at API prices; each stage stops at maxBudgetUsdPerStage of estimated cost.`;

function runHeader(config: ShipyardConfig): string {
  const auth = config.auth === "subscription" ? "subscription (Claude Code sign-in)" : "API key (billed per token)";
  const lines = [`model ${config.model} · effort ${config.effort} · auth ${auth} · stage cap ~$${config.maxBudgetUsdPerStage} est.`];
  const ignored = config.auth === "subscription" ? ignoredBillingVars(process.env) : [];
  if (ignored.length) lines.push(`note: ignoring ${ignored.join(", ")} so runs stay on your subscription (set auth: api-key to use them)`);
  return lines.join("\n");
}

function deps(config: ShipyardConfig): PipelineDeps {
  return {
    config,
    runner: new ClaudeAgentRunner({
      model: config.model,
      effort: config.effort,
      maxBudgetUsd: config.maxBudgetUsdPerStage,
      maxTurns: config.maxTurnsPerStage,
      auth: config.auth,
    }),
    store: new RunStore(config.runsDir),
    roles: loadRoles(),
    log: (line) => console.log(line),
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const config = loadConfig();

  switch (command) {
    case "fix":
    case "ship": {
      const [targetName, ...words] = rest;
      const request = words.join(" ").trim();
      if (!targetName || !request) {
        console.error(`Usage: shipyard ${command} <target> "<${command === "fix" ? "bug report" : "feature request"}>"`);
        return 2;
      }
      const target = config.targets[targetName];
      if (!target) {
        console.error(`Unknown target "${targetName}". Known: ${Object.keys(config.targets).join(", ") || "(none)"}`);
        return 2;
      }
      if (!existsSync(target.path)) {
        console.error(`Target path does not exist: ${target.path}${targetName === "demo-shop" ? "\nRun `npm run demo:init` first." : ""}`);
        return 2;
      }
      const kind: RunKind = command === "fix" ? "bug" : "feature";
      console.log(runHeader(config));
      const run = await runPipeline({ target, kind, request }, deps(config));
      if (run.status === "error") {
        console.error(`\nThe run could not complete: ${run.error}`);
        if (/authenticat|oauth|log ?in|credential|api key/i.test(run.error ?? "")) {
          console.error("Sign in to Claude Code again with `claude auth login`, check `claude auth status`, and retry.");
        }
      }
      if (!run.cleanedUp) console.log(`\nReview the branch:  git -C ${run.repo} log --oneline ${run.baseSha.slice(0, 8)}..${run.branch}`);
      console.log(`Run record:         ${join(config.runsDir, run.id, "run.json")}`);
      return run.status === "passed" ? 0 : 1;
    }

    case "eval": {
      const { values } = parseArgs({
        args: rest,
        options: { task: { type: "string", multiple: true }, validate: { type: "boolean", default: false } },
      });
      let tasks = loadTasks();
      if (values.task?.length) {
        const wanted = new Set(values.task);
        tasks = tasks.filter((t) => wanted.has(t.id));
        const missing = [...wanted].filter((id) => !tasks.some((t) => t.id === id));
        if (missing.length) {
          console.error(`Unknown task(s): ${missing.join(", ")}`);
          return 2;
        }
      }
      if (values.validate) {
        let bad = 0;
        for (const task of tasks) {
          const problems = await validateTask(task);
          console.log(`${problems.length ? "✗" : "✓"} ${task.id}${problems.map((p) => `\n    - ${p}`).join("")}`);
          if (problems.length) bad++;
        }
        console.log(`\n${tasks.length - bad}/${tasks.length} tasks valid`);
        return bad ? 1 : 0;
      }
      console.log(`Running ${tasks.length} eval task(s)\n${runHeader(config)}`);
      const report = await runEval(tasks, deps(config));
      console.log(`\n${formatReport(report)}`);
      return 0;
    }

    case "runs": {
      const { values } = parseArgs({ args: rest, options: { limit: { type: "string", default: "20" } } });
      const runs = new RunStore(config.runsDir).list().slice(0, Number(values.limit));
      if (!runs.length) console.log("No runs yet.");
      for (const r of runs) {
        const stages = r.stages.map((s) => `${s.name}${s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : "…"}`).join(" ");
        console.log(`${r.status.padEnd(7)} ~$${r.totals.costUsd.toFixed(2).padStart(5)}  ${r.id}  [${r.target}] ${stages}`);
      }
      return 0;
    }

    case "roles": {
      for (const role of loadRoles().values()) {
        console.log(`${role.name}  (${role.tools.join(", ")})\n  ${role.description}\n`);
      }
      return 0;
    }

    case "demo-init": {
      const dest = config.targets["demo-shop"]?.path ?? join(SHIPYARD_ROOT, ".shipyard", "targets", "demo-shop");
      if (existsSync(dest)) {
        console.log(`demo-shop target already exists at ${dest}`);
        return 0;
      }
      mkdirSync(dest, { recursive: true });
      cpSync(DEMO_APP_DIR, dest, { recursive: true });
      await initRepoWithCommit(dest);
      console.log(`Created demo-shop target repo at ${dest}\nTry: npm run shipyard -- ship demo-shop "Add a GET /health endpoint that returns {\\"status\\": \\"ok\\"}"`);
      return 0;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
