import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../../..");

function redact(text) {
  return String(text)
    .replace(/([?&]token=)[^\s&#"'<>]+/gi, "$1[redacted]")
    .replace(/\b[0-9a-f]{48}\b/gi, "[redacted]");
}

function command(file, args, options = {}) {
  return spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000, ...options });
}

function xml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function tail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 4096);
    const buffer = Buffer.alloc(size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, length).toString();
    const complete = start ? text.slice(text.includes("\n") ? text.indexOf("\n") + 1 : text.length) : text;
    return redact(complete).trim();
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function main() {
  const [action, ...flags] = process.argv.slice(2);
  if (!["ensure", "open", "check", "diagnose"].includes(action) || flags.some((flag) => flag !== "--demo")) {
    throw new Error("Usage: dashboard.mjs ensure|open|check|diagnose [--demo]");
  }

  const demo = flags.includes("--demo");
  const mode = demo ? "demo" : "standard";
  const root = realpathSync(process.env.SHIPYARD_ROOT || checkout);
  const require = createRequire(join(checkout, "package.json"));
  const cli = ["--import", pathToFileURL(require.resolve("tsx")).href, join(checkout, "src", "cli.ts")];
  const cliOptions = { cwd: checkout, env: { ...process.env, SHIPYARD_ROOT: root } };
  const version = command(process.execPath, [...cli, "ui-link", "--revision"], cliOptions);
  const revision = version.stdout?.trim();
  if (version.status !== 0 || !/^[a-f0-9]{12}$/.test(revision ?? "")) {
    throw new Error("Could not identify the Shipyard dashboard version for this checkout.");
  }

  let lastProbe = `No ${mode} dashboard link was found.`;
  let sawCandidate = false;
  async function probe(candidate) {
    // Mirror the browser's private-link exchange. Fetch does not persist redirect cookies.
    const page = new URL("/", candidate);
    try {
      const entry = await fetch(candidate, { redirect: "manual", signal: AbortSignal.timeout(1500) });
      await entry.body?.cancel();
      const cookie = entry.headers.get("set-cookie")?.split(";", 1)[0];
      if (entry.status !== 302 || entry.headers.get("location") !== "/" || !cookie?.startsWith("shipyard_token=")) {
        lastProbe = `Private link did not authenticate (HTTP ${entry.status}).`;
        return false;
      }
      const headers = { cookie };
      const response = await fetch(page, { headers, redirect: "manual", signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (response.status !== 200) {
        lastProbe = `Dashboard page returned HTTP ${response.status}.`;
        return false;
      }
      const state = await fetch(new URL("/api/state", page), { headers, redirect: "manual", signal: AbortSignal.timeout(1500) });
      if (state.status !== 200) {
        await state.body?.cancel();
        lastProbe = `Dashboard state returned HTTP ${state.status}.`;
        return false;
      }
      const dashboard = await state.json();
      if (dashboard.config?.demo !== demo) {
        lastProbe = "Dashboard mode did not match the request.";
        return false;
      }
      if (dashboard.dashboardRevision !== revision) {
        lastProbe = "The running dashboard belongs to a different Shipyard version.";
        return false;
      }
      return true;
    } catch (error) {
      lastProbe = `Dashboard request failed (${error.cause?.code ?? error.name}).`;
      return false;
    }
  }

  async function findHealthy() {
    const result = command(process.execPath, [...cli, "ui-link"], cliOptions);
    sawCandidate = false;
    lastProbe = result.error
      ? `Could not read dashboard links (${result.error.code ?? "process error"}).`
      : `No ${mode} dashboard link was found.`;
    for (const line of (result.stdout ?? "").split("\n")) {
      const match = line.trim().match(/^(http:\/\/127\.0\.0\.1:\d{1,5}\/\?token=[0-9a-f]{48})(\s+\(demo mode\))?$/);
      if (!match || Boolean(match[2]) !== demo) continue;
      sawCandidate = true;
      try {
        const candidate = new URL(match[1]);
        if (await probe(candidate)) return candidate;
      } catch {
        lastProbe = "Shipyard returned an invalid loopback address.";
      }
    }
    return undefined;
  }

  const checkoutKey = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const label = `dev.shipyard.dashboard.${checkoutKey}.${mode}.${revision}`;
  const domain = `gui/${process.getuid?.()}`;
  const service = `${domain}/${label}`;
  // launchd opens the job files before Node starts. Keep them outside the checkout.
  const stateDir = join(homedir(), "Library", "Application Support", "Shipyard", checkoutKey);
  const plistPath = join(stateDir, `${mode}.${revision}.plist`);
  const logPath = join(stateDir, `${mode}.${revision}.log`);
  const launchctl = (...args) => command("/bin/launchctl", args, { timeout: 15000 });
  const jobStatus = () => launchctl("print", service);
  const describeJob = (job) => {
    const facts = job.stdout?.match(/^\t(?:state|pid|runs|last exit code|last terminating signal) = [^\r\n]+$/gm);
    return facts?.map((line) => line.trim()).join(", ") || "No registered dashboard job";
  };

  function diagnose() {
    console.error(redact(lastProbe));
    if (process.platform === "darwin") console.error(describeJob(jobStatus()));
    const logs = tail(logPath);
    if (logs) console.error(`Startup log (redacted):\n${logs}`);
  }

  function launch() {
    if (process.platform !== "darwin") throw new Error("Automatic dashboard launch requires a verified macOS launch method. A running dashboard can still be checked.");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    closeSync(openSync(logPath, "a", 0o600));

    const existing = jobStatus();
    if (existing.status === 0) {
      if (/^\s*pid = \d+$/m.test(existing.stdout)) return;
      const registeredPath = existing.stdout.match(/^\tpath = (.+)$/m)?.[1];
      if (registeredPath === plistPath) {
        const restarted = launchctl("kickstart", service);
        if (restarted.status === 0) return;
        throw new Error(`Could not start the registered dashboard job: ${redact(restarted.stderr || restarted.error?.code || "launchctl failed").trim()}`);
      }
      const removed = launchctl("bootout", service);
      if (removed.status !== 0 && jobStatus().status === 0) throw new Error("Could not replace the inactive dashboard job.");

    }

    const args = [process.execPath, ...cli, "ui", "--no-open", "--quiet-link", "--port", "0", ...(demo ? ["--demo"] : [])];
    const env = Object.fromEntries(["PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : []));
    env.HOME = homedir();
    env.SHIPYARD_ROOT = root;
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>RunAtLoad</key><true/>
<key>WorkingDirectory</key><string>${xml(checkout)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) =>
      `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`, { mode: 0o600 });
    const loaded = launchctl("bootstrap", domain, plistPath);
    if (loaded.status !== 0 && jobStatus().status !== 0) {
      throw new Error(`Could not load the dashboard LaunchAgent: ${redact(loaded.stderr || loaded.error?.code || "launchctl failed").trim()}`);
    }
  }

  if (action === "diagnose") {
    await findHealthy();
    diagnose();
    return;
  }

  let link = await findHealthy();
  if (action === "ensure" && !link) {
    if (sawCandidate) diagnose();
    try {
      for (let startup = 0; startup < 2 && !link; startup++) {
        launch();
        for (let poll = 0; poll < 10 && !link; poll++) {
          await delay(350);
          link = await findHealthy();
          if (!link) {
            const status = describeJob(jobStatus());
            if (poll >= 2 && status.includes("last exit code") && !status.includes("pid =")) break;
          }
        }
        if (!link) diagnose();
      }
    } catch (error) {
      diagnose();
      throw error;
    }
  }
  if (!link) {
    if (action !== "ensure") diagnose();
    throw new Error(`The ${mode} dashboard did not pass authenticated verification.`);
  }
  if (action === "open") {
    const [browser, args] = process.platform === "darwin" ? ["/usr/bin/open", [link.href]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", link.href]] : ["xdg-open", [link.href]];
    const opened = command(browser, args);
    if (opened.status !== 0) throw new Error("The browser opener could not open the verified dashboard.");
    await delay(650);
    if (!await probe(link)) {
      diagnose();
      throw new Error(`The ${mode} dashboard stopped responding after the browser opened.`);
    }
  }
  const status = action === "open" ? "Opened and rechecked" : "Authenticated HTTP 200 for";
  console.log(`${status} the ${mode} Shipyard dashboard on port ${link.port}.`);
}

try {
  await main();
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
