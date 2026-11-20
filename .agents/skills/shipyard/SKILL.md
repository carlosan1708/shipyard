---
name: shipyard
description: Open the Shipyard web UI or start, inspect, and manage Shipyard fleet runs for features, bug fixes, and dependency updates. Use when the user invokes $shipyard.
---

Use the installed `shipyard` CLI. If it is unavailable and the Shipyard checkout is known, run `npm run shipyard --` from its root.

## Open the dashboard

For `$shipyard start UI` or an equivalent request, use `shipyard ui-link` to find a running dashboard. Match the requested mode. The standard dashboard has no demo label. Open the matching private link in the user's browser. If none exists, start `shipyard ui --no-open --port 0` in a terminal or process that can stay running after the chat turn. Add `--demo` when requested. Wait for `shipyard ui-link` to return the new link, then open it in the browser and leave the server running. Keep the token out of chat. A dashboard request ends when the page is open. Start a fleet run only when the user asks for one.

## Run the fleet

- Run `shipyard targets` to match the current Git repository or the requested target to a configured name. Confirm the target only when the request and repository information leave it ambiguous.
- Use `shipyard ship` for features, `shipyard fix` for bugs, and `shipyard deps` for dependency updates. Pass the target and the request as separate arguments. Include `--provider=codex` unless the user explicitly chooses Claude. Shipyard starts from the target's committed HEAD and makes local commits on a separate `shipyard/<run-id>` branch.
- For unattended runs, wait for the CLI result and report the branch, run record, and gate results. For interactive stage approvals, open the dashboard using the steps above. Use the New Run form with the selected provider and requested checkpoints, and leave approval and feedback to the user in the inbox. Continue monitoring when the user asks you to follow the run to completion.
- Review the resulting worktree or branch if needed. Merging, pushing, publishing, and opening a pull request require a separate user request.

- To stop, steer, switch the provider, archive, or restore a run, open the dashboard and find the run the user named. Use its run controls. Stop a run when the user asks to stop that run. Shut down the dashboard server when the user asks to stop the server.
