import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { CODEX_EFFORTS, EFFORTS, SHIPYARD_ROOT, type ShipyardConfig } from "../config.ts";
import { IMPLEMENTERS, OPTIONAL_STAGES, STAGES } from "../pipeline.ts";
import { UserError, type InboxAnswer, type LiveMessage, type RunManager, type StartRequest } from "./manager.ts";

export const UI_DIR = join(SHIPYARD_ROOT, "ui");

/** The only files the server will ever send. No path from the URL touches the filesystem. */
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

export interface UiServerOptions {
  manager: RunManager;
  config: Pick<ShipyardConfig, "model" | "models" | "effort" | "auth"> & Partial<Pick<ShipyardConfig, "maxBudgetUsdPerRun" | "maxBudgetUsdPerStage" | "defaultProvider" | "codex">>;
  port?: number;
  /** Fixed token (tests). Random when unset. */
  token?: string;
  demo?: boolean;
  uiDir?: string;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const COOKIE = "shipyard_token";

/**
 * The UI token, kept across restarts so open tabs keep working when `shipyard ui` restarts.
 * Stored owner-read/write only; `rotate` makes a new one (and signs out every open tab).
 */
export function loadOrCreateToken(file: string, rotate = false): string {
  if (!rotate && existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(saved)) return saved;
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/**
 * The local web UI. Listens on 127.0.0.1 only. Every request needs the session token (from the
 * printed link, then a SameSite=Strict cookie); the Host header must be this server, which stops
 * DNS-rebinding pages; and writes must come from this origin.
 */
export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const uiDir = opts.uiDir ?? UI_DIR;
  const clients = new Set<http.ServerResponse>();
  let port = 0;

  const broadcast = (message: LiveMessage) => {
    const frame = `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  opts.manager.bus.on("message", broadcast);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host ?? "")) return text(res, 403, "Forbidden host");

      // The stylesheet is public, so the sign-in page below can use it. It holds no data.
      if (req.method === "GET" && url.pathname === "/styles.css") return sendAsset(res, STATIC["/styles.css"]!, uiDir);

      // Opening the printed link: trade the token in the URL for a cookie, then drop it from the address bar.
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
        if (!sameToken(url.searchParams.get("token")!, token)) return signInPage(res, true);
        res.writeHead(302, { "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, location: "/" });
        return res.end();
      }
      const presented = cookie(req.headers.cookie, COOKIE) ?? (req.headers["x-shipyard-token"] as string | undefined);
      if (!presented || !sameToken(presented, token)) {
        return url.pathname.startsWith("/api/") ? json(res, 401, { error: "Not signed in to this shipyard session" }) : signInPage(res, false);
      }
      if (req.method === "POST" || req.method === "PATCH") {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return json(res, 403, { error: "Cross-origin request refused" });
      }

      const asset = STATIC[url.pathname];
      if (req.method === "GET" && asset) return sendAsset(res, asset, uiDir);

      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(res, 200, {
          config: { ...opts.config, demo: Boolean(opts.demo), canAddTargets: opts.manager.canAddTargets },
          efforts: EFFORTS,
          codexEfforts: CODEX_EFFORTS,
          roles: opts.manager.roles(),
          stages: STAGES,
          optionalStages: OPTIONAL_STAGES,
          implementers: IMPLEMENTERS,
          targets: opts.manager.targets().map((t) => ({ name: t.name, path: t.path, e2e: Boolean(t.e2e) })),
          runs: opts.manager.store.list(),
          active: opts.manager.activeRunIds(),
          inbox: opts.manager.inbox(),
        });
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === "GET" && runMatch) {
        const run = opts.manager.store.get(runMatch[1]!);
        if (!run) return json(res, 404, { error: "No such run" });
        return json(res, 200, { run, events: opts.manager.store.events(run.id, 3000) });
      }

      if (req.method === "PATCH" && runMatch) {
        const body = await readJson(req) as { archived?: unknown };
        if (typeof body?.archived !== "boolean") throw new UserError("archived must be true or false");
        return json(res, 200, { run: opts.manager.setArchived(runMatch[1]!, body.archived) });
      }

      const controlMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/control$/);
      if (req.method === "POST" && controlMatch) {
        const body = await readJson(req) as Parameters<RunManager["controlRun"]>[1];
        opts.manager.controlRun(controlMatch[1]!, body ?? {});
        return json(res, 202, { accepted: true });
      }

      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        clients.add(res);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/runs") {
        const body = (await readJson(req)) as Partial<StartRequest>;
        const id = opts.manager.start({
          target: String(body.target ?? ""),
          kind: String(body.kind ?? "") as StartRequest["kind"], // validated by the manager
          request: String(body.request ?? ""),
          checkpoints: (Array.isArray(body.checkpoints) ? body.checkpoints.map(String) : []) as StartRequest["checkpoints"],
          // Validated by the manager.
          provider: body.provider === undefined ? undefined : String(body.provider),
          model: body.model ? String(body.model) : undefined,
          effort: body.effort ? (String(body.effort) as StartRequest["effort"]) : undefined,
          crew: (Array.isArray(body.crew) ? body.crew.map(String) : undefined) as StartRequest["crew"],
          implementer: body.implementer ? (String(body.implementer) as StartRequest["implementer"]) : undefined,
          budgetUsd: body.budgetUsd === undefined || body.budgetUsd === null ? undefined : Number(body.budgetUsd),
        });
        return json(res, 201, { id });
      }

      if (req.method === "GET" && url.pathname === "/api/targets/suggestions") {
        return json(res, 200, { repos: opts.manager.canAddTargets ? opts.manager.repoSuggestions() : [] });
      }

      if (req.method === "POST" && url.pathname === "/api/targets/inspect") {
        const body = (await readJson(req)) as { path?: unknown };
        return json(res, 200, await opts.manager.inspectRepo(String(body.path ?? "")));
      }

      if (req.method === "POST" && url.pathname === "/api/targets") {
        const body = (await readJson(req)) as Record<string, unknown>;
        const target = await opts.manager.addTarget({
          name: String(body.name ?? ""),
          path: String(body.path ?? ""),
          test: String(body.test ?? ""),
          e2e: body.e2e ? String(body.e2e) : undefined,
        });
        return json(res, 201, { target: { name: target.name, path: target.path, e2e: Boolean(target.e2e) } });
      }

      const inboxMatch = url.pathname.match(/^\/api\/inbox\/([\w-]+)$/);
      if (req.method === "POST" && inboxMatch) {
        opts.manager.answer(inboxMatch[1]!, (await readJson(req)) as InboxAnswer);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof UserError) return json(res, 400, { error: err.message });
      console.error(err);
      return json(res, 500, { error: "Internal error" });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: async () => {
      opts.manager.bus.off("message", broadcast);
      for (const res of clients) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

function sendAsset(res: http.ServerResponse, asset: { file: string; type: string }, uiDir: string): void {
  res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...SECURITY_HEADERS });
  res.end(readFileSync(join(uiDir, asset.file)));
}

/** Shown instead of the app when this browser has no (or an old) token. Static text only. */
function signInPage(res: http.ServerResponse, wrongToken: boolean): void {
  const lead = wrongToken
    ? "That link is from an earlier session, or the token in it is wrong."
    : "This browser isn't signed in to the shipyard ui running on this port, or it was signed in to an earlier session.";
  res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>shipyard · open your link</title><link rel="stylesheet" href="/styles.css"></head>
<body><div class="empty">
<h1>Open your shipyard link</h1>
<p>${lead} For safety, only the link with this session's private token gets in.</p>
<p>It's printed in the terminal where <code>shipyard ui</code> is running, and ends in <code>?token=…</code>.</p>
<p class="field-help">Lost it? In the shipyard folder, run <code>npm run shipyard -- ui-link</code> to print it again.</p>
</div></body></html>`);
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new UserError("Request body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new UserError("Body must be JSON");
  }
}
