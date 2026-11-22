import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPYARD_ROOT } from "../config.ts";

export const TOKEN_FILE = join(SHIPYARD_ROOT, ".shipyard", "ui-token");
/** One record per running UI (per port), so a demo UI and a real one can run side by side. */
export const SESSION_DIR = join(SHIPYARD_ROOT, ".shipyard");

export interface UiSession {
  port: number;
  pid: number;
  demo: boolean;
  startedAt: string;
  revision?: string;
}

/** Identify the dashboard's server code, assets, and runtime dependencies at launch. */
export function dashboardRevision(): string {
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const hash = createHash("sha256");
  function addFile(path: string) {
    const data = readFileSync(join(checkout, path));
    hash.update(`${path}\0${data.length}\0`).update(data);
  }
  function addDirectory(path: string) {
    const entries = readdirSync(join(checkout, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) addDirectory(name);
      else if (entry.isFile()) addFile(name);
    }
  }
  for (const file of ["package.json", "package-lock.json"]) addFile(file);
  for (const dir of ["src", "ui", "bin", "plugins/shipyard"]) addDirectory(dir);
  return hash.digest("hex").slice(0, 12);
}

const fileFor = (dir: string, port: number) => join(dir, `ui-session-${port}.json`);

/** Record the running UI, so `shipyard ui-link` can print its link again. */
export function writeSession(session: UiSession, dir = SESSION_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(dir, session.port), JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
}

/** Remove our record, but only if it is still ours (another UI may have taken the port since). */
export function clearSession(port: number, pid: number, dir = SESSION_DIR): void {
  if (readSession(fileFor(dir, port))?.pid === pid) rmSync(fileFor(dir, port), { force: true });
}

/** The UIs whose process is still alive: real ones first, then demos, newest first. */
export function readLiveSessions(dir = SESSION_DIR): UiSession[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^ui-session-\d+\.json$/.test(f))
    .map((f) => readSession(join(dir, f)))
    .filter((s): s is UiSession => s !== null && alive(s.pid))
    .sort((a, b) => Number(a.demo) - Number(b.demo) || b.startedAt.localeCompare(a.startedAt));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: only checks that the process exists
    return true;
  } catch {
    return false;
  }
}

function readSession(file: string): UiSession | null {
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as UiSession;
    return Number.isInteger(s.port) && Number.isInteger(s.pid) ? s : null;
  } catch {
    return null;
  }
}
