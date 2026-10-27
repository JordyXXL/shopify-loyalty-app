/**
 * The Admin GraphQL calls Loyalty Connect needs, the same as Connect's own Shopify integration makes them (Connect
 * src/platforms/shopify/admin.ts): one order read again on refunds/create, the shop's primary domain, and the web pixel. Retries on
 * 429, 5xx and THROTTLED. Error messages carry Shopify's text, never a token or a payload.
 *
 * A client is { shop, token, fetch?, apiVersion?, wait? }; the token is the shop's offline access token.
 */
import { SHOPIFY_ADMIN_API_VERSION } from "./config.server.js";

export class ShopifyError extends Error {
  /** kind "access": a missing scope or protected customer data approval */
  constructor(message, kind = "other") {
    super(message);
    this.name = "ShopifyError";
    this.kind = kind;
  }
}

const ACCESS_RE = /access denied|protected customer data|not approved|required access|requires .* access scope/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function graphql(c, query, variables = {}) {
  const wait = c.wait ?? sleep;
  const doFetch = c.fetch ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`https://${c.shop}/admin/api/${c.apiVersion ?? SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": c.token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await wait(500 * 2 ** attempt);
      continue;
    }
    const j = await res.json().catch(() => ({}));
    const list = Array.isArray(j.errors) ? j.errors : [];
    const messages = Array.isArray(j.errors) ? list.map((e) => e?.message ?? JSON.stringify(e)) : j.errors ? [typeof j.errors === "string" ? j.errors : JSON.stringify(j.errors)] : [];
    if (list.some((e) => e?.extensions?.code === "THROTTLED") && attempt < 3) {
      await wait(1000 * attempt);
      continue;
    }
    const text = messages.join("; ").slice(0, 400);
    if (!res.ok || messages.length) throw new ShopifyError(text ? `Shopify ${res.status}: ${text}` : `Shopify ${res.status}`, ACCESS_RE.test(text) || res.status === 403 ? "access" : "other");
    return j.data;
  }
}

// ---------------------------------------------------------------- the shop
/** The shop's primary storefront host ("www.winkel.nl"), for making Shopify's landing_site paths absolute. */
export async function primaryDomain(c) {
  const d = await graphql(c, `query { shop { myshopifyDomain primaryDomain { host } } }`);
  return d?.shop?.primaryDomain?.host || d?.shop?.myshopifyDomain || c.shop;
}

// ---------------------------------------------------------------- orders (the same fields as Connect's orderFields)
/**
 * `email` and `shippingAddress` (of which only country and province code are asked) need protected customer data (level 2) and
 * customerJourneySummary may need approval too: without it Shopify refuses the whole query, so `withProtected: false` asks again
 * without them (the order then comes without customer hash and region).
 */
export const orderFields = (lineItems, withProtected) => `id legacyResourceId createdAt updatedAt cancelledAt test currencyCode
  displayFulfillmentStatus discountCodes customAttributes { key value }${withProtected ? ` email shippingAddress { countryCodeV2 provinceCode }
  customerJourneySummary { firstVisit { landingPage referrerUrl } lastVisit { landingPage referrerUrl } }` : ""}
  subtotalPriceSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } } totalPriceSet { shopMoney { amount } } totalReceivedSet { shopMoney { amount } } netPaymentSet { shopMoney { amount } }
  lineItems(first: ${lineItems}) { pageInfo { hasNextPage } nodes { id title quantity originalUnitPriceSet { shopMoney { amount } } } }
  refunds { id createdAt totalRefundedSet { shopMoney { amount } } }`;

export const ORDER_LINE_ITEMS = 250;

export async function orderById(c, orderId, withProtected) {
  const d = await graphql(c, `query($id: ID!) { order(id: $id) { ${orderFields(ORDER_LINE_ITEMS, withProtected)} } }`, { id: `gid://shopify/Order/${orderId}` });
  return d?.order ?? undefined;
}

/** One order, asking again without the protected fields when Shopify refuses them. */
export async function orderByIdTolerant(c, orderId) {
  try {
    return await orderById(c, orderId, true);
  } catch (e) {
    if (e instanceof ShopifyError && e.kind === "access") return orderById(c, orderId, false);
    throw e;
  }
}

// ---------------------------------------------------------------- the web pixel (extensions/loyalty-connect-pixel)
const userErrors = (errs, ignore) =>
  (errs ?? []).filter((e) => !ignore?.test(`${e.code ?? ""} ${e.message ?? ""}`)).map((e) => e.message ?? e.code ?? "error").join("; ") || undefined;

/** This app's web pixel in the shop, if it has one. Shopify answers with an error when there is none. */
export async function findWebPixel(c) {
  try {
    const d = await graphql(c, `query { webPixel { id settings } }`);
    if (!d?.webPixel?.id) return undefined;
    const raw = d.webPixel.settings;
    let settings = {};
    try {
      settings = typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
    } catch {
      /* unreadable settings */
    }
    return { id: d.webPixel.id, settings };
  } catch (e) {
    if (/no web ?pixel|not found|doesn't exist/i.test(e.message)) return undefined;
    throw e;
  }
}

/** Creates the pixel, or updates its settings when it exists. Returns Shopify's problem, or undefined. */
export async function upsertWebPixel(c, settings) {
  const existing = await findWebPixel(c);
  if (existing) {
    const d = await graphql(c, `mutation($id: ID!, $settings: JSON!) { webPixelUpdate(id: $id, webPixel: { settings: $settings }) { webPixel { id } userErrors { code field message } } }`,
      { id: existing.id, settings: JSON.stringify(settings) });
    return userErrors(d.webPixelUpdate.userErrors);
  }
  const d = await graphql(c, `mutation($settings: JSON!) { webPixelCreate(webPixel: { settings: $settings }) { webPixel { id } userErrors { code field message } } }`,
    { settings: JSON.stringify(settings) });
  return userErrors(d.webPixelCreate.userErrors, /TAKEN|already/i);
}

export async function deleteWebPixel(c) {
  const existing = await findWebPixel(c);
  if (!existing) return undefined;
  const d = await graphql(c, `mutation($id: ID!) { webPixelDelete(id: $id) { deletedWebPixelId userErrors { field message } } }`, { id: existing.id });
  return userErrors(d.webPixelDelete.userErrors);
}
