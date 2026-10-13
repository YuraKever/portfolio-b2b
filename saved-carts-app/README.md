# Saved carts app

App proxy backend for the theme's saved carts page (`sections/saved-carts.liquid`).
Carts are stored per customer in the app-owned customer metafield `$app.saved_carts`.

## Setup

1. In the Dev Dashboard, create an app and install it on a dev store **in the same organization**
   (client credentials only work for stores in your org). The store needs B2B enabled.
   In the Partner Dashboard set the app to **Custom distribution** for that store: custom apps get
   protected customer data (level 1) automatically; without it `customer` queries fail with ACCESS_DENIED.
2. Deploy this folder to Vercel (`vercel deploy --prod` from `saved-carts-app`; Vercel runs `server.js`).
   Set `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (see `.env.example`).
3. Replace `REPLACE-WITH-VERCEL-DOMAIN` in `shopify.app.toml`, then:
   ```
   shopify app config link
   shopify app deploy
   ```
   and approve the new scopes on the store.
4. In the store admin, create a page with the `page.saved-carts` template.

Local dev: copy `.env.example` to `.env`, then `npm run dev`.

## API (via `/apps/saved-carts/carts`)

- `GET` returns `{ carts }`
- `POST { action: "create", name, items }`
- `POST { action: "update", id, name?, items? }`
- `POST { action: "delete", id }`

Every POST returns the updated `{ carts }`. `409` means the carts changed on another device.
