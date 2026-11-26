import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { DockerChecks } from "./config.ts";
import type { ExecResult } from "./exec.ts";
import { checkCommand } from "./guards.ts";

const workspace = "/shipyard-workspace";
const diagnosticLimit = 96_000;
const gitFiles = promisify(execFile);
export const DOCKER_CHECK_ERROR = "Could not run the project check in Docker:";

export type DockerCommand = (args: string[], options: { timeoutMs: number; signal?: AbortSignal }) =>
  Promise<{ code: number; output: string; timedOut: boolean }>;

const docker: DockerCommand = (args, { timeoutMs, signal }) => new Promise((resolve) => {
  const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let timedOut = false;
  const capture = (data: Buffer | string) => { output = (output + data.toString()).slice(-diagnosticLimit); };
  child.stdout?.setEncoding("utf8").on("data", capture);
  child.stderr?.setEncoding("utf8").on("data", capture);
  child.on("error", (error: NodeJS.ErrnoException) => capture(error.code === "ENOENT" ?
    "Docker CLI was not found. Install and start Docker with Linux containers, then retry." : error.message));
  const stop = () => { child.kill("SIGKILL"); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  child.on("close", (code) => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    resolve({ code: code ?? 1, output, timedOut });
  });
});

export async function requireDockerChecks(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const result = await docker(["info", "--format", "{{.OSType}}"], { timeoutMs: 10_000, signal });
  signal?.throwIfAborted();
  if (result.code === 0 && !result.timedOut && result.output.trim().split(/\r?\n/).includes("linux")) return;
  const reason = result.timedOut ? "Docker did not respond." : result.output.trim();
  throw new Error(`${DOCKER_CHECK_ERROR} Start Docker with Linux containers. ${reason}`.trim());
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return Boolean(path) && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

async function copyCheckout(cwd: string, destination: string, check: () => void, signal?: AbortSignal) {
  const root = await realpath(cwd);
  const { stdout } = await gitFiles("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, maxBuffer: 32 * 1024 * 1024, signal,
  });
  for (const path of new Set(stdout.split("\0").filter(Boolean))) {
    check();
    const source = join(root, path);
    if (!inside(root, source) || path.split("/").some((part) => part.toLowerCase() === ".git")) {
      throw new Error(`Invalid checkout path ${JSON.stringify(path)}`);
    }
    const entry = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      // Tracked files can be deleted or replaced in the current checkout.
      return undefined;
    });
    if (!entry) continue;
    if (!entry.isFile() || !inside(root, await realpath(source))) {
      throw new Error(`Docker checks require regular files inside the checkout. Review ${JSON.stringify(path)} for symlinks or submodules.`);
    }
    const output = join(destination, path);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(source, output);
  }
}

function bindMount(path: string): string {
  const field = `source=${path}`;
  return `type=bind,${/[,"]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field},target=${workspace}`;
}

export async function dockerProjectCheck(command: string, cwd: string, options: DockerChecks, timeoutMs = 10 * 60_000,
  signal?: AbortSignal, runDocker: DockerCommand = docker): Promise<ExecResult> {
  const started = Date.now();
  let timedOut = false;
  const result = (code: number, output: string): ExecResult => ({ command, code, output, durationMs: Date.now() - started, timedOut });
  const remaining = () => timeoutMs - (Date.now() - started);
  const check = () => {
    signal?.throwIfAborted();
    if (remaining() <= 0) {
      timedOut = true;
      throw new Error("Docker project check timed out");
    }
  };
  const invoke = async (args: string[], { cancel = true, limit = timeoutMs } = {}) => {
    check();
    const response = await runDocker(args, { timeoutMs: Math.max(1, Math.min(remaining(), limit)), signal: cancel ? signal : undefined });
    if (response.timedOut) timedOut = true;
    signal?.throwIfAborted();
    if (timedOut) throw new Error(response.output || "Docker project check timed out");
    return response;
  };

  let temporary: string | undefined;
  try {
    check();
    for (const step of [options.install, command]) {
      if (!step) continue;
      const verdict = checkCommand(step, {});
      if (verdict.blocked) throw new Error(verdict.reason);
    }
    temporary = await mkdtemp(join(tmpdir(), "shipyard-docker-"));
    const snapshot = join(temporary, "checkout");
    await mkdir(snapshot);
    await copyCheckout(cwd, snapshot, check, signal);
    const image = await invoke(["image", "inspect", options.image]);
    if (image.code !== 0) {
      const pull = await invoke(["pull", options.image]);
      if (pull.code !== 0) throw new Error(`Could not load Linux Docker image ${options.image}. ${pull.output.trim()}`);
    }

    const run = async (script: string, network: "bridge" | "none") => {
      const name = `shipyard-check-${randomUUID()}`;
      const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
      try {
        // Let create report completion before removing by name, even if a stop arrives during creation.
        const create = await invoke(["container", "create", "--pull=never", "--name", name, "--network", network,
          "--init", "--user", user, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--shm-size=256m",
          "--mount", bindMount(snapshot), "--workdir", workspace, "--env", "HOME=/tmp", "--env", "CI=1", "--env", "NO_COLOR=1",
          "--entrypoint", "/bin/sh", options.image, "-c", script], { cancel: false, limit: 15_000 });
        if (create.code !== 0) throw new Error(`Could not create the Docker check container. ${create.output.trim()}`);
        const execution = await invoke(["container", "start", "--attach", name]);
        const inspect = await invoke(["container", "inspect", "--format", "{{json .State}}", name]);
        if (inspect.code !== 0) throw new Error(inspect.output.trim() || "Could not read the Docker container exit status.");
        const state = JSON.parse(inspect.output) as { Status?: string; ExitCode?: number; Error?: string };
        if (state.Status !== "exited" || !Number.isInteger(state.ExitCode) || state.Error) {
          throw new Error(`Could not start the Docker check. ${state.Error || execution.output.trim()}`);
        }
        return { code: state.ExitCode!, output: execution.output };
      } finally {
        const cleanup = await runDocker(["container", "rm", "--force", "--volumes", name], { timeoutMs: 15_000 });
        if (cleanup.code !== 0 && !/No such container/i.test(cleanup.output)) {
          throw new Error(`Could not remove Docker container ${name}. ${cleanup.output.trim()}`);
        }
      }
    };

    if (options.install) {
      const setup = await run(options.install, "bridge");
      if (setup.code !== 0) throw new Error(`Docker dependency setup failed (exit ${setup.code}). ${setup.output.trim()}`);
    }
    const output = await run(command, "none");
    return result(output.code, output.output);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Could not remove Docker container")) {
      throw new Error(`${DOCKER_CHECK_ERROR} ${error.message}`);
    }
    if (signal?.aborted) return result(130, "Docker project check cancelled.");
    if (timedOut) return result(124, error instanceof Error ? error.message : "Docker project check timed out.");
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${DOCKER_CHECK_ERROR} ${reason}`);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
