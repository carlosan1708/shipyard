import http from "node:http";
import { createCatalog, NotFoundError, OutOfStockError, ValidationError } from "./catalog.js";
import { createCart } from "./cart.js";

/** Build the HTTP API. One catalog and one cart per app instance. */
export function createApp({ products } = {}) {
  const catalog = createCatalog(products);
  const cart = createCart(catalog);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /products") {
        const page = intParam(url.searchParams.get("page"), 1);
        const pageSize = intParam(url.searchParams.get("pageSize"), 2);
        return send(res, 200, catalog.list({ page, pageSize }));
      }

      const productMatch = url.pathname.match(/^\/products\/([\w-]+)$/);
      if (req.method === "GET" && productMatch) {
        const product = catalog.get(productMatch[1]);
        if (!product) return send(res, 404, { error: "not_found" });
        return send(res, 200, product);
      }

      if (route === "GET /cart") return send(res, 200, cart.view());

      if (route === "POST /cart/items") {
        const body = await readJson(req);
        return send(res, 201, cart.add(body.productId, body.qty ?? 1));
      }

      if (route === "POST /cart/coupon") {
        const body = await readJson(req);
        return send(res, 200, cart.applyCoupon(body.code));
      }

      return send(res, 404, { error: "not_found", message: `no route for ${route}` });
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: "invalid", message: err.message });
      if (err instanceof NotFoundError) return send(res, 404, { error: "not_found", message: err.message });
      if (err instanceof OutOfStockError) return send(res, 409, { error: "out_of_stock", message: err.message });
      console.error(err);
      return send(res, 500, { error: "internal" });
    }
  });
}

function intParam(value, fallback) {
  return value === null ? fallback : Number(value);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  return body;
}
