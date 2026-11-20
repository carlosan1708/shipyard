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

test("GET /products/:id answers 404 for an unknown product", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/products/does-not-exist`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "not_found");
  }));

test("GET /products/:id still returns known products", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/products/mug`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, "mug");
  }));
