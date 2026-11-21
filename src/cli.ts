import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { ClaudeAgentRunner, type AgentRunner } from "./agent.ts";
import { CodexAgentRunner } from "./codex.ts";
import { DemoRunner } from "./ui/demo.ts";
import { RunManager } from "./ui/manager.ts";
import { loadOrCreateToken, startUiServer } from "./ui/server.ts";
import { clearSession, readLiveSessions, TOKEN_FILE, writeSession } from "./ui/session.ts";
import { ignoredBillingVars } from "./auth.ts";
import { SHIPYARD_ROOT, loadConfig, providerOptions, resolveProvider, validateRunOptions, type Provider, type RunEffort, type ShipyardConfig } from "./config.ts";
import { DEMO_APP_DIR, formatReport, loadTasks, runEval, validateTask } from "./eval.ts";
import { DEFAULT_DEPS_REQUEST } from "./prompts.ts";
import {
  IMPLEMENTERS,
  OPTIONAL_STAGES,
  runPipeline,
  STAGES,
  type Implementer,
  type OptionalStage,
  type PipelineDeps,
  type StageName,
} from "./pipeline.ts";
import { terminalReviewer } from "./review.ts";
import { loadRoles } from "./roles.ts";
import { RunStore, type RunKind } from "./store.ts";
import { initRepoWithCommit } from "./worktree.ts";

const HELP = `shipyard: a local crew of specialist coding agents that build and repair your apps

Usage:
  shipyard fix  <target> "<bug report>"       reproduce with a failing test, fix, add E2E coverage
  shipyard ship <target> "<feature request>"  implement with unit tests, verify end to end
  shipyard deps <target> ["<notes>"]          update dependencies safely (patch/minor by default) and verify
  shipyard eval [--provider=claude|codex] [--task <id>]... [--validate] run the eval suite (--validate checks tasks, no agents, free)
  shipyard runs [--limit <n>]                  list recent runs
  shipyard roles                               list agent roles
  shipyard targets                             list configured target repositories
  shipyard demo-init                           create the demo-shop target repo
  shipyard ui [--port 4710] [--no-open] [--demo] [--new-token]
                                               open the web UI: start runs, watch every agent, answer
                                               checkpoints, questions and permission requests in parallel
                                               (--demo: scripted agents, no provider usage)
  shipyard ui-link                             print the link of the running UI again

Options for fix, ship and deps:
  --checkpoints                 pause after every stage so you can approve, give feedback or stop
  --checkpoints=plan,implement  pause only after the named stages
                                (triage, plan, implement, design, review, revise, security, harden,
                                e2e, repair, docs, release)
  --crew=triage,plan,design,review,security,e2e,repair,docs,release
                                the optional agents that run (default: e2e,repair; implement always runs;
                                triage applies to fix; plan and design don't apply to deps)
  --implementer=ui-ux           who implements: backend (default), frontend, or ui-ux
  --provider=claude|codex       provider for the whole run (defaults to defaultProvider or Claude)
  --browser / --no-browser      allow or disable the local preview browser tool for this run
  --reference=<url>             allow one public GitHub or LinkedIn reference (repeatable)
  --model=<name>                model for the selected provider (from the config)
  --effort=medium               reasoning effort for the selected provider
  --budget=10                   estimated dollar limit for Claude runs

Targets are defined in shipyard.config.yaml. By default agents run on your Claude Code sign-in
(your Pro/Max subscription) and count against its usage limits. Dollar figures are the SDK's
estimate at API prices. A run stops before it goes over maxBudgetUsdPerRun (or --budget),
and each Claude agent stops at maxBudgetUsdPerStage. Codex uses your saved CLI sign-in and reports tokens.`;

function runHeader(config: ShipyardConfig, provider: Provider, overrides: { model?: string; effort?: RunEffort } = {}): string {
  const defaults = providerOptions(config, provider);
  const model = overrides.model ?? defaults.model ?? "Codex CLI default";
  const effort = overrides.effort ?? defaults.effort ?? "CLI default";
  if (provider === "codex") return `Codex · model ${model} · effort ${effort} · saved CLI sign-in · dollar cost unavailable`;
  const auth = config.auth === "subscription" ? "subscription (Claude Code sign-in)" : "API key (billed per token)";
  const lines = [
    `Claude · model ${model} · effort ${effort} · auth ${auth} · run cap ~$${config.maxBudgetUsdPerRun} · stage cap ~$${config.maxBudgetUsdPerStage} est.`,
  ];
  const ignored = config.auth === "subscription" ? ignoredBillingVars(process.env) : [];
  if (ignored.length) lines.push(`note: ignoring ${ignored.join(", ")} so runs stay on your subscription (set auth: api-key to use them)`);
  return lines.join("\n");
}

function deps(config: ShipyardConfig, runner: AgentRunner): PipelineDeps {
  return { config, runner, store: new RunStore(config.runsDir), roles: loadRoles(), log: (line) => console.log(line) };
}

function claudeRunner(config: ShipyardConfig): AgentRunner {
  return new ClaudeAgentRunner({
    model: config.model,
    effort: config.effort,
    maxBudgetUsd: config.maxBudgetUsdPerStage,
    maxTurns: config.maxTurnsPerStage,
    auth: config.auth,
    askTools: config.askTools,
  });
}

function makeRunner(config: ShipyardConfig, provider: Provider): AgentRunner {
  return provider === "codex" ? new CodexAgentRunner(config.codex?.timeoutMsPerAttempt) : claudeRunner(config);
}

function stopCodexOnExit(runner: AgentRunner): void {
  if (!(runner instanceof CodexAgentRunner)) return;
  process.once("exit", () => runner.stop());
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => process.exit(code));
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const config = loadConfig();

  switch (command) {
    case "fix":
    case "ship":
    case "deps": {
      const flags = rest.filter((a) => a.startsWith("--"));
      const [targetName, ...words] = rest.filter((a) => !a.startsWith("--"));
      const request = words.join(" ").trim() || (command === "deps" ? DEFAULT_DEPS_REQUEST : "");
      let checkpointStages: StageName[] | undefined;
      let model: string | undefined;
      let effort: RunEffort | undefined;
      let providerFlag: string | undefined;
      let crew: OptionalStage[] | undefined;
      let implementer: Implementer | undefined;
      let budgetUsd: number | undefined;
      let browserAccess: boolean | undefined;
      const referenceUrls: string[] = [];
      for (const flag of flags) {
        if (flag === "--checkpoints") checkpointStages = [...STAGES];
        else if (flag.startsWith("--checkpoints=")) {
          const names = flag.slice("--checkpoints=".length).split(",").map((s) => s.trim()).filter(Boolean);
          const unknown = names.filter((n) => !(STAGES as readonly string[]).includes(n));
          if (unknown.length || names.length === 0) {
            console.error(`--checkpoints takes stage names from: ${STAGES.join(", ")}`);
            return 2;
          }
          checkpointStages = names as StageName[];
        } else if (flag.startsWith("--provider=")) {
          providerFlag = flag.slice("--provider=".length);
        } else if (flag === "--browser" || flag === "--no-browser") {
          browserAccess = flag === "--browser";
        } else if (flag.startsWith("--reference=")) {
          referenceUrls.push(flag.slice("--reference=".length));
        } else if (flag.startsWith("--model=")) {
          model = flag.slice("--model=".length);
        } else if (flag.startsWith("--effort=")) {
          effort = flag.slice("--effort=".length) as RunEffort;
        } else if (flag.startsWith("--crew=")) {
          crew = flag.slice("--crew=".length).split(",").map((s) => s.trim()).filter(Boolean) as OptionalStage[];
          if (crew.some((s) => !(OPTIONAL_STAGES as readonly string[]).includes(s))) {
            console.error(`--crew takes: ${OPTIONAL_STAGES.join(", ")} (implement always runs; --crew= alone runs implement only)`);
            return 2;
          }
        } else if (flag.startsWith("--budget=")) {
          budgetUsd = Number(flag.slice("--budget=".length).replace(/^\$/, ""));
        } else if (flag.startsWith("--implementer=")) {
          implementer = flag.slice("--implementer=".length) as Implementer;
          if (!(IMPLEMENTERS as readonly string[]).includes(implementer)) {
            console.error(`--implementer takes: ${IMPLEMENTERS.join(", ")}`);
            return 2;
          }
        } else {
          console.error(`Unknown option ${flag}`);
          return 2;
        }
      }
      let provider: Provider;
      try {
        provider = resolveProvider(providerFlag ?? config.defaultProvider);
        validateRunOptions(config, provider, { model, effort, budgetUsd });
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
      if (!targetName || !request) {
        const what = command === "fix" ? '"<bug report>"' : command === "deps" ? '["<notes>"]' : '"<feature request>"';
        console.error(`Usage: shipyard ${command} <target> ${what}`);
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
      const kind: RunKind = command === "fix" ? "bug" : command === "deps" ? "deps" : "feature";
      console.log(runHeader(config, provider, { model, effort }));
      const runner = makeRunner(config, provider);
      stopCodexOnExit(runner);
      const pipelineDeps = deps(config, runner);
      if (checkpointStages) pipelineDeps.checkpoints = { stages: checkpointStages, review: terminalReviewer() };
      const run = await runPipeline({ target, kind, request, provider, model, effort, crew, implementer, budgetUsd, browserAccess, referenceUrls }, pipelineDeps);
      if (run.status === "stopped") {
        console.log(`\nStopped. The worktree is kept as it was, uncommitted work included: ${run.worktree}`);
      }
      if (run.status === "error") {
        console.error(`\nThe run could not complete: ${run.error}`);
        if (provider === "claude" && /authenticat|oauth|log ?in|credential|api key/i.test(run.error ?? "")) {
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
        options: { task: { type: "string", multiple: true }, validate: { type: "boolean", default: false }, provider: { type: "string" } },
      });
      let provider: Provider;
      try {
        provider = resolveProvider(values.provider ?? config.defaultProvider);
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
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
      console.log(`Running ${tasks.length} eval task(s)\n${runHeader(config, provider)}`);
      const runner = makeRunner(config, provider);
      stopCodexOnExit(runner);
      const report = await runEval(tasks, deps(config, runner), provider);
      console.log(`\n${formatReport(report)}`);
      return 0;
    }

    case "runs": {
      const { values } = parseArgs({ args: rest, options: { limit: { type: "string", default: "20" } } });
      const runs = new RunStore(config.runsDir).list().slice(0, Number(values.limit));
      if (!runs.length) console.log("No runs yet.");
      for (const r of runs) {
        const stages = r.stages.map((s) => `${s.name}${s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : "…"}`).join(" ");
        const spend = r.totals.costUsd === null
          ? `cost unavailable${r.totals.usage ? ` · ${r.totals.usage.inputTokens} input / ${r.totals.usage.outputTokens} output tokens` : ""}`
          : `~$${r.totals.costUsd.toFixed(2)} est.`;
        console.log(`${r.status.padEnd(7)} ${r.provider} · ${spend} · ${r.id}  [${r.target}] ${stages}`);
      }
      return 0;
    }

    case "targets": {
      for (const target of Object.values(config.targets)) console.log(`${target.name}\t${target.path}`);
      return 0;
    }

    case "roles": {
      for (const role of loadRoles().values()) {
        console.log(`${role.name}  (${role.tools.join(", ")})\n  ${role.description}\n`);
      }
      return 0;
    }

    case "demo-init": {
      const dest = demoTargetPath(config);
      if (existsSync(dest)) {
        console.log(`demo-shop target already exists at ${dest}`);
        return 0;
      }
      await ensureDemoTarget(dest);
      console.log(`Created demo-shop target repo at ${dest}\nTry: npm run shipyard -- ship demo-shop "Add a GET /health endpoint that returns {\\"status\\": \\"ok\\"}"`);
      return 0;
    }

    case "ui": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string", default: "4710" },
          "no-open": { type: "boolean", default: false },
          "quiet-link": { type: "boolean", default: false },
          demo: { type: "boolean", default: false },
          "new-token": { type: "boolean", default: false },
        },
      });
      let uiConfig = config;
      let runner = claudeRunner(config);
      const codexRunner = new CodexAgentRunner(config.codex?.timeoutMsPerAttempt);
      process.once("exit", () => codexRunner.stop());
      if (values.demo) {
        // Scripted agents on a private demo-shop copy, with their own run history: shows the whole UI
        // without using your subscription or mixing into your real runs.
        const path = join(SHIPYARD_ROOT, ".shipyard", "targets", "demo-shop");
        await ensureDemoTarget(path);
        uiConfig = {
          ...config,
          defaultProvider: "claude",
          runsDir: join(SHIPYARD_ROOT, ".shipyard", "demo-runs"),
          targets: { "demo-shop": { name: "demo-shop", path, test: "npm test", e2e: "npm run e2e" } },
        };
        runner = new DemoRunner();
      }
      const manager = new RunManager({
        config: uiConfig,
        roles: loadRoles(),
        runner,
        codexRunner: values.demo ? undefined : codexRunner,
        log: (line) => console.log(line),
        // Repos added in the UI are saved here; demo mode keeps its private target list.
        configFile: values.demo ? undefined : join(SHIPYARD_ROOT, "shipyard.config.yaml"),
      });
      const token = loadOrCreateToken(TOKEN_FILE, values["new-token"]);
      const server = await startUiServer({ manager, config: uiConfig, port: Number(values.port), demo: values.demo, token });
      writeSession({ port: server.port, pid: process.pid, demo: values.demo, startedAt: new Date().toISOString() });
      console.log(`shipyard ui${values.demo ? " (demo mode: scripted agents, no provider usage)" : ""}`);
      if (!values.demo) console.log(runHeader(uiConfig, uiConfig.defaultProvider ?? "claude"));
      if (values["quiet-link"]) console.log(`Dashboard listening on 127.0.0.1:${server.port}`);
      else console.log(`\nOpen: ${server.url}\n(The link carries a private token, kept across restarts; --new-token makes a new one. Keep this terminal open: Ctrl-C stops the UI and any running agents.)\n`);
      if (!values["no-open"]) openBrowser(server.url);
      return new Promise<number>((resolve) => {
        let closing = false;
        const stop = async () => {
          if (closing) return;
          closing = true;
          console.log("\nStopping shipyard ui...");
          clearSession(server.port, process.pid);
          await Promise.all([manager.shutdown(), server.close()]);
          codexRunner.stop();
          resolve(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        process.once("SIGHUP", stop); // the terminal window was closed
      });
    }

    case "ui-link": {
      const sessions = readLiveSessions();
      if (!sessions.length || !existsSync(TOKEN_FILE)) {
        console.error("No shipyard ui is running from this folder. Start it with: npm run shipyard -- ui");
        return 1;
      }
      const token = readFileSync(TOKEN_FILE, "utf8").trim();
      for (const s of sessions) console.log(`http://127.0.0.1:${s.port}/?token=${token}${s.demo ? "   (demo mode)" : ""}`);
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

function demoTargetPath(config: ShipyardConfig): string {
  return config.targets["demo-shop"]?.path ?? join(SHIPYARD_ROOT, ".shipyard", "targets", "demo-shop");
}

async function ensureDemoTarget(dest: string): Promise<void> {
  if (existsSync(dest)) return;
  mkdirSync(dest, { recursive: true });
  cpSync(DEMO_APP_DIR, dest, { recursive: true });
  await initRepoWithCommit(dest);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser opener: the printed link still works.
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
