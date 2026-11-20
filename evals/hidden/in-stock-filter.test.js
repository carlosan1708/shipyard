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

test("inStock=true hides products with zero stock", () =>
  withServer(async (base) => {
    const body = await (await fetch(`${base}/products?inStock=true&pageSize=50`)).json();
    assert.equal(body.total, 4);
    assert.ok(!body.items.some((p) => p.id === "kettle"));
  }));

test("pagination applies to the filtered list", () =>
  withServer(async (base) => {
    const body = await (await fetch(`${base}/products?inStock=true&page=2&pageSize=3`)).json();
    assert.deepEqual(body.items.map((p) => p.id), ["filters"]);
  }));

test("without the parameter every product is listed", () =>
  withServer(async (base) => {
    const body = await (await fetch(`${base}/products?pageSize=50`)).json();
    assert.equal(body.total, 5);
  }));
