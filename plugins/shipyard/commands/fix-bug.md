---
description: Fix a bug the shipyard way - reproduce with a failing test, fix, review with fresh eyes, add E2E coverage
argument-hint: <bug report>
---

Fix this bug in the current repository: $ARGUMENTS

Follow the shipyard flow, using the shipyard agents:

1. Find the project's unit test and E2E commands (package.json scripts, Makefile, README). Tell me which ones you will use.
2. **Fix:** hand the bug report to the `frontend` agent if the bug is in the UI, otherwise to the `backend` agent. It must reproduce the bug with a failing unit test, then fix the root cause.
3. Run the unit tests yourself. If they fail, send the output back to the same agent. Stop after 2 retries and tell me what is still failing.
4. **Review:** hand the diff to the `reviewer` agent (a fresh agent that has not seen the fix). If it reports blocker or major findings, send them to the implementer, then run the unit tests again.
5. **E2E:** hand the bug report and the change to the `e2e-tester` agent, so it adds an E2E test that would have caught the bug. Run the E2E tests; if they fail because of application code, send the failure back to the implementer (max 2 retries).
6. Report: root cause, files changed, review findings and how they were handled, tests added, and the final test results.

Do not commit, push or open a pull request unless I ask.
