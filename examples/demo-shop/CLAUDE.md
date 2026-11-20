# demo-shop

A tiny coffee-shop JSON API. Node 22+, ES modules, no dependencies.

- `src/catalog.js`: products, pagination and stock reservations
- `src/cart.js`: cart lines, coupons and totals (all money is integer cents)
- `src/server.js`: the HTTP API (`createApp()` returns an unstarted `http.Server`)
- `src/main.js`: starts the server on `PORT` (default 3000)

## Commands

- Unit tests: `npm test` (files in `test/`, using `node:test`)
- E2E tests: `npm run e2e` (files in `e2e/`, start the real server on port 0 and use `fetch`)

## Conventions

- Errors are typed (`ValidationError`, `NotFoundError`, `OutOfStockError`) and mapped to 400 / 404 / 409 in `server.js`.
- Error bodies look like `{ "error": "not_found", "message": "..." }`.
- Keep it dependency-free.
