---
description: Ship a feature the shipyard way - implement with unit tests, then verify end to end
argument-hint: <feature request>
---

Implement this feature in the current repository: $ARGUMENTS

Follow the shipyard flow:

1. Find the project's unit test and E2E commands (package.json scripts, Makefile, README). Tell me which ones you will use. If the request is ambiguous in a way that changes the design, ask me before starting.
2. Hand the request to the `backend` agent to implement it with unit tests.
3. Run the unit tests yourself. If they fail, send the output back to the `backend` agent. Stop after 2 retries and tell me what is still failing.
4. Hand the request and the change to the `e2e-tester` agent, so it covers the feature's main path and at least one failure path through the public interface.
5. Run the E2E tests. If they fail because of application code, send the failure back to the `backend` agent (max 2 retries).
6. Report: what was built, files changed, tests added, and the final test results.

Do not commit, push or open a pull request unless I ask.
