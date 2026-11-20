import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, ignoredBillingVars } from "../src/auth.ts";

const shell = { PATH: "/usr/bin", HOME: "/Users/me", ANTHROPIC_API_KEY: "sk-test", CLAUDE_CODE_USE_BEDROCK: "1" };

test("subscription mode strips every variable that would switch to per-token billing", () => {
  const env = agentEnv(shell, "subscription");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/me", "HOME is needed to find the Claude Code sign-in");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "shipyard/0.1.0");
});

test("api-key mode keeps the key", () => {
  assert.equal(agentEnv(shell, "api-key").ANTHROPIC_API_KEY, "sk-test");
});

test("the CLI can say which variables it is ignoring", () => {
  assert.deepEqual(ignoredBillingVars(shell), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]);
  assert.deepEqual(ignoredBillingVars({ PATH: "/usr/bin" }), []);
});
