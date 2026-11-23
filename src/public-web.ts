import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) privateAddresses.addSubnet(address, prefix);
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  privateAddresses.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

function publicAddress({ address, family }: { address: string; family: number }): boolean {
  if (family === 4) return !privateAddresses.check(address);
  return family === 6 && globalV6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6");
}

function readResponse(url: URL, address: string, family: number, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    // Pin the resolved address so a second DNS lookup cannot change the destination.
    const req = request(url, { method: "GET", family, lookup: (_host, _opts, done) => done(null, address, family),
      agent: false, signal, headers: { accept: "text/html, text/plain, application/json", "user-agent": "Shipyard public web reader" } }, resolve);
    req.once("error", reject);
    req.end();
  });
}

/** Fetch text without cookies, credentials, request bodies, or access to private networks. */
export async function readPublicPage(link: string, signal?: AbortSignal, raw = false): Promise<{ url: string; text: string; truncated: boolean }> {
  const timeout = AbortSignal.timeout(12_000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = new URL(link);
  for (let hops = 0; hops <= 5; hops++) {
    stop.throwIfAborted();
    const credential = [...url.searchParams.keys()].some((key) => /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|key|password|sig(?:nature)?|token|x-amz-.+|x-goog-.+)$/i.test(key));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || credential || url.href.length > 2048) {
      throw new Error("Use a public HTTP or HTTPS URL without credentials or a custom port.");
    }
    url.hash = "";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(hostname);
    if (!family && !hostname.replace(/\.$/, "").includes(".")) throw new Error("Use a public website hostname.");
    const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
    const chosen = addresses.find(({ family }) => family === 4) ?? addresses[0];
    if (!chosen || addresses.some((address) => !publicAddress(address))) throw new Error("Local, private, and reserved network addresses are unavailable.");
    const response = await readResponse(url, chosen.address, chosen.family, stop);
    try {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        url = new URL(response.headers.location, url);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`Website returned HTTP ${status}.`);
      const type = response.headers["content-type"] ?? "";
      if (!/^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|xhtml\+xml)\b)/i.test(type)) {
        throw new Error("The public web reader only accepts text, HTML, JSON, and XML.");
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response) {
        const remaining = 768_000 - length;
        chunks.push(chunk.subarray(0, remaining));
        length += Math.min(chunk.length, remaining);
        if (length >= 768_000) break;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const text = !raw && /html/i.test(type) ? body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[^]*?-->/g, " ").replace(/<\/(?:p|li|div|h[1-6]|section)>/gi, "\n").replace(/<[^>]+>/g, " ")
        .split("\n").map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n") : body;
      return { url: url.href, text: raw ? text : text.slice(0, 20_000), truncated: length >= 768_000 || (!raw && text.length > 20_000) };
    } finally {
      response.destroy();
    }
  }
  throw new Error("Too many website redirects.");
}
