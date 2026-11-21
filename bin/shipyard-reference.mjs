#!/usr/bin/env node
// Narrow return channel for an interactive provider. This helper never loads the dashboard token.
import { readFile, stat } from "node:fs/promises";

async function main() {
  const [action, rawPort, ticket, file, extra] = process.argv.slice(2);
  const port = Number(rawPort);
  if (!["context", "submit"].includes(action) || !/^\d{1,5}$/.test(rawPort ?? "") || port < 1 || port > 65535 ||
      !/^[0-9a-f]{48}$/.test(ticket ?? "") || extra !== undefined || (action === "submit" ? !file : file !== undefined)) {
    throw new Error("Usage: node shipyard-reference.mjs context <port> <handoff-code> or submit <port> <handoff-code> <notes.json>");
  }
  const headers = { authorization: `Bearer ${ticket}` };
  let body;
  if (file) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > 150_000) throw new Error("Provide a local notes JSON file that is smaller than 150 KB.");
    try { body = JSON.stringify(JSON.parse(await readFile(file, "utf8"))); }
    catch { throw new Error("The notes file is not valid JSON."); }
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/reference-handoff`, {
    method: action === "context" ? "GET" : "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5000),
  }).catch(() => { throw new Error("Could not reach the local Shipyard dashboard. Check that it is running and try again."); });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? "The Shipyard handoff is unavailable. Request a fresh handoff in the dashboard.");
  if (action === "context") console.log(JSON.stringify(payload, null, 2));
  else console.log("Returned to Shipyard for review.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
