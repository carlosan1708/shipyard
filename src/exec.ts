import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  command: string;
  code: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Run a shell command (a gate) and capture stdout+stderr together.
 * Runs in its own process group so a hung test server is killed on timeout.
 */
export function sh(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    // Gates must see a clean environment. NODE_TEST_CONTEXT in particular makes a nested
    // `node --test` report to its parent instead of exiting non-zero on failure.
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      env: { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ command, code: timedOut ? 124 : (code ?? 1), output, durationMs: Date.now() - started, timedOut });
    });
  });
}

/**
 * Run git and return stdout, trimmed unless `raw` is set (porcelain formats are whitespace-sensitive).
 * Throws with stderr on failure.
 */
export async function git(args: string[], cwd: string, { raw = false } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return raw ? stdout : stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(e.stderr || e.message).trim()}`);
  }
}

/** Keep the end of long tool output, which is where test failures usually are. */
export function tail(text: string, maxChars = 6000): string {
  return text.length <= maxChars ? text : `…(${text.length - maxChars} chars trimmed)…\n` + text.slice(-maxChars);
}
