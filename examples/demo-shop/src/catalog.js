export const DEFAULT_PRODUCTS = [
  { id: "coffee", name: "Coffee beans 1kg", priceCents: 2400, stock: 10 },
  { id: "mug", name: "Enamel mug", priceCents: 1250, stock: 25 },
  { id: "grinder", name: "Hand grinder", priceCents: 6900, stock: 3 },
  { id: "filters", name: "Paper filters (100)", priceCents: 599, stock: 40 },
  { id: "kettle", name: "Gooseneck kettle", priceCents: 8900, stock: 0 },
];

export class ValidationError extends Error {
  code = "invalid";
}

export class NotFoundError extends Error {
  code = "not_found";
}

export class OutOfStockError extends Error {
  code = "out_of_stock";
  constructor(productId, requested, available) {
    super(`only ${available} of ${productId} in stock, requested ${requested}`);
    this.productId = productId;
    this.requested = requested;
    this.available = available;
  }
}

export function createCatalog(seed = DEFAULT_PRODUCTS) {
  const products = seed.map((p) => ({ ...p }));

  const find = (id) => products.find((p) => p.id === id);

  return {
    list({ page = 1, pageSize = 2 } = {}) {
      if (!Number.isInteger(page) || page < 1) {
        throw new ValidationError("page must be a positive integer");
      }
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
        throw new ValidationError("pageSize must be an integer between 1 and 50");
      }
      const start = (page - 1) * pageSize;
      const items = products.slice(start, start + pageSize).map((p) => ({ ...p }));
      return { items, page, pageSize, total: products.length };
    },

    get(id) {
      const product = find(id);
      return product ? { ...product } : null;
    },

    reserve(id, qty) {
      const product = find(id);
      if (!product) throw new NotFoundError(`unknown product: ${id}`);
      if (qty > product.stock) throw new OutOfStockError(id, qty, product.stock);
      product.stock -= qty;
    },

    release(id, qty) {
      const product = find(id);
      if (product) product.stock += qty;
    },
  };
}
