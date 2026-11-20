import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../src/catalog.js";

test("page 1 starts at the first product and the last page holds the rest", () => {
  const catalog = createCatalog();
  assert.deepEqual(catalog.list({ page: 1, pageSize: 2 }).items.map((p) => p.id), ["coffee", "mug"]);
  assert.deepEqual(catalog.list({ page: 2, pageSize: 2 }).items.map((p) => p.id), ["grinder", "filters"]);
  assert.deepEqual(catalog.list({ page: 3, pageSize: 2 }).items.map((p) => p.id), ["kettle"]);
  assert.deepEqual(catalog.list({ page: 4, pageSize: 2 }).items, []);
});
