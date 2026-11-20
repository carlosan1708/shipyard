import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPYARD_ROOT } from "../config.ts";

export const TOKEN_FILE = join(SHIPYARD_ROOT, ".shipyard", "ui-token");
/** One record per running UI (per port), so a demo UI and a real one can run side by side. */
export const SESSION_DIR = join(SHIPYARD_ROOT, ".shipyard");

export interface UiSession {
  port: number;
  pid: number;
  demo: boolean;
  startedAt: string;
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
