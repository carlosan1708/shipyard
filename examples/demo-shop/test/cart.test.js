import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog, ValidationError } from "../src/catalog.js";
import { createCart } from "../src/cart.js";

test("adding items computes subtotal, tax and total", () => {
  const cart = createCart(createCatalog());
  const view = cart.add("coffee", 2);
  assert.equal(view.subtotalCents, 4800);
  assert.equal(view.discountCents, 0);
  assert.equal(view.taxCents, 384);
  assert.equal(view.totalCents, 5184);
});

test("adding the same product twice merges the line", () => {
  const cart = createCart(createCatalog());
  cart.add("mug");
  const view = cart.add("mug", 2);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].qty, 3);
});

test("qty must be a positive integer", () => {
  const cart = createCart(createCatalog());
  assert.throws(() => cart.add("mug", 0), ValidationError);
  assert.throws(() => cart.add("mug", 1.5), ValidationError);
});

test("unknown coupons are rejected", () => {
  const cart = createCart(createCatalog());
  assert.throws(() => cart.applyCoupon("FREE"), ValidationError);
});
