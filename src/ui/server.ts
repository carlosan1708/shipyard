import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ATTACHMENT_REQUEST_LIMIT } from "../attachments.ts";
import { dirname, join } from "node:path";
import { CODEX_EFFORTS, EFFORTS, SHIPYARD_ROOT, type ShipyardConfig } from "../config.ts";
import { IMPLEMENTERS, OPTIONAL_STAGES, STAGES } from "../pipeline.ts";
import { CHAT_LIMIT, ChatProviderError } from "./chat.ts";
import { CHAT_HISTORY_LIMIT, ChatHistoryInputError } from "./chat-history.ts";
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
  revision?: string;
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
  // An upgraded checkout must not change the UI of a server that still handles the previous API.
  const assets = new Map(Object.entries(STATIC).map(([path, { file, type }]) =>
    [path, { type, content: readFileSync(join(uiDir, file)) }] as const));
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
      if (req.method === "GET" && url.pathname === "/styles.css") return sendAsset(res, assets.get("/styles.css")!);

      // Opening the printed link: trade the token in the URL for a cookie, then drop it from the address bar.
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
        if (!sameToken(url.searchParams.get("token")!, token)) return signInPage(res, true);
        res.writeHead(302, { "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`, location: "/" });
        return res.end();
      }
      // The desktop helper holds a short-lived ticket for one reference, never a dashboard session.
      if (url.pathname === "/api/reference-handoff") {
        if (req.headers.origin) return json(res, 403, { error: "Use the local Shipyard handoff helper." });
        const ticket = req.headers.authorization?.match(/^Bearer ([0-9a-f]{48})$/)?.[1];
        if (!ticket) return json(res, 401, { error: "A Shipyard handoff code is required." });
        if (req.method === "GET") return json(res, 200, opts.manager.referenceHandoffContext(ticket));
        if (req.method === "POST") {
          opts.manager.returnReferenceHandoff(ticket, await readJson(req));
          return json(res, 200, { received: true });
        }
        return json(res, 405, { error: "Choose context or submit." });
      }

      const presented = cookie(req.headers.cookie, COOKIE) ?? (req.headers["x-shipyard-token"] as string | undefined);
      if (!presented || !sameToken(presented, token)) {
        return url.pathname.startsWith("/api/") ? json(res, 401, { error: "Not signed in to this shipyard session" }) : signInPage(res, false);
      }
      if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return json(res, 403, { error: "Cross-origin request refused" });
      }

      const asset = assets.get(url.pathname);
      if (req.method === "GET" && asset) return sendAsset(res, asset);

      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(res, 200, {
          config: { ...opts.config, demo: Boolean(opts.demo), canAddTargets: opts.manager.canAddTargets, canCloneTargets: opts.manager.canAddTargets },
          acceptsAttachments: true,
          chatProviders: opts.manager.chatProviders(),
          feedbackReusesBranch: true,
          dashboardRevision: opts.revision,
          efforts: EFFORTS,
          codexEfforts: CODEX_EFFORTS,
          roles: opts.manager.roles(),
          stages: STAGES,
          optionalStages: OPTIONAL_STAGES,
          implementers: IMPLEMENTERS,
          targets: opts.manager.targets().map((t) => ({ name: t.name, path: t.path, e2e: Boolean(t.e2e), browserAccess: t.browserAccess })),
          runs: opts.manager.store.list(),
          active: opts.manager.activeRunIds(),
          inbox: opts.manager.inbox(),
          referenceHandoffs: opts.manager.referenceHandoffStatuses(),
        });
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === "GET" && runMatch) {
        const run = opts.manager.store.get(runMatch[1]!);
        if (!run) return json(res, 404, { error: "No such run" });
        return json(res, 200, { run, events: opts.manager.store.events(run.id, 3000) });
      }

      if (req.method === "PATCH" && runMatch) {
        const body = await readJson(req) as { archived?: unknown; acknowledgeCompletion?: unknown };
        if (typeof body?.archived === "boolean") return json(res, 200, { run: opts.manager.setArchived(runMatch[1]!, body.archived) });
        if (typeof body?.acknowledgeCompletion === "string") return json(res, 200, { run: opts.manager.acknowledgeCompletion(runMatch[1]!, body.acknowledgeCompletion) });
        throw new UserError("Choose an archive or completion action");
      }

      if (req.method === "DELETE" && runMatch) {
        const body = await readJson(req) as { confirm?: unknown };
        if (body?.confirm !== true) throw new UserError("Confirm deletion of run history");
        await opts.manager.deleteHistory(runMatch[1]!);
        return json(res, 200, { deleted: true });
      }

      const resultMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/result$/);
      if (req.method === "GET" && resultMatch) {
        const runId = resultMatch[1]!;
        return json(res, 200, url.searchParams.get("head") === "1" ? { head: await opts.manager.resultHead(runId) } : await opts.manager.result(runId));
      }

      const remoteMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/remote$/);
      if (req.method === "POST" && remoteMatch) {
        const body = await readJson(req) as { url?: unknown };
        await opts.manager.connectRemote(remoteMatch[1]!, body?.url);
        return json(res, 200, { hasRemote: true });
      }

      const publishMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/(publish|pull-request)$/);
      if (req.method === "POST" && publishMatch) {
        const body = await readJson(req) as { head?: unknown; destination?: unknown; draft?: unknown };
        await opts.manager.publish(publishMatch[1]!, body ?? {}, publishMatch[2] === "pull-request" ? "pull-request" : "push");
        return json(res, 200, await opts.manager.result(publishMatch[1]!));
      }

      const draftMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/draft-pull-request$/);
      if (req.method === "POST" && draftMatch) {
        const body = (await readJson(req) ?? {}) as Parameters<RunManager["draftPullRequest"]>[1];
        return json(res, 200, await opts.manager.draftPullRequest(draftMatch[1]!, body));
      }

      const cloudReleaseMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/cloud-release$/);
      if (req.method === "POST" && cloudReleaseMatch) {
        if (opts.demo) throw new UserError("Google Cloud deployment is unavailable in demo mode");
        const body = await readJson(req) as Record<string, unknown> | null;
        return json(res, 200, await opts.manager.cloudRelease(cloudReleaseMatch[1]!, body ?? {}));
      }

      const deploymentMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/(deployment|firebase-release)$/);
      if (req.method === "POST" && deploymentMatch) {
        if (opts.demo) throw new UserError("Deployment is unavailable in demo mode");
        const body = await readJson(req, 4_000) as Record<string, unknown> | null;
        return json(res, 200, opts.manager.deployment(deploymentMatch[1]!,
          deploymentMatch[2] === "firebase-release" ? { ...body, provider: "firebase" } : body ?? {}));
      }

      const browserMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/browser-check$/);
      if (req.method === "POST" && browserMatch) {
        return json(res, 200, { check: await opts.manager.checkLocalBrowser(browserMatch[1]!) });
      }

      const questionMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/question$/);
      if (req.method === "POST" && questionMatch) {
        const body = await readJson(req, 4_000) as { question?: unknown } | null;
        return json(res, 200, await opts.manager.answerRunQuestion(questionMatch[1]!, body?.question));
      }

      const verifyMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/verify$/);
      if (req.method === "POST" && verifyMatch) {
        return json(res, 200, { verification: await opts.manager.verifyResult(verifyMatch[1]!) });
      }

      const referencesMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/references$/);
      if (req.method === "POST" && referencesMatch) {
        const body = await readJson(req) as { referenceUrls?: unknown };
        return json(res, 200, { run: await opts.manager.checkResultReferences(referencesMatch[1]!, body?.referenceUrls) });
      }

      const handoffMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/references\/handoff$/);
      if (handoffMatch && (req.method === "POST" || req.method === "DELETE")) {
        const body = await readJson(req) as { url?: unknown; itemId?: unknown };
        if (req.method === "POST") return json(res, 200, opts.manager.openReferenceHandoff(handoffMatch[1]!, body ?? {}, port));
        opts.manager.cancelReferenceHandoff(handoffMatch[1]!, body ?? {});
        return json(res, 200, { canceled: true });
      }

      const sharedReferenceMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/references\/shared$/);
      if (req.method === "POST" && sharedReferenceMatch) {
        const body = await readJson(req, ATTACHMENT_REQUEST_LIMIT) as { url?: unknown; text?: unknown; attachments?: unknown };
        return json(res, 200, { run: opts.manager.saveSharedReference(sharedReferenceMatch[1]!, body?.url, body?.text, body?.attachments) });
      }

      const feedbackMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/(feedback|design)$/);
      if (req.method === "POST" && feedbackMatch) {
        const body = await readJson(req, ATTACHMENT_REQUEST_LIMIT) as Parameters<RunManager["startFollowUp"]>[1];
        return json(res, 201, { id: await opts.manager.startFollowUp(feedbackMatch[1]!, body ?? {}) });
      }

      const branchPreparation = url.pathname.match(/^\/api\/runs\/([\w-]+)\/prepare-branch$/);
      if (branchPreparation && (req.method === "GET" || req.method === "POST")) {
        const approval = req.method === "POST" ? (await readJson(req) ?? {}) as { name?: unknown; head?: unknown; base?: unknown; confirm?: unknown } : undefined;
        return json(res, 200, await opts.manager.prepareBranch(branchPreparation[1]!, approval));
      }

      const previewMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/preview$/);
      const localAppMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/local-app$/);
      if (req.method === "POST" && localAppMatch) {
        return json(res, 200, { url: await opts.manager.startLocalApp(localAppMatch[1]!) });
      }
      if (req.method === "DELETE" && localAppMatch) {
        await opts.manager.stopLocalApp(localAppMatch[1]!);
        return json(res, 200, { stopped: true });
      }
      if (req.method === "POST" && previewMatch) {
        return json(res, 200, { url: await opts.manager.startLocalPreview(previewMatch[1]!) });
      }
      if (req.method === "DELETE" && previewMatch) {
        await opts.manager.stopLocalPreview(previewMatch[1]!);
        return json(res, 200, { stopped: true });
      }

      const resumeMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/(resume|recheck|fix)$/);
      if (req.method === "POST" && resumeMatch) {
        const body = await readJson(req) as { budgetUsd?: unknown } | null;
        opts.manager.resume(resumeMatch[1]!, resumeMatch[2] as "resume" | "recheck" | "fix", body?.budgetUsd);
        return json(res, 202, { accepted: true });
      }

      const controlMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/control$/);
      if (req.method === "POST" && controlMatch) {
        const body = await readJson(req, ATTACHMENT_REQUEST_LIMIT) as Parameters<RunManager["controlRun"]>[1];
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

      if (req.method === "GET" && url.pathname === "/api/chat/history") return json(res, 200, { chats: opts.manager.chatHistory.list() });

      const chatMatch = url.pathname.match(/^\/api\/chat\/history\/([a-f0-9-]+)$/i);
      if (chatMatch && req.method === "GET") {
        const chat = opts.manager.chatHistory.get(chatMatch[1]!);
        return chat ? json(res, 200, { chat }) : json(res, 404, { error: "Chat not found", code: "chat-not-found" });
      }
      if (chatMatch && req.method === "PATCH") {
        const body = await readJson(req, CHAT_HISTORY_LIMIT);
        return json(res, 200, { chat: opts.manager.chatHistory.save(chatMatch[1]!, body) });
      }

      if (req.method === "POST" && url.pathname === "/api/chat/attachments") {
        const body = await readJson(req, ATTACHMENT_REQUEST_LIMIT) as { attachments?: unknown } | null;
        return json(res, 201, opts.manager.uploadChatAttachments(body?.attachments));
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = (await readJson(req, CHAT_LIMIT) ?? {}) as Parameters<RunManager["chat"]>[0];
        const disconnected = new AbortController();
        res.once("close", () => disconnected.abort());
        const reply = await opts.manager.chat(body, disconnected.signal);
        if (!disconnected.signal.aborted) return json(res, 200, reply);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/runs") {
        const body = (await readJson(req, ATTACHMENT_REQUEST_LIMIT)) as Partial<StartRequest>;
        const id = opts.manager.start({
          target: String(body.target ?? ""),
          kind: String(body.kind ?? "") as StartRequest["kind"], // validated by the manager
          request: String(body.request ?? ""),
          attachments: body.attachments,
          chatAttachmentIds: body.chatAttachmentIds,
          parallelReviews: body.parallelReviews,
          checkpoints: (Array.isArray(body.checkpoints) ? body.checkpoints.map(String) : []) as StartRequest["checkpoints"],
          // Validated by the manager.
          provider: body.provider === undefined ? undefined : String(body.provider),
          model: body.model ? String(body.model) : undefined,
          effort: body.effort ? (String(body.effort) as StartRequest["effort"]) : undefined,
          crew: (Array.isArray(body.crew) ? body.crew.map(String) : undefined) as StartRequest["crew"],
          implementer: body.implementer ? (String(body.implementer) as StartRequest["implementer"]) : undefined,
          browserAccess: body.browserAccess,
          referenceUrls: body.referenceUrls,
          browserReferenceHelp: body.browserReferenceHelp,
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

      if (req.method === "POST" && url.pathname === "/api/targets/clone") {
        const body = await readJson(req) as { url?: unknown };
        return json(res, 200, await opts.manager.cloneTarget(body?.url));
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
        opts.manager.answer(inboxMatch[1]!, (await readJson(req, ATTACHMENT_REQUEST_LIMIT)) as InboxAnswer);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "Not found" });
    } catch (err) {
      if (res.destroyed) return;
      if (err instanceof ChatProviderError) return json(res, err.status, { error: err.message, code: err.code });
      if (err instanceof ChatHistoryInputError) return json(res, 400, { error: err.message });
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

function sendAsset(res: http.ServerResponse, asset: { content: Buffer; type: string }): void {
  res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...SECURITY_HEADERS });
  res.end(asset.content);
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

async function readJson(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new UserError("Request body too large");
    chunks.push(buffer);
  }
  try {
    return bytes ? JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) : {};
  } catch {
    throw new UserError("Body must be JSON");
  }
}
