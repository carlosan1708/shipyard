import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog, NotFoundError, ValidationError } from "../src/catalog.js";

test("get returns a copy of the product", () => {
  const catalog = createCatalog();
  const mug = catalog.get("mug");
  assert.equal(mug.name, "Enamel mug");
  mug.stock = 0;
  assert.equal(catalog.get("mug").stock, 25);
});

test("get returns null for unknown ids", () => {
  assert.equal(createCatalog().get("nope"), null);
});

test("list reports paging metadata", () => {
  const result = createCatalog().list({ page: 1, pageSize: 2 });
  assert.equal(result.total, 5);
  assert.equal(result.pageSize, 2);
  assert.equal(result.items.length, 2);
});

test("list rejects invalid paging", () => {
  const catalog = createCatalog();
  assert.throws(() => catalog.list({ page: 0 }), ValidationError);
  assert.throws(() => catalog.list({ pageSize: 51 }), ValidationError);
});

test("reserve reduces stock", () => {
  const catalog = createCatalog();
  catalog.reserve("coffee", 2);
  assert.equal(catalog.get("coffee").stock, 8);
});

test("reserve rejects unknown products", () => {
  assert.throws(() => createCatalog().reserve("nope", 1), NotFoundError);
});
