---
description: Fix a bug the shipyard way - reproduce with a failing test, fix, then add E2E coverage
argument-hint: <bug report>
---

Fix this bug in the current repository: $ARGUMENTS

Follow the shipyard flow:

1. Find the project's unit test and E2E commands (package.json scripts, Makefile, README). Tell me which ones you will use.
2. Hand the bug report to the `backend` agent. It must reproduce the bug with a failing unit test, then fix the root cause.
3. Run the unit tests yourself. If they fail, send the output back to the `backend` agent. Stop after 2 retries and tell me what is still failing.
4. Hand the bug report and the change to the `e2e-tester` agent, so it adds an E2E test that would have caught the bug.
5. Run the E2E tests. If they fail because of application code, send the failure back to the `backend` agent (max 2 retries).
6. Report: root cause, files changed, tests added, and the final test results.

Do not commit, push or open a pull request unless I ask.
