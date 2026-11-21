import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { checkBrowser } from "./browser-check.ts";

export const BROWSER_SERVER = "shipyard_browser";
export const BROWSER_TOOL = "inspect_preview";
export const BROWSER_TOKEN_ENV = "SHIPYARD_BROWSER_TOOL_TOKEN";
export const BROWSER_TOOL_NOTE = "When you need to see the rendered app, use Shipyard’s inspect_preview browser tool. It can take a desktop or phone screenshot and activate a visible local control by label. It opens this worktree’s static preview in an isolated Chrome session.";

const PREVIEW: Tool = {
  name: BROWSER_TOOL,
  title: "Inspect the local preview",
  description: "Open the static app in this run’s worktree. Returns a screenshot, visible page text, and browser errors. Optionally activate one local control by its visible text or aria-label before inspecting.",
  inputSchema: {
    type: "object",
    properties: { viewport: { type: "string", enum: ["desktop", "phone"] }, activate: { type: "string", maxLength: 140 } },
    required: ["viewport"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const refusal = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

export function startBrowserTool(worktree: string, signal?: AbortSignal, onInspection?: (detail: string) => void) {
  return startPrivateTool(PREVIEW, signal, async (args, stop) => {
    const { viewport, activate } = args;
    if ((viewport !== "desktop" && viewport !== "phone") ||
      (activate !== undefined && (typeof activate !== "string" || !activate.trim() || activate.length > 140)) ||
      Object.keys(args).some((key) => key !== "viewport" && key !== "activate")) {
      return refusal("Choose desktop or phone and optionally supply one visible control label.");
    }
    const result = await checkBrowser(worktree, undefined, stop, { viewport, activate: activate?.trim() });
    onInspection?.(`${viewport === "phone" ? "Phone" : "Desktop"} preview · ${result.code === 0 ? "rendered" : "inspection reported a problem"}`);
    return { isError: !result.screenshot && result.code !== 0, content: [
      { type: "text", text: result.output },
      ...(result.screenshot ? [{ type: "image" as const, mimeType: "image/jpeg", data: result.screenshot }] : []),
    ] };
  });
}

/** Each attempt gets a private loopback endpoint with just its approved tool. */
async function startPrivateTool(tool: Tool, signal: AbortSignal | undefined, handler: (args: Record<string, unknown>, stop: AbortSignal) => Promise<CallToolResult>) {
  signal?.throwIfAborted();
  const token = randomBytes(24).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const lifetime = new AbortController();
  const stop = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let host = "";
  let working: Promise<CallToolResult> | undefined;

  const listener = http.createServer(async (req, res) => {
    const presented = Buffer.from(req.headers.authorization ?? "");
    if (req.headers.host !== host || req.headers.origin) return void res.writeHead(403).end();
    if (presented.length !== authorization.length || !timingSafeEqual(presented, authorization)) return void res.writeHead(401).end();
    if (req.url !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();

    const server = new Server({ name: BROWSER_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      if (params.name !== tool.name) return refusal("Unknown Shipyard browser tool.");
      if (stop.aborted) return refusal("This Shipyard attempt has ended.");
      if (working) return refusal("Wait for the current browser inspection to finish.");
      working = handler(params.arguments ?? {}, AbortSignal.any([stop, extra.signal]));
      try { return await working; }
      catch (error) { return refusal(error instanceof Error ? error.message : "Browser operation failed."); }
      finally { working = undefined; }
    });
    res.once("close", () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { listener.off("error", reject); resolve(); });
  });
  host = `127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return {
    url: `http://${host}/mcp`,
    token,
    async close() {
      lifetime.abort();
      const closed = new Promise<void>((resolve) => listener.close(() => resolve()));
      listener.closeAllConnections();
      await Promise.allSettled([closed, working]);
    },
  };
}
