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

test("DELETE /cart/items/:productId removes the line and restores stock", () =>
  withServer(async (base) => {
    await post(`${base}/cart/items`, { productId: "coffee", qty: 2 });
    assert.equal((await (await fetch(`${base}/products/coffee`)).json()).stock, 8);

    const res = await fetch(`${base}/cart/items/coffee`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const cart = await res.json();
    assert.deepEqual(cart.items, []);
    assert.equal(cart.totalCents, 0);
    assert.equal((await (await fetch(`${base}/products/coffee`)).json()).stock, 10);
  }));

test("DELETE /cart/items/:productId answers 404 when the product is not in the cart", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/cart/items/mug`, { method: "DELETE" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "not_found");
  }));
