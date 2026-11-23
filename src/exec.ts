import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkCommand } from "./guards.ts";
import { SHIPYARD_ROOT } from "./config.ts";

const execFileAsync = promisify(execFile);
const MAC_GATE_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export interface ExecResult {
  command: string;
  code: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/** Run worktree code with local networking only. The approval controllers run on the host. */
export function localProcess(command: string, args: string[], hostLoopback = false): [string, string[]] {
  if (process.platform === "darwin") {
    const dashboardToken = JSON.stringify(join(SHIPYARD_ROOT, ".shipyard", "ui-token"));
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(allow network-bind)",
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
      `(deny file-read* file-write* (literal ${dashboardToken}))`,
    ].join("\n");
    return ["/usr/bin/sandbox-exec", ["-p", profile, command, ...args]];
  }
  if (process.platform === "linux" && !hostLoopback) {
    return ["bwrap", ["--unshare-net", "--unshare-pid", "--bind", "/", "/", "--tmpfs", "/run", "--proc", "/proc", "--", command, ...args]];
  }
  throw new Error(hostLoopback ? "This host cannot sandbox a process-backed local preview. Static previews are available." :
    "Shipyard needs the macOS network sandbox or Linux bubblewrap to run project checks.");
}

/**
 * Run a shell command (a gate) and capture stdout+stderr together.
 * Runs in its own process group so a hung test server is killed on timeout.
 */
export async function sh(command: string, cwd: string, timeoutMs = 10 * 60_000, signal?: AbortSignal): Promise<ExecResult> {
  const started = Date.now();
  if (signal?.aborted) return { command, code: 130, output: "", durationMs: 0, timedOut: false };
  const verdict = checkCommand(command, {});
  if (verdict.blocked) throw new Error(verdict.reason);
  const ready = "[shipyard: sandbox ready]\n";
  const [executable, args] = localProcess("/bin/sh", ["-c", 'printf "%s\\n" "$1"; exec /bin/sh -c "$2"', "shipyard", ready.trimEnd(), command]);
  return new Promise((resolvePromise, reject) => {
    // Gates must see a clean environment. NODE_TEST_CONTEXT in particular makes a nested
    // `node --test` report to its parent instead of exiting non-zero on failure.
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    if (process.platform === "darwin" && !env.CHROME_PATH) {
      const chrome = MAC_GATE_BROWSERS.find(existsSync);
      if (chrome) {
        // Only checks that use CHROME_PATH opt in to this launcher. The outer network policy still applies.
        env.CHROME_PATH = join(SHIPYARD_ROOT, "bin", "shipyard-gate-chrome");
        env.SHIPYARD_GATE_CHROME = chrome;
      }
    }
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env: { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", (error) => { output += error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (!output.includes(ready) && !signal?.aborted && !timedOut) {
        reject(new Error(`Could not start the project check in its network sandbox: ${output.trim() || executable}`));
        return;
      }
      output = output.replace(ready, "");
      resolvePromise({ command, code: signal?.aborted ? 130 : timedOut ? 124 : (code ?? 1), output, durationMs: Date.now() - started, timedOut });
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

/** Run git where some non-zero exit codes are normal (e.g. `diff --no-index` exits 1 when files differ). */
export async function gitAllowing(args: string[], cwd: string, okCodes: number[]): Promise<string> {
  try {
    return (await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    if (typeof e.code === "number" && okCodes.includes(e.code)) return e.stdout ?? "";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(e.stderr || e.message).trim()}`);
  }
}

/** Keep the end of long tool output, which is where test failures usually are. */
export function tail(text: string, maxChars = 6000): string {
  return text.length <= maxChars ? text : `…(${text.length - maxChars} chars trimmed)…\n` + text.slice(-maxChars);
}
