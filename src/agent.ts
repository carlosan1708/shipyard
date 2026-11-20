import { query, type CanUseTool, type HookCallback, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, type AuthMode } from "./auth.ts";
import { checkToolUse, type Lane } from "./guards.ts";
import { EFFORTS, type RunEffort } from "./config.ts";
import type { Role } from "./roles.ts";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; detail: string }
  | { type: "denied"; tool: string; reason: string };

/** A multiple-choice question an agent asks with Claude Code's AskUserQuestion tool. */
export interface AgentQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/** Something an agent needs from a human while it works. */
export type AgentAsk =
  | { kind: "question"; questions: AgentQuestion[] }
  | { kind: "permission"; tool: string; input: Record<string, unknown>; title?: string; reason?: string };

export type AgentAnswer =
  /** Question text -> answer (multi-select answers comma-separated, free text allowed). */
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "permission"; allow: boolean; message?: string };

export interface AgentRequest {
  role: Role;
  prompt: string;
  cwd: string;
  lane: Lane;
  signal?: AbortSignal;
  /** Continue an earlier session of the same role (keeps its context, avoids re-reading the repo). */
  resumeSessionId?: string;
  onEvent?: (event: AgentEvent) => void;
  /**
   * A human the agent can ask while it works (questions, and tools outside its allowlist).
   * When unset the agent runs headless: it can't ask, and anything not allowed is denied.
   */
  ask?: (ask: AgentAsk) => Promise<AgentAnswer>;
  /** This run's model and effort, chosen when it was started. They win over the runner's defaults. */
  model?: string;
  effort?: RunEffort;
  /** Ask for a final answer matching this JSON schema (e.g. the reviewer's verdict). Returned as `structured`. */
  outputSchema?: Record<string, unknown>;
  /** What is left of the run's budget. The agent stops at this or the runner's per-stage cap, whichever is lower. */
  maxBudgetUsd?: number;
}

/**
 * Turn a Claude Code permission request into a question for the human. AskUserQuestion calls
 * become questions whose answers are passed back in the tool input; any other tool outside the
 * role's allowlist becomes an allow/deny request. The publish guard and lanes still run first,
 * as a PreToolUse hook, so a human can't approve a push or an out-of-lane edit from here.
 */
export async function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  ask: (a: AgentAsk) => Promise<AgentAnswer>,
  details: { title?: string; reason?: string } = {},
): Promise<PermissionResult> {
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? (input.questions as AgentQuestion[]) : [];
    if (questions.length === 0) return { behavior: "deny", message: "AskUserQuestion needs at least one question." };
    const answer = await ask({ kind: "question", questions });
    if (answer.kind !== "question") return { behavior: "deny", message: "The question was not answered." };
    return { behavior: "allow", updatedInput: { ...input, answers: answer.answers } };
  }
  const answer = await ask({ kind: "permission", tool: toolName, input, title: details.title, reason: details.reason });
  if (answer.kind === "permission" && answer.allow) return { behavior: "allow", updatedInput: input };
  const why = answer.kind === "permission" && answer.message?.trim() ? ` Their note: ${answer.message.trim()}` : "";
  return { behavior: "deny", message: `The human reviewer denied ${toolName}.${why}` };
}

export interface AgentResult {
  ok: boolean;
  sessionId?: string;
  costUsd: number | null;
  usage?: TokenUsage;
  turns: number;
  durationMs: number;
  /** The agent's final message. */
  summary: string;
  error?: string;
  /** The final answer as data, when the request asked for an outputSchema. */
  structured?: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function addTokenUsage(total: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    cachedInputTokens: (total?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
  };
}

/** The seam between the pipeline and the provider. Tests swap in a scripted fake. */
export interface AgentRunner {
  run(req: AgentRequest): Promise<AgentResult>;
}

export interface ClaudeRunnerOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Cap on the SDK's estimated cost per invocation. On a subscription it limits usage; nothing is billed. */
  maxBudgetUsd: number;
  maxTurns: number;
  auth: AuthMode;
  /** Tools an agent may use only after a human approves each call (needs AgentRequest.ask). */
  askTools?: string[];
}

/** Runs a role as a headless Claude Code session via the Claude Agent SDK. */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly opts: ClaudeRunnerOptions) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    let sessionId: string | undefined = req.resumeSessionId;

    // Enforced in-process for every tool call: publish guard, worktree boundary, role lane.
    const guard: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const verdict = checkToolUse(input.tool_name, input.tool_input, { root: req.cwd, lane: req.lane });
      if (verdict.allowed) return {};
      req.onEvent?.({ type: "denied", tool: input.tool_name, reason: verdict.reason });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        },
      };
    };

    // With a human available, the agent also gets AskUserQuestion and the ask-only tools; every
    // call outside the role's allowlist goes to the human. Headless, the role's tools are all it has.
    const ask = req.ask;
    const tools = ask ? [...new Set([...req.role.tools, "AskUserQuestion", ...(this.opts.askTools ?? [])])] : req.role.tools;
    const canUseTool: CanUseTool | undefined = ask
      ? (toolName, input, options) => decidePermission(toolName, input, ask, { title: options.title, reason: options.decisionReason })
      : undefined;

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.signal?.addEventListener("abort", abort, { once: true });
    try {
      req.signal?.throwIfAborted();
      const session = query({
        prompt: req.prompt,
        options: {
          cwd: req.cwd,
          abortController: controller,
          // What you picked for the run wins, then the role's own model, then the config default.
          model: req.model ?? req.role.model ?? this.opts.model,
          effort: EFFORTS.find((effort) => effort === req.effort) ?? this.opts.effort,
          // Keep Claude Code's own coding prompt and add the role on top.
          systemPrompt: { type: "preset", preset: "claude_code", append: req.role.prompt },
          // The role's tools run without prompting. Anything else is denied headless, or asked of the human.
          tools,
          allowedTools: req.role.tools,
          permissionMode: ask ? "default" : "dontAsk",
          canUseTool,
          // Load only the target repo's CLAUDE.md and project settings, not this machine's user settings,
          // so runs are reproducible.
          settingSources: ["project"],
          maxBudgetUsd: Math.min(this.opts.maxBudgetUsd, req.maxBudgetUsd ?? Infinity),
          maxTurns: this.opts.maxTurns,
          resume: req.resumeSessionId,
          hooks: { PreToolUse: [{ hooks: [guard] }] },
          // In subscription mode, strip API keys so a stray export can't switch runs to per-token billing.
          env: agentEnv(process.env, this.opts.auth),
          outputFormat: req.outputSchema ? { type: "json_schema", schema: req.outputSchema } : undefined,
        },
      });

      for await (const message of session) {
        sessionId ??= message.session_id;
        if (message.type === "assistant") this.emitAssistant(message, req);
        if (message.type === "result") {
          const success = message.subtype === "success";
          return {
            ok: success && !message.is_error,
            sessionId: message.session_id,
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
            durationMs: message.duration_ms,
            summary: success ? message.result : "",
            error: success ? (message.is_error ? message.result : undefined) : message.subtype,
            structured: success ? message.structured_output : undefined,
          };
        }
      }
      return { ok: false, sessionId, costUsd: 0, turns: 0, durationMs: Date.now() - started, summary: "", error: "session ended without a result" };
    } catch (err) {
      return {
        ok: false,
        sessionId,
        costUsd: 0,
        turns: 0,
        durationMs: Date.now() - started,
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      req.signal?.removeEventListener("abort", abort);
    }
  }

  private emitAssistant(message: Extract<SDKMessage, { type: "assistant" }>, req: AgentRequest): void {
    if (!req.onEvent || message.parent_tool_use_id) return;
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) req.onEvent({ type: "text", text: block.text });
      if (block.type === "tool_use") req.onEvent({ type: "tool", tool: block.name, detail: describeToolInput(block.input) });
    }
  }
}

function describeToolInput(input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const value = args.command ?? args.file_path ?? args.pattern ?? args.path ?? args.notebook_path;
  const text = typeof value === "string" ? value : JSON.stringify(args);
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
}
