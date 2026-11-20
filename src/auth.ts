/**
 * How the agents sign in.
 * - subscription (default): your Claude Code sign-in (Pro / Max). Runs count against your plan's
 *   usage limits; nothing is billed per token.
 * - api-key: use ANTHROPIC_API_KEY (or a cloud provider) from the environment, billed per token.
 */
export type AuthMode = "subscription" | "api-key";

/**
 * Variables that make Claude Code bill an API account or a cloud provider instead of using the
 * subscription sign-in. One stray export in a shell profile is enough to switch silently.
 */
export const API_BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** The environment for an agent's Claude Code process. The SDK's `env` replaces the whole environment. */
export function agentEnv(base: NodeJS.ProcessEnv, mode: AuthMode): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: "shipyard/0.1.0" };
  if (mode === "subscription") {
    for (const name of API_BILLING_VARS) delete env[name];
  }
  return env;
}

/** Names of API billing variables present in `base` that subscription mode will ignore. */
export function ignoredBillingVars(base: NodeJS.ProcessEnv): string[] {
  return API_BILLING_VARS.filter((name) => base[name]);
}
