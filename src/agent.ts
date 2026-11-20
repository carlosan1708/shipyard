import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv, type AuthMode } from "./auth.ts";
import { checkToolUse, type Lane } from "./guards.ts";
import type { Role } from "./roles.ts";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; detail: string }
  | { type: "denied"; tool: string; reason: string };

export interface AgentRequest {
  role: Role;
  prompt: string;
  cwd: string;
  lane: Lane;
  /** Continue an earlier session of the same role (keeps its context, avoids re-reading the repo). */
  resumeSessionId?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  ok: boolean;
  sessionId?: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  /** The agent's final message. */
  summary: string;
  error?: string;
}

/** The seam between the pipeline and Claude. Tests swap in a scripted fake. */
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

    try {
      const session = query({
        prompt: req.prompt,
        options: {
          cwd: req.cwd,
          model: req.role.model ?? this.opts.model,
          effort: this.opts.effort,
          // Keep Claude Code's own coding prompt and add the role on top.
          systemPrompt: { type: "preset", preset: "claude_code", append: req.role.prompt },
          // The role's tools are the only ones available, and they run without prompting;
          // anything else is denied (headless: there is nobody to ask).
          tools: req.role.tools,
          allowedTools: req.role.tools,
          permissionMode: "dontAsk",
          // Load only the target repo's CLAUDE.md and project settings, not this machine's user settings,
          // so runs are reproducible.
          settingSources: ["project"],
          maxBudgetUsd: this.opts.maxBudgetUsd,
          maxTurns: this.opts.maxTurns,
          resume: req.resumeSessionId,
          hooks: { PreToolUse: [{ hooks: [guard] }] },
          // In subscription mode, strip API keys so a stray export can't switch runs to per-token billing.
          env: agentEnv(process.env, this.opts.auth),
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
