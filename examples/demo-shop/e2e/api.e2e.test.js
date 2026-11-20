import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /products returns a page of products", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/products`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 5);
    assert.equal(body.items.length, 2);
  }));

test("GET /products/:id returns the product", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/products/coffee`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).priceCents, 2400);
  }));

test("POST /cart/items adds to the cart", () =>
  withServer(async (base) => {
    const res = await post(`${base}/cart/items`, { productId: "coffee", qty: 1 });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).subtotalCents, 2400);
  }));

test("POST /cart/items rejects a bad quantity with 400", () =>
  withServer(async (base) => {
    const res = await post(`${base}/cart/items`, { productId: "coffee", qty: 0 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid");
  }));
