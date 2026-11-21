import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecResult } from "./exec.ts";
import { canPreview, startPreview } from "./ui/preview.ts";

export const BROWSER_CHECK = "Chrome browser check (desktop and phone)";

const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function findChrome(): string | undefined { return BROWSERS.find(existsSync); }

export interface BrowserInspection {
  viewport: "desktop" | "phone";
  activate?: string;
}

interface BrowserResult extends ExecResult {
  screenshot?: string;
}

/** The host owns Chrome and the preview. Agent permissions and browser sandboxing stay in force. */
export async function checkBrowser(worktree: string, timeoutMs = 25_000, signal?: AbortSignal, inspection?: BrowserInspection): Promise<BrowserResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(Math.min(timeoutMs, 25_000));
  const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const output: string[] = [];
  let code = 1;
  let screenshot: string | undefined;
  try {
    stop.throwIfAborted();
    if (!canPreview(worktree)) throw new Error("Browser verification needs a static site with an index.html at the worktree root.");
    const executable = findChrome();
    if (!executable) throw new Error("Install Chrome or Chromium on the Shipyard host to run browser verification.");
    const preview = await startPreview(worktree);
    try {
      ({ code, screenshot } = await renderPreview(executable, preview.url, output, stop, inspection));
    } finally {
      await preview.close();
    }
  } catch (error) {
    if (signal?.aborted) output.push("Browser verification was stopped.");
    else if (timeout.aborted) output.push("Chrome did not finish before the browser check timed out.");
    else output.push(error instanceof Error ? error.message : "Browser verification failed.");
    code = signal?.aborted ? 130 : timeout.aborted ? 124 : 1;
  }
  const text = output.join("\n").replace(/\b[0-9a-f]{48}\b/gi, "[redacted]");
  return { command: BROWSER_CHECK, code, output: text, durationMs: Date.now() - started, timedOut: code === 124, screenshot };
}

async function renderPreview(executable: string, url: string, output: string[], stop: AbortSignal, inspection?: BrowserInspection) {
  const profile = mkdtempSync(join(tmpdir(), "shipyard-chrome-"));
  const localAddress = new URL(url).host;
  // The preview rejects proxy requests for other hosts. Only its own origin bypasses the proxy.
  const chrome = spawn(executable, [
    "--headless", "--no-first-run", "--disable-background-networking", "--disable-extensions",
    "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--proxy-server=http://${localAddress}`, `--proxy-bypass-list=<-loopback>;${localAddress}`,
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore", detached: true });
  let exited = false;
  const closed = new Promise<void>((resolve) => chrome.once("close", () => { exited = true; resolve(); }));
  chrome.on("error", () => { exited = true; });
  let socket: WebSocket | undefined;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    while (!existsSync(portFile)) {
      if (exited) throw new Error("Chrome exited during startup. Check the host browser installation.");
      await delay(75, undefined, { signal: stop });
    }
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Chrome did not expose its local debugging port.");
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: stop });
    if (!response.ok) throw new Error("Chrome’s local debugging service was unavailable.");
    const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome opened without a page to check.");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    const call = await connectChrome<PreviewReply>(socket, stop);
    const problems = new Set<string>();
    const origin = new URL(url).origin;
    socket.addEventListener("message", ({ data }) => {
      const event = JSON.parse(String(data));
      if (event.method === "Runtime.exceptionThrown") {
        const detail = event.params.exceptionDetails;
        problems.add(`JavaScript error: ${String(detail.exception?.description ?? detail.text).split("\n")[0]!.slice(0, 300)}`);
      }
      if (event.method === "Network.responseReceived") {
        const { type, response } = event.params;
        if (response.status >= 400 && response.url.startsWith(`${origin}/`) && ["Document", "Script", "Stylesheet", "Image", "Fetch", "XHR"].includes(type)) {
          const path = new URL(response.url).pathname;
          if (path !== "/favicon.ico") problems.add(`${type} returned HTTP ${response.status}: ${path}`);
        }
      }
    });
    await call("Runtime.enable");
    await call("Network.enable");
    let passed = true;
    let screenshot: string | undefined;
    const viewports = [[1440, 900], [390, 844]] as const;
    for (const [width, height] of inspection ? [viewports[inspection.viewport === "phone" ? 1 : 0]] : viewports) {
      await call("Page.navigate", { url: "about:blank" });
      problems.clear();
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width === 390 });
      const navigation = await call("Page.navigate", { url });
      if (navigation.errorText) throw new Error("Chrome could not open the authenticated local preview.");
      const inspect = async () => {
        const evaluation = await call("Runtime.evaluate", {
          expression: `({ url: location.origin, ready: document.readyState, body: !!(document.body?.children.length || document.body?.textContent.trim()), width: innerWidth, scrollWidth: document.documentElement?.scrollWidth })`,
          returnByValue: true,
        }).catch((error: unknown) => {
          if (stop.aborted || socket?.readyState !== WebSocket.OPEN) throw error;
          return undefined;
        });
        const value = evaluation?.result?.value;
        return typeof value === "object" ? value : undefined;
      };
      let page = await inspect();
      while (page?.url !== origin || page.ready !== "complete") {
        await delay(75, undefined, { signal: stop });
        page = await inspect();
      }
      if (inspection?.activate) {
        const label = JSON.stringify(inspection.activate);
        const action = await call("Runtime.evaluate", { expression: `(() => {
          const label = ${label};
          const matches = [...document.querySelectorAll('button, summary, a[href], [role="button"]')].filter(el =>
            el.getClientRects().length && !el.closest('[hidden], [inert]') && el.getAttribute('aria-disabled') !== 'true' && !el.disabled &&
            (el.getAttribute('aria-label') || el.innerText).trim() === label);
          if (matches.length !== 1) return false;
          const el = matches[0];
          if (el.matches('a') && (new URL(el.href).origin !== location.origin || el.target === '_blank')) return false;
          el.click();
          return true;
        })()`, returnByValue: true });
        if (action.result?.value !== true) problems.add("That label did not identify one visible local control.");
      }
      await delay(250, undefined, { signal: stop });
      page = await inspect();
      if (page?.url !== origin || page.ready !== "complete" || !page.body) problems.add("The local page did not render content.");
      if (page && (page.width > width || page.scrollWidth > page.width + 1)) problems.add("The content overflows the viewport horizontally.");
      output.push(`${width} × ${height}: ${problems.size ? "failed" : "rendered"}`, ...problems);
      passed &&= problems.size === 0;
      if (inspection && page?.url === origin && page.ready === "complete") {
        const snapshot = await call("Runtime.evaluate", { expression: "document.title + '\\n' + document.body.innerText.trim().slice(0, 1800)", returnByValue: true });
        const text = snapshot.result?.value;
        if (typeof text === "string" && text.trim()) output.push("Visible page text:", text);
        const capture = await call("Page.captureScreenshot", { format: "jpeg", quality: 65, captureBeyondViewport: false });
        if (capture.data && capture.data.length < 1_500_000) screenshot = capture.data;
      }
    }
    return { code: passed ? 0 : 1, screenshot };
  } finally {
    socket?.close();
    if (!exited && chrome.pid) {
      try { process.kill(-chrome.pid, "SIGTERM"); } catch { chrome.kill(); }
      await Promise.race([closed, delay(750, undefined, { ref: false })]);
      if (!exited) {
        try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); }
      }
    }
    await closed;
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

type PreviewPageState = { url: string; ready: string; body: boolean; width: number; scrollWidth: number };
type PreviewReply = { errorText?: string; result?: { value?: PreviewPageState | boolean | string }; data?: string };

async function connectChrome<Reply>(socket: WebSocket, stop: AbortSignal) {
  stop.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      stop.removeEventListener("abort", aborted);
    };
    const opened = () => { clear(); resolve(); };
    const failed = () => { clear(); reject(new Error("Could not connect to the local Chrome page.")); };
    const aborted = () => { clear(); reject(stop.reason); };
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    stop.addEventListener("abort", aborted);
  });
  let sequence = 0;
  return (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    stop.throwIfAborted();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const clear = () => {
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", closed);
        stop.removeEventListener("abort", aborted);
      };
      const closed = () => { clear(); reject(new Error("The local Chrome page closed during browser verification.")); };
      const aborted = () => { clear(); reject(stop.reason); };
      const receive = ({ data }: MessageEvent) => {
        const message = JSON.parse(String(data));
        if (message.id !== id) return;
        clear();
        if (message.error) reject(new Error(`Chrome could not complete ${method}.`));
        else resolve(message.result);
      };
      socket.addEventListener("message", receive);
      socket.addEventListener("close", closed, { once: true });
      stop.addEventListener("abort", aborted, { once: true });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}
