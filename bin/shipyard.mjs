#!/usr/bin/env node
// Thin launcher so `npm link` gives you a global `shipyard` command.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  // Resolve tsx from this repo, so the command works from any folder.
  ["--import", import.meta.resolve("tsx"), join(root, "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd(), env: { ...process.env, SHIPYARD_ROOT: root } },
);
process.exit(result.status ?? 1);
