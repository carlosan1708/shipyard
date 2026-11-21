import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface LocalPreview {
  url: string;
  close(): Promise<void>;
}

export function canPreview(worktree: string): boolean {
  try {
    const root = realpathSync(worktree);
    const entry = join(root, "index.html");
    return realpathSync(entry) === entry && statSync(entry).isFile();
  } catch {
    return false;
  }
}

/** Serve the static output from a completed worktree on an origin separate from the dashboard. */
export async function startPreview(worktree: string): Promise<LocalPreview> {
  const root = await realpath(worktree);
  const token = randomBytes(24).toString("hex");
  const cookie = `shipyard_preview_${token.slice(0, 8)}`;
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const origin = `http://[::1]:${port}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'");
    if (req.headers.host !== `[::1]:${port}` || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(403).end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", origin);
      if (url.origin !== origin) {
        res.writeHead(403).end();
        return;
      }
      if (url.pathname === "/" && url.searchParams.get("preview") === token) {
        res.writeHead(302, { "Set-Cookie": `${cookie}=${token}; HttpOnly; SameSite=Lax; Path=/`, Location: "/" }).end();
        return;
      }
      if (!req.headers.cookie?.split(";").some((entry) => entry.trim() === `${cookie}=${token}`)) {
        res.writeHead(401).end("Open the preview link from the Shipyard dashboard.");
        return;
      }
      const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
      if (parts.some((part) => part.startsWith(".") || part.includes("\\") || part === "node_modules")) {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname.endsWith("/")) parts.push("index.html");
      const file = await realpath(join(root, ...parts));
      const path = relative(root, file);
      const type = TYPES[extname(file).toLowerCase()];
      if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ||
          path.split(sep).some((part) => part.startsWith(".") || part === "node_modules") || !type || !(await stat(file)).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": type });
      if (req.method === "HEAD") res.end();
      else await pipeline(createReadStream(file), res);
    } catch {
      if (!res.headersSent) res.writeHead(404).end();
      else res.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://[::1]:${port}/?preview=${token}`,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
