---
description: Ship a feature the shipyard way - plan, implement with unit tests, review with fresh eyes, verify end to end, document
argument-hint: <feature request>
---

Implement this feature in the current repository: $ARGUMENTS

Follow the shipyard flow, using the shipyard agents:

1. Find the project's unit test and E2E commands (package.json scripts, Makefile, README). Tell me which ones you will use.
2. **Plan:** hand the request to the `planner` agent. Show me its plan and wait for my go-ahead or changes.
3. **Implement:** hand the request and the approved plan to the `frontend` agent if the work is mainly UI, otherwise to the `backend` agent.
4. Run the unit tests yourself. If they fail, send the output back to the same agent. Stop after 2 retries and tell me what is still failing.
5. **Review:** hand the diff to the `reviewer` agent (a fresh agent that has not seen the implementation). If it reports blocker or major findings, send them to the implementer, then run the unit tests again.
6. **E2E:** hand the request and the change to the `e2e-tester` agent, so it covers the main path and at least one failure path through the public interface. Run the E2E tests; if they fail because of application code, send the failure back to the implementer (max 2 retries).
7. **Docs:** if anything user-facing changed, hand the change to the `docs-writer` agent.
8. Report: what was built, files changed, review findings and how they were handled, tests added, and the final test results.

Do not commit, push, publish or open a pull request unless I ask. If I ask for a release, use the `release-manager` agent to prepare it; publishing stays with me.
