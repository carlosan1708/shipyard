import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog } from "../src/catalog.js";
import { createCart } from "../src/cart.js";

test("WELCOME10 takes 10% off the subtotal", () => {
  const cart = createCart(createCatalog());
  cart.add("coffee", 1); // 2400
  const view = cart.applyCoupon("WELCOME10");
  assert.equal(view.discountCents, 240);
});

test("BIGSPENDER takes 20% off above the minimum", () => {
  const cart = createCart(createCatalog());
  cart.add("grinder", 2); // 13800
  assert.equal(cart.applyCoupon("BIGSPENDER").discountCents, 2760);
});
