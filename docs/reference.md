# Shipyard technical reference

[Back to Shipyard](../README.md)

[Providers and usage](#providers-and-usage) · [Targets](#targets) · [Crew](#crew-and-stage-order) · [Checkpoints](#checkpoints) · [Dashboard](#dashboard-controls) · [Commands](#commands) · [Evaluation](#evaluation)

## Providers and usage

| | Claude Code | Codex |
| --- | --- | --- |
| Sign-in | `claude auth login` | `codex login` |
| Per-run selection | `--provider=claude` | `--provider=codex` |
| Model settings | Top-level `model`, `models`, and `effort` | `codex.model`, `codex.models`, and `codex.effort` |
| Usage | Estimated dollar amounts and configurable stage and run caps | Token counts when available and a configurable attempt timeout |
| Inbox | Stage checkpoints, live questions, and tool permissions | Stage checkpoints |

Set `defaultProvider` in [`shipyard.config.yaml`](../shipyard.config.yaml) to choose the initial provider. Claude is the default for existing configurations. Codex uses the CLI defaults for omitted model and effort settings, and `codex.timeoutMsPerAttempt` defaults to 20 minutes.

For Claude, `auth: subscription` uses the saved Claude Code sign-in. Shipyard removes API billing environment variables from the agent process in this mode. Use `auth: api-key` to bill an API account. `maxBudgetUsdPerStage` and `maxBudgetUsdPerRun` limit estimated usage at API prices. The UI budget field and `--budget` override the run limit.

When a Claude run reaches its estimated limit, choose **Increase budget** in that run’s dashboard, enter a new total limit, and select **Approve and resume**. The run continues in its saved worktree. Its accrued usage counts toward the new limit.

Claude and Codex can search the web and read public websites without approval. The `read_public_page` tool reads public text without signing in. For a GitHub target, `read_github_origin` reads branch heads and text files from that run’s configured `origin`, using the host’s `gh` sign-in for private repositories. Git pushes, PR creation, and Cloud Run releases use the dashboard handoff for approval.

Agent shells run with external networking disabled, including shell `git fetch` and package installs. Prepare dependencies ahead of time. Shipyard runs project checks with local networking on macOS and in a private network namespace on Linux. Linux requires bubblewrap for project checks and the Claude sandbox also requires its platform dependencies. Process-backed dashboard previews use the macOS sandbox. Static previews are available on Linux.

macOS project checks that honor `CHROME_PATH` can use Shipyard’s launcher for an installed Chrome or Chromium. The launcher runs the browser with the gate’s existing Seatbelt profile because macOS rejects Chrome’s nested sandbox. An explicit host `CHROME_PATH` takes precedence.

## Targets

The dashboard's **New run → Add repo** flow checks that the folder is a Git repository with commits and suggests non-interactive test commands. You can also register a target in the YAML file:

```yaml
targets:
  my-api:
    path: ~/code/my-api
    test: npm test
    e2e: npm run test:e2e
```

Shipyard starts from the target's committed `HEAD`, so pending changes in the original checkout stay there. After a run, inspect the resulting `shipyard/<run-id>` branch or the diff in the dashboard. The worktree path and branch are recorded with the run.

Search and filter the run list by repository and status. Each run shows the local repository path Shipyard recorded for it.

## Crew and stage order

| Stage | Role | Edit scope | Outcome |
| --- | --- | --- | --- |
| Triage | Bug triager | Tests | Proves the bug with an expected failing test. |
| Plan | Planner | Read-only | Produces a plan for the implementer. |
| Implement | Backend, frontend, or dependency updater | Worktree | Unit tests pass. |
| Review → revise | Reviewer, then implementer if needed | Read-only review, then worktree edits | Blocking findings get a revision and another unit gate. |
| Security → harden | Security auditor, then implementer if needed | Read-only audit, then worktree edits | Critical or high findings get a repair and another unit gate. |
| E2E → repair | E2E tester, then implementer if needed | Tests for E2E. Repair excludes E2E tests. | End-to-end checks pass. |
| Docs | Docs writer | Documentation | Updates user-facing docs where needed. |
| Release | Release manager | Version files, lockfiles, and release notes | Prepares the release files and runs the unit gate. |
| Cloud release | Google Cloud release specialist | Read-only | Reviews the build, target, permissions, and verification plan for a Google Cloud release. |

Implementation always runs. The CLI's default optional crew is E2E and repair, which need a configured E2E command. Triage applies to bug fixes. Dependency runs use the dependency updater and skip planning and triage. Choose optional stages with `--crew` or the dashboard's **Crew** table.

## Checkpoints

Use `--checkpoints` to pause at every stage or list the stages you want, such as `--checkpoints=plan,implement`. The terminal and dashboard show the attempt summary, diff, and gate outcomes.

- **Approve** continues from a passing stage.
- **Feedback** sends instructions to the same agent session when available and reruns the gates.
- **Stop** ends the run and keeps the branch and worktree.

When a retry limit is reached at a checkpoint, you can give feedback to try again. E2E failures can go to the implementer for repair. The dashboard also lets you steer or switch providers during an active attempt. Resume keeps completed stages and the original worktree. Shipyard continues the unfinished stage using the saved agent session when available. Older records with no checkpoint configuration ask for review at the remaining stages.

## Dashboard controls

| Control | Effect |
| --- | --- |
| **Stop run** | Interrupt the current agent, test command, or inbox wait and keep the worktree. |
| **Resume run** | Continue a stopped or interrupted run from its unfinished stage in the original worktree. |
| **Steer** | Interrupt the current attempt and continue with your instructions. |
| **Switch provider** | Start a fresh session with the other provider on the same worktree. |
| **Archive run** | Move an inactive run into **Archived**. Its history stays available for review or restoration. |
| **Delete run** | Permanently remove an inactive run’s saved history after confirmation. Its Git branch and worktree stay available. |

Finished runs appear under **Run results** in the inbox. Open a result to see the final check outcomes, local branch, and PR handoff. For completed static sites with an `index.html` at the worktree root, use **Start local preview** to view the app directly from the dashboard.

Choose **Run locally** from the handoff to let a dedicated subagent on the run’s provider find the app in its completed worktree. Shipyard supports Streamlit, Vite, Next.js, and static sites. Dynamic apps use installed dependencies and get a loopback URL. Open it with **Open local app**, and use **Stop local app** when done. The app also stops when the dashboard shuts down.

Use **Open local preview** to see the static site. **Run browser check** verifies it in background Chrome or Chromium at desktop and phone widths, checking JavaScript errors, failed local assets, and horizontal overflow. Set `browserCheck: true` on a static target in `shipyard.config.yaml` to run the check automatically as part of the pipeline. The check runs separately from the Claude or Codex agent sandbox.

The **Run handoff** lists changes, specialist reports, recorded verification and pending items. Choose **Allow local browser access** on a run or revision to let either provider inspect screenshots and activate local controls in an isolated browser. `browserAccess: true` sets the target default, and `--browser` or `--no-browser` overrides it in the CLI. Include GitHub or LinkedIn URLs in the run request or use `--reference=<url>` in the CLI to pass public source material to the crew. Shipyard logs permission gaps, public access failures, and sign-in requirements in the run. It uses a separate connection with no account cookies or tokens.

Use **Ask about this run** for deployment, GitHub, checks, changed files, or next steps. From a completed run with a linked, merged PR, choose **Start deployment** or enter a follow-up such as “I merged the PR. Deploy to AWS.” Shipyard creates a separate deployment run and puts the approval in **Needs you**. If multiple providers are available, choose one in the dashboard. Open the deployment run to approve the release or view its outcome.

### AWS and Azure deployments

Set the workflow filename and GitHub Actions environment under the repository’s entry in `shipyard.config.yaml`. The workflow and environment must exist on GitHub. You can configure either or both providers.

```yaml
targets:
  example:
    path: ~/Documents/GitHub/example
    test: npm test
    deployments:
      aws:
        workflow: deploy-aws.yml
        environment: aws-production
      azure:
        workflow: deploy-azure.yml
        environment: azure-production
```

The workflow must accept these inputs and guard every job against a moved branch. The deployment job uses the selected environment. Add the repository’s build, verification, and deployment steps to that workflow.

```yaml
on:
  workflow_dispatch:
    inputs:
      commit_sha:
        required: true
        type: string
      environment:
        required: true
        type: environment
jobs:
  deploy:
    if: ${{ github.sha == inputs.commit_sha }}
    environment: ${{ inputs.environment }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ inputs.commit_sha }}
      # Add this repository’s verification and deployment steps here.
```

Shipyard uses the local GitHub CLI session to review and dispatch the workflow. The review shows the repository, branch, commit, workflow, and environment. Keep cloud credentials and environment protections in GitHub Actions. **Approve and deploy** sends one workflow dispatch, and Shipyard tracks the returned Actions run across restarts. A successful run means the workflow reported success. Include a live verification step in the workflow if the release should depend on it. [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10) · [Cloud authentication with OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers)

### Firebase Hosting deployments

For a supported static Firebase site, Shipyard verifies the GitHub default-branch commit, checks the signed-in Firebase account and site, and runs the configured project checks before approval. **Check live deployment** compares supported Firebase Hosting files or shows a recorded Cloud Run revision and its traffic status at creation.

In a finished result, **Run project checks** records the configured unit and end-to-end checks against the current run branch. Under **Pull request**, choose **Connect Git remote** to save the clone URL of an existing repository as `origin`. **Create draft PR** lets you review the GitHub destination, base, branch, and editable Markdown description before approving the push and draft together. If the histories are unrelated, Shipyard applies the run’s changes to GitHub’s default branch in a separate worktree. The review lists overlapping files whose run versions will be used. Shipyard reruns the configured checks before publishing that branch. **Push branch** is also available for publishing just the branch. Shipyard uses the local GitHub CLI account (`gh auth login`) to create or find the PR. **Open PR on GitHub** opens the saved URL. Choose **Reopen PR** to review and update the description of a closed, unmerged PR on the run branch before reopening the same PR.

### Google Cloud releases

Enable **Google Cloud release** in the dashboard crew or add `cloud-release` to `--crew`. The specialist prepares a read-only release plan for either provider. Review it in the handoff of a completed run.

Choose **Review Cloud Run release** and supply the project ID, region, an existing single-container service, and an Artifact Registry image pinned by SHA-256 digest. Build the image separately and verify that its digest corresponds to the intended release. Shipyard checks service read access with the active Google Cloud CLI account, then shows the account, runtime identity, target, image, and revision for approval.

The deploying account typically needs Cloud Run Developer, Service Account User on the service’s runtime identity, and Artifact Registry Reader on the image repository. Sign in with `gcloud auth login` and use a configuration with the intended account. After **Approve and create revision**, Shipyard updates the existing service with `--no-traffic` and records the ready revision after checking its traffic. Rollouts and rollbacks are managed separately in Cloud Run. [Cloud Run deployment permissions](https://docs.cloud.google.com/run/docs/deploying#required-roles) · [Cloud Run service update options](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update)

Agent feedback and checkpoint answers apply to code revisions. Shipyard deployment actions require dedicated dashboard approval. Firebase deployment supports one existing static site with an explicit ID and project. Sites that use build hooks, multiple Hosting configurations, or service rewrites can use their existing release workflow. Git pushes and pull requests can trigger automation on the destination, including deployments.

Shipyard reads public GitHub and LinkedIn links in requests automatically. When a public check returns blocked or partial access and browser help is enabled, **Needs you** offers **Continue in Codex** or **Continue in Claude** for an interactive session. Send the prefilled task in the desktop app and review its browser prompts there. In an existing interactive session with the appropriate tools, use **Copy task**. Shipyard’s Codex skill and Claude plugin both describe the handoff.

The interactive session returns draft notes and coverage to the dashboard. Select **Use reviewed text** to share your edited notes with the crew. You can answer requests in any order, and the crew starts once all pending reference requests are answered. **Cancel handoff** revokes the return code for that link. You can stop the browser task in its provider session. A return code expires after two hours or when the dashboard restarts, and a provider switch creates a fresh handoff. You can also paste notes into the review form.

Attach files and images when you start a run, send feedback, steer or switch an active run, answer an inbox question or permission prompt, or share reviewed reference notes. Each submission supports up to six files, 3 MB each and 8 MB total. Shipyard saves attachments with run history outside the Git worktree. Files sent with an inbox question or permission answer are available to the agent that asked.

From a completed result, choose **Request code changes** and select Claude or Codex. Include GitHub and LinkedIn URLs directly in the feedback. Shipyard reads what it can through public access and puts browser handoffs in **Needs you** before the revision starts. The run handoff keeps incomplete or blocked references visible under **Pending**, with a browser retry for approved links. The revision can reuse reviewed notes from the completed run. Shipyard bases the revision on that branch’s latest commit. A read-only orchestrator assigns work to the specialists it needs, and the dashboard shows each assignment in order. Shipyard runs the project’s configured checks after each specialist.

**BE-FE** implements features and bug fixes started from the dashboard. Add the **UI/UX specialist** to refine the interface after implementation. From the CLI, add `design` to `--crew` or use `--implementer=ui-ux` for design-led work.

The dashboard listens on loopback. Reopen it with `npm run shipyard -- ui-link` from your terminal and use the private link it returns. On macOS, the Codex skill checks that the dashboard is serving authenticated requests before and after opening it.

## Commands

Run these using `npm run shipyard -- <command>` from the checkout. Use `npm link` from the checkout for the global `shipyard` command.

| Command | Purpose |
| --- | --- |
| `ship <target> "<request>"` | Implement a feature. |
| `fix <target> "<report>"` | Fix a bug and check the regression. |
| `deps <target> ["<notes>"]` | Review and update dependencies. |
| `ui [--demo] [--port <port>] [--no-open] [--new-token]` | Start the local dashboard. |
| `ui-link` | Print the running dashboard's private link. |
| `demo-init` | Create the bundled sample app as a local target repository. |
| `targets`, `roles`, `runs [--limit <n>]` | Inspect targets, roles, or recent runs. |
| `eval [--provider=<name>] [--task <id>]...` | Run the evaluation suite with the chosen provider. |
| `eval --validate` | Check the eval fixtures without starting agents. |

Use `--provider=claude` or `--provider=codex` on `ship`, `fix`, `deps`, or `eval`. For coding runs, `--model` and `--effort` select provider options, `--implementer=frontend` selects the frontend role, and `--budget` sets Claude's estimated run cap. See [CLI help](../src/cli.ts) for the full list of stage names.

After signing in to Codex, you can try a live run against the bundled sample app.

```sh
npm run demo:init
npm run shipyard -- ship demo-shop "Add a GET /health endpoint" --provider=codex
```

## Codex skill

From the Shipyard checkout, use `$shipyard start UI`, `$shipyard start demo UI`, or `$shipyard ship a health endpoint on demo-shop`.

To make the skill available from other repositories, run these commands from the Shipyard checkout:

```sh
mkdir -p ~/.agents/skills
ln -s "$(pwd)/.agents/skills/shipyard" ~/.agents/skills/shipyard
npm link
```

The skill uses the registered names shown by `shipyard targets`. Use the dashboard for interactive approvals. On macOS, the skill reuses a dashboard built from the current checkout in the requested mode or starts a GUI LaunchAgent for that version. It verifies the authenticated page before and after opening the browser. A server serves the UI assets it loaded at startup.

## Claude Code plugin

From the Shipyard checkout, register and install the local plugin:

```sh
claude plugin marketplace add "$PWD"
claude plugin install shipyard@shipyard
```

The plugin provides `/shipyard:ship` and `/shipyard:fix-bug`. Its publish hook blocks pushes, publishes, and pull request creation unless the Claude session was explicitly started with `SHIPYARD_ALLOW_PUBLISH=1`.

## Evaluation

The suite uses seven tasks against the bundled shop, covering five bugs and two features. Each task starts from a fresh Git repository. After the run, a hidden test grades the branch. Reports under `evals/results/` contain solve rate, timing, and the selected provider's available usage figures.

Use `npm run eval:validate` to check the seed and reference changes. A real `eval` run uses the selected provider account.

## Implementation map

| Area | Where to look |
| --- | --- |
| Pipeline, gates and retries | [`src/pipeline.ts`](../src/pipeline.ts) |
| Agent adapters | [Claude](../src/agent.ts) and [Codex](../src/codex.ts) |
| Roles and tool guards | [Role definitions](../plugins/shipyard/agents), [lane checks](../src/guards.ts), and [publish hook](../plugins/shipyard/hooks/guard-publish.mjs) |
| Dashboard and run control | [`ui/`](../ui), [`src/ui/`](../src/ui), and [`src/run-control.ts`](../src/run-control.ts) |
| Run data | [`src/store.ts`](../src/store.ts), which stores `run.json` and `events.jsonl` per run |
| Evaluation tasks | [`evals/`](../evals) and [`src/eval.ts`](../src/eval.ts) |

The dashboard binds to `127.0.0.1`, authenticates with a token and a strict cookie, and checks Host and Origin on requests. It uses a content security policy and renders agent text without inserting untrusted HTML.

## Roadmap

- [ ] Add a frontend sample target with Playwright checks.
- [ ] Bootstrap new application repositories from templates.
- [ ] Support parallel frontend and backend work when a plan can split the task.
