import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BROWSER_SERVER, BROWSER_TOKEN_ENV, BROWSER_TOOL, startBrowserTool } from "./browser-tool.ts";
import type { AgentRequest, AgentResult, AgentRunner, TokenUsage } from "./agent.ts";
import { CODEX_TIMEOUT_MS } from "./config.ts";
import { git, tail } from "./exec.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

// Strict structured outputs require every object property. Preserve optional fields by accepting null.
function strictSchema(schema: JsonObject): JsonObject {
  const properties = object(schema.properties);
  if (properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return {
      ...schema,
      additionalProperties: false,
      required: Object.keys(properties),
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, value]) => {
          const field = strictSchema(object(value) ?? {});
          return [name, required.has(name) ? field : { anyOf: [field, { type: "null" }] }];
        }),
      ),
    };
  }
  const items = object(schema.items);
  return items ? { ...schema, items: strictSchema(items) } : schema;
}

function parseStructured(value: unknown, schema: JsonObject): unknown {
  const invalid = () => new Error("Codex returned a final response that did not match the requested schema");
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw invalid();
  switch (schema.type) {
    case "object": {
      const fields = object(value);
      if (!fields) throw invalid();
      const properties = object(schema.properties) ?? {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      for (const name of required) {
        if (typeof name !== "string" || !Object.hasOwn(fields, name)) throw invalid();
      }
      return Object.fromEntries(
        Object.entries(fields).flatMap(([name, field]) => {
          if (!Object.hasOwn(properties, name)) throw invalid();
          if (field === null && !required.has(name)) return [];
          return [[name, parseStructured(field, object(properties[name]) ?? {})]];
        }),
      );
    }
    case "array":
      if (!Array.isArray(value)) throw invalid();
      return value.map((item) => parseStructured(item, object(schema.items) ?? {}));
    case "integer":
      if (!Number.isInteger(value)) throw invalid();
      break;
    case "boolean":
    case "number":
    case "string":
      if (typeof value !== schema.type) throw invalid();
      break;
  }
  return value;
}

function readUsage(value: unknown): TokenUsage | undefined {
  const usage = object(value);
  if (typeof usage?.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0,
    outputTokens: usage.output_tokens,
  };
}

export class CodexAgentRunner implements AgentRunner {
  private readonly children = new Set<() => void>();
  private stopped = false;

  constructor(
    private readonly timeoutMs = CODEX_TIMEOUT_MS,
    private readonly executable = "codex",
  ) {}

  stop(): void {
    this.stopped = true;
    for (const kill of this.children) kill();
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    let sessionId = req.resumeSessionId;
    let summary = "";
    let usage: TokenUsage | undefined;
    let completed = false;
    const result = () => ({ sessionId, summary, usage, costUsd: null, turns: completed ? 1 : 0, durationMs: Date.now() - started });

    let scratch: string | undefined;
    let browser: Awaited<ReturnType<typeof startBrowserTool>> | undefined;
    try {
      const cwd = realpathSync(req.cwd);
      const head = await git(["rev-parse", "HEAD"], cwd);
      const branch = await git(["symbolic-ref", "HEAD"], cwd);
      scratch = mkdtempSync(join(tmpdir(), "shipyard-codex-"));
      const output = join(scratch, "final.txt");
      const config = (name: string, value: unknown) => ["-c", `${name}=${JSON.stringify(value)}`];
      if (req.browserAccess) browser = await startBrowserTool(cwd, req.signal,
        (detail) => req.onEvent?.({ type: "tool", tool: "Browser", detail }));
      const args = [
        "exec",
        ...config("approval_policy", "never"),
        ...config("sandbox_mode", req.lane === "none" ? "read-only" : "workspace-write"),
        ...config("sandbox_workspace_write.network_access", false),
        ...config("sandbox_workspace_write.writable_roots", []),
        ...config("sandbox_workspace_write.exclude_slash_tmp", true),
        ...config("sandbox_workspace_write.exclude_tmpdir_env_var", true),
        ...config("web_search", "disabled"),
        ...config("features.apps", false),
        ...config("features.browser_use", false),
        ...config("features.plugins", false),
        ...config("features.multi_agent", false),
        ...config(`projects.${JSON.stringify(cwd)}.trust_level`, "untrusted"),
        ...(browser ? [
          ...config(`mcp_servers.${BROWSER_SERVER}.url`, browser.url),
          ...config(`mcp_servers.${BROWSER_SERVER}.bearer_token_env_var`, BROWSER_TOKEN_ENV),
          ...config(`mcp_servers.${BROWSER_SERVER}.enabled_tools`, [BROWSER_TOOL]),
          ...config(`mcp_servers.${BROWSER_SERVER}.default_tools_approval_mode`, "approve"),
          ...config("shell_environment_policy.exclude", [BROWSER_TOKEN_ENV]),
        ] : []),
        ...(req.model ? ["--model", req.model] : []),
        ...(req.effort ? config("model_reasoning_effort", req.effort) : []),
      ];
      if (req.resumeSessionId) args.push("resume", req.resumeSessionId);
      for (const image of req.images ?? []) args.push("--image", image.path);
      args.push("--json", "--ignore-user-config", "--output-last-message", output);
      if (req.outputSchema) {
        const schema = join(scratch, "schema.json");
        writeFileSync(schema, JSON.stringify(strictSchema(req.outputSchema)));
        args.push("--output-schema", schema);
      }
      args.push("-");

      let stderr = "";
      let failure = "";
      let timedOut = false;
      const env = { ...process.env };
      delete env.CODEX_API_KEY; // Use credentials already saved by the CLI.
      delete env.OPENAI_API_KEY;
      delete env.SHIPYARD_ALLOW_PUBLISH;
      delete env[BROWSER_TOKEN_ENV];
      if (browser) env[BROWSER_TOKEN_ENV] = browser.token;
      req.signal?.throwIfAborted();
      if (this.stopped) throw new Error("Shipyard stopped the Codex runner");
      const child = spawn(this.executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      const kill = () => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      this.children.add(kill);
      req.signal?.addEventListener("abort", kill, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, this.timeoutMs);

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        let event: JsonObject | undefined;
        try {
          event = object(JSON.parse(line));
        } catch {
          return;
        }
        if (event?.type === "thread.started" && typeof event.thread_id === "string") {
          sessionId = event.thread_id;
          req.onEvent?.({ type: "session", sessionId });
        }
        if (event?.type === "turn.completed") {
          completed = true;
          usage = readUsage(event.usage);
        }
        if (event?.type === "turn.failed") failure = String(object(event.error)?.message ?? "Codex turn failed");
        if (event?.type === "error" && typeof event.message === "string" && !failure) failure = event.message;

        const item = object(event?.item);
        if (event?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          req.onEvent?.({ type: "text", text: item.text });
        }
        if (item && ((event?.type === "item.started" && item.type === "command_execution") || (event?.type === "item.completed" && item.type === "file_change"))) {
          const detail = typeof item.command === "string" ? item.command : (Array.isArray(item.changes)
            ? item.changes.map((change) => object(change)?.path).filter(Boolean).join(", ")
            : "");
          req.onEvent?.({ type: "tool", tool: item.type === "file_change" ? "Edit" : "Bash", detail: tail(detail, 500) });
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
      child.stdin.on("error", () => {}); // Early child exit is reported by the process result.
      const exited = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
        let error: NodeJS.ErrnoException | undefined;
        child.on("error", (err: NodeJS.ErrnoException) => { error = err; });
        child.once("close", (code) => resolve({ code, error }));
      });
      child.stdin.end(
        `${req.role.prompt}\n\nWork in this Shipyard worktree. Shipyard runs the configured gates separately, including tests that need local networking. Leave Git staging and commits to Shipyard. Do not publish, deploy, or open a pull request.\n\n${req.prompt}`,
      );

      const exit = await exited.finally(() => {
        lines.close();
        clearTimeout(timer);
        this.children.delete(kill);
        req.signal?.removeEventListener("abort", kill);
      });
      if (exit.error?.code === "ENOENT") throw new Error("Codex CLI was not found on PATH. Install it and run codex login.");
      if (exit.error) throw exit.error;
      const finalHead = await git(["rev-parse", "HEAD"], cwd);
      const finalBranch = await git(["symbolic-ref", "HEAD"], cwd).catch(() => "");
      if (head !== finalHead || branch !== finalBranch) throw new Error("Codex changed Git HEAD or the worktree branch. Review the preserved worktree.");
      req.signal?.throwIfAborted();
      if (this.stopped) throw new Error("Shipyard stopped the Codex runner");
      if (timedOut) throw new Error(`Codex attempt timed out after ${this.timeoutMs} ms`);
      if (exit.code !== 0 || !completed) {
        const reason = failure || stderr.trim() || `Codex exited without a completed turn (exit ${exit.code ?? "signal"})`;
        const hint = /authenticat|unauthorized|401|log[ -]?in|credential|api key/i.test(reason) ? " Check codex login status or run codex login." : "";
        throw new Error(`${reason}${hint}`);
      }

      try {
        summary = readFileSync(output, "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!summary) throw new Error("Codex completed without a final response");
      let structured: unknown;
      if (req.outputSchema) {
        try {
          structured = parseStructured(JSON.parse(summary), req.outputSchema);
        } catch {
          throw new Error("Codex returned a final response that did not match the requested schema");
        }
      }
      return { ...result(), ok: true, structured };
    } catch (error) {
      return { ...result(), ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await browser?.close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
}
