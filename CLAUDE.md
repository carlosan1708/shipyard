# shipyard

A local crew of specialist Claude Code and Codex agents that builds features and fixes bugs in other git repos. A deterministic pipeline runs the roles, with test gates, worktree isolation, lane guards and an eval suite. TypeScript on Node 22+, run with `tsx` (no build step).

## Both providers

- Shipyard supports Claude and Codex. Implement shared run features for both providers and verify both paths. Claude remains the default for existing configurations.
- Keep lifecycle, checkpoints, history, worktree isolation, and gates in the shared pipeline. Use provider adapters for authentication, agent sessions, tool permissions, and usage reporting. Document provider limitations when their native capabilities differ.
- Stop, resume, steer, and provider switching are run-scoped. Stop preserves completed commits and work in progress. Steering carries the user's updated instructions forward. Switching keeps the worktree and starts a fresh session with the new provider. Session IDs are provider-specific.
- Archiving hides a finished or stopped run from the dashboard's main list and preserves its history, branch, and worktree. The dashboard’s archive is for Shipyard runs. Confirmed deletion removes saved run history and activity while preserving Git work.

## Layout

- `src/pipeline.ts`: stage order (triage, plan, implement, design, review, revise, security, harden, e2e, repair, docs, release, cloud-release), gates (including triage's must-fail gate), judges, retries, and feedback loops. Optional stages are chosen per run with `crew`. Run kinds are feature, bug and deps. Feedback on a completed result starts a linked revision from the source branch’s latest commit, with the same provider controls and isolation as other runs.
- `src/prompts.ts`: stage prompts and structured outputs, including the orchestrator’s specialist assignments for revisions. The shared pipeline validates the assignments and runs each specialist and its checks in order.
- `src/agent.ts` and `src/codex.ts`: shared `AgentRunner` interface and both provider adapters
- `src/run-control.ts`: interruption and steering for active runs
- `src/review.ts`: terminal checkpoint reviewer (`--checkpoints`); the pipeline only sees the `Checkpoints.review` callback, so other UIs can plug in
- `src/ui/`: `shipyard ui`. `manager.ts` runs pipelines in parallel and owns the inbox (one pending promise per item); `server.ts` is the local HTTP + SSE server (token, Host and Origin checks, fixed static file list); `demo.ts` is the scripted crew for `--demo`
- `src/ui/local-app.ts`: supervises opt-in local app processes from completed worktrees. The read-only `local-app` role runs on demand through the selected provider outside the delivery pipeline and returns a structured launch plan.
- `src/ui/cloud-release.ts`: Cloud Run preflight and approved revision creation. The read-only Google Cloud release role plans the release. The dashboard separately binds approval to the selected service, image digest, Google Cloud CLI account, and run commit.
- `ui/`: the browser app (plain HTML, CSS, JS; no build). All agent text must go through `textContent`, never `innerHTML`; the CSP forbids inline scripts and styles. Agent markdown is rendered by `md()` / `mdInline()` in `ui/app.js`, which build elements and text nodes (only http(s) links become links)
- `src/guards.ts` + `plugins/shipyard/hooks/guard-publish.mjs`: tool-call guards (one implementation shared by both)
- `src/eval.ts`, `evals/tasks/*.json`, `evals/hidden/*.test.js`: eval harness, tasks and hidden graders
- `src/targets.ts`: Add repo support: repo inspection, test/E2E command detection, local repo discovery, and comment-preserving writes to `shipyard.config.yaml`
- `plugins/shipyard/`: the Claude Code plugin; `agents/*.md` are also the pipeline's roles
- `examples/demo-shop/`: zero-dependency demo target and eval fixture

## Commands

- `npm test`: unit and pipeline tests, using `FakeRunner` (no API calls, free)
- `npm run typecheck`
- `npm run eval:validate`: checks every eval task is fair (free)
- `claude plugin validate .` and `claude plugin validate plugins/shipyard`: check the manifests

`npm run shipyard -- ui --demo` shows the UI with scripted agents (free). Starting a real run via the CLI or UI uses the selected provider’s account. Use scripted runners and eval validation for development checks. `auth: subscription` (default) must keep stripping API billing variables from the agent environment (`src/auth.ts`). Runs are capped by `maxBudgetUsdPerRun` (and each agent by `maxBudgetUsdPerStage`); keep that cap enforced in `runStage`.

## Conventions

- Imports use explicit `.ts` extensions.
- Keep the pipeline testable: anything that calls Claude goes through `AgentRunner`.
- A new eval task needs a hidden test and must pass `npm run eval:validate`. Its `request` describes symptoms, never file names.
- Role prompts live only in `plugins/shipyard/agents/*.md`. Do not duplicate them in code.
- A new pipeline role needs: its agent file, a lane in `src/guards.ts` (what it may write), a stage in `runPipeline`, a row in the UI's `CREW` list (`ui/app.js`), demo behaviour in `src/ui/demo.ts`, and tests in `test/crew.test.ts`. Read-only roles use lane `none` with `readOnly: true`.
