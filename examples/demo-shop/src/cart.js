import { NotFoundError, ValidationError } from "./catalog.js";

export const TAX_RATE = 0.08;

export const COUPONS = {
  WELCOME10: { percentOff: 10 },
  BIGSPENDER: { percentOff: 20, minSubtotalCents: 10000 },
};

export function computeTotals(items, coupon) {
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  let discountCents = 0;
  if (coupon && subtotalCents >= (coupon.minSubtotalCents ?? 0)) {
    discountCents = Math.round((subtotalCents * coupon.percentOff) / 100);
  }
  const taxCents = Math.round((subtotalCents - discountCents) * TAX_RATE);
  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}

export function createCart(catalog) {
  const lines = new Map(); // productId -> qty
  let coupon = null;

  const cart = {
    add(productId, qty = 1) {
      if (!Number.isInteger(qty) || qty < 1) {
        throw new ValidationError("qty must be a positive integer");
      }
      if (!catalog.get(productId)) throw new NotFoundError(`unknown product: ${productId}`);
      catalog.reserve(productId, qty);
      lines.set(productId, (lines.get(productId) ?? 0) + qty);
      return cart.view();
    },

    applyCoupon(code) {
      const found = COUPONS[code];
      if (!found) throw new ValidationError(`unknown coupon: ${code}`);
      coupon = { code, ...found };
      return cart.view();
    },

    view() {
      const items = [...lines].map(([productId, qty]) => {
        const product = catalog.get(productId);
        return {
          productId,
          name: product.name,
          qty,
          unitPriceCents: product.priceCents,
          lineTotalCents: product.priceCents * qty,
        };
      });
      return { items, coupon: coupon?.code ?? null, ...computeTotals(items, coupon) };
    },
  };

  return cart;
}
