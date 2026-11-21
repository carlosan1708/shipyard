import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { canPreview, startPreview, type LocalPreview } from "./preview.ts";

const HOST = "::1";
const FRAMEWORKS = ["streamlit", "vite", "next", "static", "unsupported"] as const;
type Framework = (typeof FRAMEWORKS)[number];

export const LOCAL_APP_SCHEMA = {
  type: "object",
  properties: {
    framework: { type: "string", enum: FRAMEWORKS },
    directory: { type: "string" },
    entry: { type: "string" },
    detail: { type: "string" },
  },
  required: ["framework", "directory", "entry", "detail"],
  additionalProperties: false,
};

async function inDirectory(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("The app path must be inside the run’s worktree");
  const resolved = await realpath(join(root, path)).catch(() => undefined);
  if (!resolved || (resolved !== root && !resolved.startsWith(root + sep))) throw new Error("The app path is missing or outside the run’s worktree");
  return resolved;
}

async function availablePort(): Promise<number> {
  const socket = createServer();
  return await new Promise<number>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, HOST, () => {
      const { port } = socket.address() as AddressInfo;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function launchLocalApp(worktree: string, repo: string, plan: unknown, signal: AbortSignal, exited: () => void): Promise<LocalPreview> {
  const { framework, directory, entry, detail } = (plan ?? {}) as Partial<Record<string, unknown>>;
  if (!FRAMEWORKS.includes(framework as Framework) || typeof directory !== "string" || typeof entry !== "string") {
    throw new Error("The local app agent did not return a usable launch plan");
  }
  if (framework === "unsupported") throw new Error(typeof detail === "string" && detail.trim() ? detail.trim().slice(0, 400) : "No supported web app was found in this worktree");
  const root = await realpath(worktree);
  const cwd = await inDirectory(root, directory);
  if (!(await stat(cwd)).isDirectory()) throw new Error("The app project path must be a directory");
  signal.throwIfAborted();
  if (framework === "static") {
    if (!canPreview(cwd)) throw new Error("The static app needs an index.html in its project directory");
    return startPreview(cwd);
  }

  const port = String(await availablePort());
  let command = process.execPath;
  let args: string[];
  if (framework === "streamlit") {
    const file = await inDirectory(cwd, entry);
    if (!file.endsWith(".py") || !(await stat(file)).isFile()) throw new Error("The Streamlit entry point must be a Python file");
    const project = relative(root, cwd);
    const environments = [cwd, root, join(repo, project), repo];
    command = environments.map((dir) => join(dir, ".venv", "bin", "python")).find(existsSync) ?? "python3";
    args = ["-m", "streamlit", "run", file, `--server.address=${HOST}`, `--server.port=${port}`, "--server.headless=true"];
  } else {
    const next = framework === "next";
    const bin = next ? "next/dist/bin/next" : "vite/bin/vite.js";
    const cli = [cwd, root].map((dir) => join(dir, "node_modules", bin)).find(existsSync);
    if (!cli) throw new Error(`Install this project's ${next ? "Next.js" : "Vite"} dependencies in the run worktree and retry`);
    args = next ? [cli, "dev", "--hostname", HOST, "--port", port] : [cli, "--host", HOST, "--port", port, "--strictPort"];
  }

  signal.throwIfAborted();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let ended = false;
  let ready = false;
  const capture = (data: Buffer) => { output = (output + data.toString()).slice(-2000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => { output = error.message; });
  const done = new Promise<void>((resolve) => child.once("close", () => {
    ended = true;
    if (ready) exited();
    resolve();
  }));
  const close = async () => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    }
    await done;
  };
  const url = `http://[${HOST}]:${port}/`;
  const startup = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    while (!ended && !startup.aborted) {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([startup, AbortSignal.timeout(1500)]) }).catch(() => undefined);
      await response?.body?.cancel().catch(() => undefined);
      if (!ended && !startup.aborted && response && response.status < 500) {
        ready = true;
        return { url, close };
      }
      await sleep(200, undefined, { signal: startup }).catch(() => undefined);
    }
    signal.throwIfAborted();
    if (/No module named streamlit/i.test(output)) throw new Error("Streamlit is missing from the selected Python environment. Install the project’s Python dependencies and retry.");
    throw new Error(ended ? `The app exited during startup${output.trim() ? `\n${output.trim()}` : "."}` : "The app did not start listening within 45 seconds");
  } catch (error) {
    await close();
    throw error;
  }
}
