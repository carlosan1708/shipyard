import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../src/catalog.js";
import { createCart } from "../src/cart.js";

test("tax is charged on the discounted amount", () => {
  const cart = createCart(createCatalog());
  cart.add("grinder", 2); // 13800
  const view = cart.applyCoupon("BIGSPENDER"); // -2760 => 11040
  assert.equal(view.taxCents, 883); // 11040 * 0.08 = 883.2
  assert.equal(view.totalCents, 11923);
});

test("tax without a coupon is unchanged", () => {
  const cart = createCart(createCatalog());
  assert.equal(cart.add("coffee", 1).taxCents, 192);
});
