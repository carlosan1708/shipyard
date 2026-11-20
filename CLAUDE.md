# shipyard

A local crew of specialist Claude Code agents that builds features and fixes bugs in other git repos. A deterministic pipeline runs the roles, with test gates, worktree isolation, lane guards and an eval suite. TypeScript on Node 22+, run with `tsx` (no build step).

## Layout

- `src/pipeline.ts`: stage order, gates, retries, repair loop (the core)
- `src/agent.ts`: `AgentRunner` interface and the Claude Agent SDK implementation
- `src/guards.ts` + `plugins/shipyard/hooks/guard-publish.mjs`: tool-call guards (one implementation shared by both)
- `src/eval.ts`, `evals/tasks/*.json`, `evals/hidden/*.test.js`: eval harness, tasks and hidden graders
- `plugins/shipyard/`: the Claude Code plugin; `agents/*.md` are also the pipeline's roles
- `examples/demo-shop/`: zero-dependency demo target and eval fixture

## Commands

- `npm test`: unit and pipeline tests, using `FakeRunner` (no API calls, free)
- `npm run typecheck`
- `npm run eval:validate`: checks every eval task is fair (free)
- `claude plugin validate .` and `claude plugin validate plugins/shipyard`: check the manifests

`npm run shipyard -- fix|ship|eval` runs real agents on the user's Claude subscription and uses its usage limits. Do not run them unless asked. `auth: subscription` (default) must keep stripping API billing variables from the agent environment (`src/auth.ts`).

## Conventions

- Imports use explicit `.ts` extensions.
- Keep the pipeline testable: anything that calls Claude goes through `AgentRunner`.
- A new eval task needs a hidden test and must pass `npm run eval:validate`. Its `request` describes symptoms, never file names.
- Role prompts live only in `plugins/shipyard/agents/*.md`. Do not duplicate them in code.
