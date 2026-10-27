/**
 * The pure part of the Loyalty Connect web pixel: Shopify customer events -> Loyalty Connect's collector contract
 * `{events:[{id, name, ts, url, referrer?, clientId, sessionKey, consent, orderId?, value?, currency?}]}`. A port of the pixel of
 * Loyalty Connect's own Shopify app (its pixel extension's payload.ts), so both send the same events.
 *
 * - Event names are the GA4 names Loyalty Connect's browser tag sends.
 * - Ids: the visitor id in localStorage `vt_cid` and the session in sessionStorage `vt_sid` / `vt_last` (30 minutes): the keys and
 *   rules of Loyalty Connect's browser tag (part of its contract, so tag and pixel share one visitor), through the pixel sandbox's
 *   browser.localStorage / browser.sessionStorage.
 * - Consent: both types "granted". Shopify loads this pixel only when the visitor granted analytics and marketing
 *   (shopify.extension.toml [customer_privacy]), so it never runs without them.
 * - orderId on checkout_completed: Shopify's numeric order id (event.data.checkout.order.id; a GID is reduced to its number). It is
 *   the `id` of the order webhooks, which this app sends as the order's externalId: the purchase event and the order link.
 * - No personal data: no e-mail, name, address or phone of the checkout is read; URLs lose user info, fragment and e-mail or
 *   credential parameters (Loyalty Connect scrubs again on arrival).
 *
 * No imports: tested by the app's test suite (test/loyalty-connect.pixel.test.js) and bundled by the Shopify CLI.
 */

export const CID = "vt_cid";
export const SID = "vt_sid";
export const LAST = "vt_last";
export const SESSION_MS = 30 * 60 * 1000;

/** Shopify standard events -> the names the browser tag uses. Events that carry contact or address data are not subscribed. */
export const EVENT_NAMES = Object.freeze({
  page_viewed: "page_view",
  product_viewed: "view_item",
  collection_viewed: "view_item_list",
  cart_viewed: "view_cart",
  product_added_to_cart: "add_to_cart",
  product_removed_from_cart: "remove_from_cart",
  checkout_started: "begin_checkout",
  checkout_shipping_info_submitted: "add_shipping_info",
  payment_info_submitted: "add_payment_info",
  checkout_completed: "purchase",
});
export const SUBSCRIBED = Object.keys(EVENT_NAMES);

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const VALID_CID = /^[A-Za-z0-9-]{8,64}$/;
const EMAIL = /[^\s@/?&=#]+@[^\s@/?&=#]+\.[a-z]{2,}/i;
const PII_PARAM = /^(e|e-?mail(address)?|mail|phone|tel|telephone|mobile|token|password|pwd)$|(^|[_.-])(e-?mail|phone|tel|token|password)([_.-]|$)/i;

/** The visitor and session ids, created when missing, exactly as the browser tag keeps them. */
export async function sessionIds(local, session, nowMs, uuid) {
  let clientId = (await local.getItem(CID)) ?? "";
  if (!VALID_CID.test(clientId)) {
    clientId = uuid();
    await local.setItem(CID, clientId);
  }
  let sessionKey = (await session.getItem(SID)) ?? "";
  const last = Number(await session.getItem(LAST)) || 0;
  const fresh = !sessionKey || !last || nowMs - last > SESSION_MS;
  if (fresh) {
    sessionKey = uuid();
    await session.setItem(SID, sessionKey);
  }
  await session.setItem(LAST, String(Math.max(nowMs, last)));
  return { clientId, sessionKey, fresh };
}

/** The collector wants a UUID; Shopify's event ids end in one ("sh-..."), which keeps a retried event the same event. */
export const eventId = (shopifyId, uuid) => {
  const m = UUID_TAIL.exec(String(shopifyId ?? ""));
  return m ? m[1].toLowerCase() : uuid();
};

/** Shopify's numeric order id from a number, a numeric string or a GID (gid://shopify/Order/123, .../OrderIdentity/123). */
export function orderIdOf(v) {
  const s = typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : typeof v === "string" ? v.trim() : "";
  const m = /^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d{1,20})$/.exec(s);
  return m ? m[1] : undefined;
}

/** A URL without fragment, user info, e-mail addresses or person/credential parameters (the browser tag's clean()). */
export function cleanUrl(href) {
  if (typeof href !== "string" || !href) return undefined;
  let u;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  u.hash = "";
  u.username = "";
  u.password = "";
  const drop = [];
  u.searchParams.forEach((v, k) => {
    if (PII_PARAM.test(k) || EMAIL.test(k) || EMAIL.test(v)) drop.push(k);
  });
  drop.forEach((k) => u.searchParams.delete(k));
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it */
  }
  if (EMAIL.test(path)) u.pathname = path.split("/").map((s) => (EMAIL.test(s) ? "redacted" : s)).join("/");
  return u.href.slice(0, 2000);
}

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const cur = (v) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined);

/** The amount and currency an event is about: the product, the cart line or the checkout. */
function valueOf(event) {
  const d = event?.data ?? {};
  const money = d.checkout?.totalPrice ?? d.cartLine?.cost?.totalAmount ?? d.productVariant?.price;
  const value = num(money?.amount);
  const currency = cur(money?.currencyCode ?? d.checkout?.currencyCode);
  return { ...(value !== undefined ? { value } : {}), ...(currency ? { currency } : {}) };
}

/** One Shopify customer event as a collector event, or undefined for an event the pixel does not send. */
export function buildEvent(event, ids, uuid) {
  const name = EVENT_NAMES[String(event?.name ?? "")];
  if (!name) return undefined;
  const url = cleanUrl(event?.context?.document?.location?.href);
  if (!url) return undefined;
  const ts = Math.round(Date.parse(String(event?.timestamp ?? "")) || Date.now());
  const out = {
    id: eventId(event?.id, uuid), name, ts, url, clientId: ids.clientId, sessionKey: ids.sessionKey,
    consent: { analytics_storage: "granted", ad_storage: "granted" },
  };
  // the referrer on the first event of a session, only when it is another site (as the tag does)
  if (ids.fresh) {
    const ref = cleanUrl(event?.context?.document?.referrer);
    try {
      if (ref && new URL(ref).origin !== new URL(url).origin) out.referrer = ref;
    } catch {
      /* no referrer */
    }
  }
  if (name !== "page_view") Object.assign(out, valueOf(event));
  if (name === "purchase") {
    const id = orderIdOf(event?.data?.checkout?.order?.id);
    if (id) out.orderId = id;
  }
  return out;
}

/** Where the events go: <collectorUrl>/collect?k=<public key>, or undefined when the settings are not filled in (yet). */
export function endpointOf(settings) {
  const s = settings ?? {};
  const base = typeof s.collectorUrl === "string" ? s.collectorUrl.trim().replace(/\/+$/, "") : "";
  const key = typeof s.siteKey === "string" ? s.siteKey.trim() : "";
  if (!/^https:\/\/[^\s/]+$|^http:\/\/localhost(:\d+)?$/.test(base) || !/^cs_pub_[A-Za-z0-9_-]{4,100}$/.test(key)) return undefined;
  return `${base}/collect?k=${encodeURIComponent(key)}`;
}

/** The body the collector reads (text/plain, as sendBeacon sends it). */
export const body = (events) => JSON.stringify({ events });
