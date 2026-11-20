import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog, OutOfStockError } from "../src/catalog.js";
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

test("reserving more than the stock is rejected", () => {
  const catalog = createCatalog();
  assert.throws(() => catalog.reserve("grinder", 4), OutOfStockError);
  catalog.reserve("grinder", 3);
  assert.throws(() => catalog.reserve("grinder", 1), OutOfStockError);
  assert.equal(catalog.get("grinder").stock, 0);
});

test("the API answers 409 when adding an out-of-stock product", () =>
  withServer(async (base) => {
    const res = await post(`${base}/cart/items`, { productId: "kettle", qty: 1 });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "out_of_stock");
  }));
