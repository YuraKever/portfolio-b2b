/*
 * App proxy backend for B2B saved carts.
 * Storefront calls /apps/saved-carts/carts; Shopify forwards here with a signed
 * query that carries logged_in_customer_id. Carts live in the customer's
 * app-owned metafield ($app.saved_carts, JSON).
 * Served by server.js (Vercel detects it as the entrypoint; also used locally).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
const API_VERSION = "2026-07";
const LIMITS = { carts: 20, items: 100, name: 100, quantity: 10000, body: 64 * 1024 };

const CUSTOMER_QUERY = `query SavedCarts($id: ID!) {
  customer(id: $id) {
    companyContactProfiles { id }
    metafield(namespace: "$app", key: "saved_carts") { jsonValue compareDigest }
  }
}`;

const SAVE_MUTATION = `mutation SaveCarts($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { compareDigest }
    userErrors { field message code }
  }
}`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let token = { value: null, expiresAt: 0 };

async function accessToken() {
  if (Date.now() < token.expiresAt) return token.value;

  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);

  const { access_token, expires_in } = await response.json();
  // Refresh 5 minutes early so an in-flight request never uses an expired token.
  token = { value: access_token, expiresAt: Date.now() + (expires_in - 300) * 1000 };
  return token.value;
}

async function graphql(query, variables) {
  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GraphQL request failed: ${response.status}`);

  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

// https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
function verifyProxySignature(searchParams) {
  const signature = searchParams.get("signature") ?? "";
  const message = [...new Set(searchParams.keys())]
    .filter((key) => key !== "signature")
    .map((key) => `${key}=${searchParams.getAll(key).join(",")}`)
    .sort()
    .join("");
  const expected = createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(message).digest("hex");

  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}

async function loadCarts(customerGid) {
  const { customer } = await graphql(CUSTOMER_QUERY, { id: customerGid });
  if (!customer?.companyContactProfiles.length) throw new HttpError(403, "B2B customers only");

  return {
    carts: customer.metafield?.jsonValue ?? [],
    compareDigest: customer.metafield?.compareDigest ?? null,
  };
}

async function saveCarts(customerGid, carts, compareDigest) {
  const { metafieldsSet } = await graphql(SAVE_MUTATION, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: "$app",
        key: "saved_carts",
        type: "json",
        value: JSON.stringify(carts),
        compareDigest,
      },
    ],
  });

  if (metafieldsSet.userErrors.length) {
    const stale = metafieldsSet.userErrors.some((error) => error.code === "STALE_OBJECT");
    if (stale) throw new HttpError(409, "Saved carts changed on another device, reload the page");
    throw new Error(`metafieldsSet: ${JSON.stringify(metafieldsSet.userErrors)}`);
  }
}

function parseName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > LIMITS.name) throw new HttpError(422, "Invalid name");
  return name;
}

function parseItems(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.items) {
    throw new HttpError(422, "Invalid items");
  }

  return value.map((item) => {
    const id = Number(item?.id);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(422, "Invalid variant id");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.quantity) {
      throw new HttpError(422, "Invalid quantity");
    }

    const properties =
      item.properties && typeof item.properties === "object" && !Array.isArray(item.properties)
        ? item.properties
        : {};
    return { id, quantity, title: String(item.title ?? "").slice(0, 255), properties };
  });
}

function applyAction(carts, body) {
  const now = new Date().toISOString();

  switch (body.action) {
    case "create": {
      if (carts.length >= LIMITS.carts) throw new HttpError(422, "Too many saved carts");
      const cart = { id: randomUUID(), name: parseName(body.name), items: parseItems(body.items) };
      return [{ ...cart, createdAt: now, updatedAt: now }, ...carts];
    }
    case "update": {
      if (!carts.some((cart) => cart.id === body.id)) throw new HttpError(404, "Cart not found");
      return carts.map((cart) =>
        cart.id === body.id
          ? {
              ...cart,
              ...(body.name !== undefined && { name: parseName(body.name) }),
              ...(body.items !== undefined && { items: parseItems(body.items) }),
              updatedAt: now,
            }
          : cart,
      );
    }
    case "delete":
      return carts.filter((cart) => cart.id !== body.id);
    default:
      throw new HttpError(400, "Unknown action");
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LIMITS.body) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

async function handle(request) {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname === "/health") return { status: 200, body: { ok: true } };
  if (url.pathname !== "/proxy/carts") throw new HttpError(404, "Not found");
  if (!verifyProxySignature(url.searchParams)) throw new HttpError(401, "Invalid signature");
  if (url.searchParams.get("shop") !== SHOPIFY_SHOP) throw new HttpError(403, "Unknown shop");

  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) throw new HttpError(401, "Login required");
  const customerGid = `gid://shopify/Customer/${customerId}`;

  const { carts, compareDigest } = await loadCarts(customerGid);
  if (request.method === "GET") return { status: 200, body: { carts } };
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");

  const next = applyAction(carts, await readJson(request));
  await saveCarts(customerGid, next, compareDigest);
  return { status: 200, body: { carts: next } };
}

export default async function handler(request, response) {
  let result;
  try {
    result = await handle(request);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    result = {
      status: error.status ?? 500,
      body: { error: error.status ? error.message : "Server error" },
    };
  }
  response.writeHead(result.status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result.body));
}
