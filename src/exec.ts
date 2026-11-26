import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkCommand } from "./guards.ts";
import { SHIPYARD_ROOT, type DockerChecks } from "./config.ts";
import { DOCKER_CHECK_ERROR, dockerProjectCheck } from "./docker-check.ts";

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

/** MXC allows the test's loopback server while the proxy has no external destinations to allow. */
function windowsGate(executable: string, args: string[], cwd: string, ready: string, verbatim: boolean): [string, string[]] {
  const token = JSON.stringify(join(SHIPYARD_ROOT, ".shipyard", "ui-token").replaceAll("\\", "/"));
  const profile = 'permissions.shipyard-checks={ extends=":workspace", ' +
    `filesystem={ ${token}="deny" }, ` +
    'network={ enabled=true, allow_local_binding=true, allow_upstream_proxy=false, domains={} } }';
  const launcher = `
    const { spawn } = require("node:child_process");
    process.stdout.write(${JSON.stringify(ready)});
    const child = spawn(${JSON.stringify(executable)}, ${JSON.stringify(args)},
      { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, windowsVerbatimArguments: ${verbatim} });
    process.stdin.once("data", () => process.exit(124));
    child.once("error", (error) => console.error(error.message));
    child.once("close", (code) => { process.stdin.pause(); process.exitCode = code ?? 1; });
  `;
  return ["codex", [
    "-c", "windows.sandbox=mxc", "-c", "features.network_proxy=true", "-c", profile,
    "sandbox", "--include-managed-config", "--permission-profile", "shipyard-checks",
    "-C", cwd, "--", process.execPath, "-e", launcher,
  ]];
}

export function isProjectCheckSandboxError(message: string | undefined): boolean {
  return Boolean(message?.startsWith("Could not start the project check in its network sandbox:") ||
    message?.startsWith(DOCKER_CHECK_ERROR) ||
    message === "Shipyard needs the macOS network sandbox or Linux bubblewrap to run project checks.");
}

/**
 * Run a shell command (a gate) and capture stdout+stderr together.
 * Runs in its own process group so a hung test server is killed on timeout.
 */
export function sh(command: string, cwd: string, timeoutMs?: number, signal?: AbortSignal, docker?: DockerChecks): Promise<ExecResult> {
  if (docker) return dockerProjectCheck(command, cwd, docker, timeoutMs, signal);
  const windows = process.platform === "win32";
  const program = windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = windows ? ["/d", "/s", "/v:off", "/c", `"${command}"`] : ["-c", command];
  return projectCheck(command, program, args, cwd, timeoutMs, signal, windows);
}

/** Pass internally generated check arguments directly, including paths containing spaces. */
export function checkExecutable(program: string, args: string[], cwd: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult> {
  const command = [program, ...args].map((arg) => JSON.stringify(arg)).join(" ");
  return projectCheck(command, program, args, cwd, timeoutMs, signal);
}

async function projectCheck(command: string, program: string, commandArgs: string[], cwd: string,
  timeoutMs = 10 * 60_000, signal?: AbortSignal, verbatim = false): Promise<ExecResult> {
  const started = Date.now();
  if (signal?.aborted) return { command, code: 130, output: "", durationMs: 0, timedOut: false };
  const verdict = checkCommand(command, {});
  if (verdict.blocked) throw new Error(verdict.reason);
  const ready = "[shipyard: sandbox ready]\n";
  const windows = process.platform === "win32";
  const [executable, args] = windows ? windowsGate(program, commandArgs, cwd, ready, verbatim) :
    localProcess("/bin/sh", ["-c", 'printf "%s\\n" "$1"; shift; exec "$@"', "shipyard", ready.trimEnd(), program, ...commandArgs]);
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
      detached: !windows,
      windowsHide: true,
      env: { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: [windows ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.stdin?.on("error", () => {}); // The sandbox may exit just before a cancellation arrives.
    let cancelFallback: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child.pid === undefined) return;
      if (windows) {
        if (cancelFallback) return;
        // Ending the foreground launcher tells MXC to terminate its sandboxed child processes.
        child.stdin?.end("stop\n");
        cancelFallback = setTimeout(() => child.kill("SIGKILL"), 2000);
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal?.aborted) kill();
    child.on("error", (error) => { output += error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(cancelFallback);
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
