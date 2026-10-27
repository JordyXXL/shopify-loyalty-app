/**
 * Shopify orders -> Loyalty Connect's order contract (POST /api/v1/orders). A line-for-line port of Connect's own Shopify mapping
 * (Connect src/platforms/shopify/orders.ts), so an order sent by this app is the same message as one sent by Connect's own Shopify
 * app. Two inputs: the REST-shaped JSON of the order webhooks, and the Admin GraphQL order this app reads again on refunds/create.
 * Amounts are the shop currency, as decimal strings. Pure, no server imports (tested against Connect's own golden fixtures).
 *
 * Personal data: only the customer's e-mail address is read, and only into `customer.email`, which Connect turns into a keyed hash
 * at its door and drops. Of the shipping address only the country and province code are read. Names, the rest of the address, phone
 * numbers, browser IP and user agent are never read.
 *
 * The order id is the numeric Shopify order id (REST `id`, GraphQL `legacyResourceId`): the same id the web pixel sends as
 * `orderId` on checkout_completed, so the purchase event and the order link (the way Connect's own app links them).
 */
import { clampMoney, money, subMoney, sumMoney } from "./money.js";

/**
 * The order attribute Connect's survey writes the "how did you find us" answer to. This name is part of Connect's contract (its
 * survey extension writes it, its mapping reads it), so it is kept as is here.
 */
export const SURVEY_ATTRIBUTE = "valtracs_survey";
export const SURVEY_ANSWERS = ["google", "instagram_facebook", "tiktok", "influencer", "friends_family", "email", "other"];
export const isSurveyAnswer = (v) => typeof v === "string" && SURVEY_ANSWERS.includes(v);

/** "820982911946154508" from a GID (gid://shopify/Order/820982911946154508) or from the number itself. */
export function numericId(v) {
  const s = String(v ?? "").trim();
  const m = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)/.exec(s);
  return m ? m[1] : s;
}

/** The survey answer among note attributes (REST: name/value) or custom attributes (GraphQL: key/value). */
export function surveyFrom(attrs) {
  if (!Array.isArray(attrs)) return undefined;
  for (const a of attrs) {
    if ((a?.name ?? a?.key) !== SURVEY_ATTRIBUTE) continue;
    const v = String(a.value ?? "").trim().toLowerCase();
    if (isSurveyAnswer(v)) return v;
  }
  return undefined;
}

/** Shopify's landing_site is usually a path ("/products/x?utm_source=..."); Connect wants a URL, on the shop's own domain. */
export function landingUrl(v, domain) {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return s.slice(0, 4000);
  return s.startsWith("/") ? `https://${domain}${s}`.slice(0, 4000) : undefined;
}

const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Country and province code of a shipping address, nothing else of it. */
export function shippingRegion(country, province) {
  const c = text(country, 2)?.toUpperCase();
  if (!c || !/^[A-Z]{2}$/.test(c)) return undefined;
  const p = text(province, 10)?.toUpperCase();
  return p ? { countryCode: c, provinceCode: p } : { countryCode: c };
}
const firstEmail = (...vs) => vs.map((v) => text(v, 320)).find((v) => v && v.includes("@"));

/** REST fulfillment_status -> the lower-case form of GraphQL's displayFulfillmentStatus. */
const FULFILLMENT = { fulfilled: "fulfilled", partial: "partially_fulfilled", restocked: "restocked" };
const PAID = new Set(["paid", "partially_refunded", "refunded"]);

/** A refund's amount: its successful refund transactions. */
function refundAmount(r) {
  const tx = Array.isArray(r?.transactions) ? r.transactions : [];
  return sumMoney(tx.filter((t) => t?.kind === "refund" && (t.status ?? "success") === "success").map((t) => t.amount));
}

/** An order webhook (orders/create, orders/updated, orders/cancelled): REST-shaped JSON. `domain`: the shop's storefront domain. */
export function orderFromWebhook(p, opts) {
  const total = money(p.total_price) ?? "0.00";
  const refunds = (Array.isArray(p.refunds) ? p.refunds : []).map((r) => ({
    externalId: String(r.id), createdAt: String(r.created_at ?? r.processed_at ?? ""), totalRefunded: refundAmount(r),
  }));
  const refunded = sumMoney(refunds.map((r) => r.totalRefunded));
  const outstanding = money(p.total_outstanding);
  // GraphQL's totalReceived: what the customer paid, before refunds
  const received = outstanding !== undefined ? clampMoney(subMoney(total, outstanding), "0", total) : PAID.has(String(p.financial_status)) ? total : "0.00";
  const email = firstEmail(p.customer?.email, p.email, p.contact_email);
  const region = shippingRegion(p.shipping_address?.country_code, p.shipping_address?.province_code);
  const landing = landingUrl(p.landing_site, opts.domain);
  const referrer = text(p.referring_site, 2000);
  const survey = surveyFrom(p.note_attributes);
  return {
    externalId: String(p.id),
    createdAt: String(p.created_at ?? ""),
    ...(p.updated_at ? { updatedAt: String(p.updated_at) } : {}),
    cancelledAt: p.cancelled_at ? String(p.cancelled_at) : null,
    currency: String(p.currency ?? "").toUpperCase(),
    fulfillmentStatus: FULFILLMENT[String(p.fulfillment_status)] ?? "unfulfilled",
    test: p.test === true,
    pricing: {
      subtotal: money(p.subtotal_price) ?? "0.00",
      totalDiscounts: money(p.total_discounts) ?? "0.00",
      totalTax: money(p.total_tax) ?? "0.00",
      totalShipping: money(p.total_shipping_price_set?.shop_money?.amount) ?? sumMoney((p.shipping_lines ?? []).map((l) => l?.price)),
      totalPrice: total,
      totalReceived: received,
      netPayment: subMoney(received, refunded),
    },
    discountCodes: (Array.isArray(p.discount_codes) ? p.discount_codes : []).map((d) => String(d?.code ?? "").trim()).filter(Boolean),
    ...(email ? { customer: { externalId: String(p.customer?.id ?? `order-${p.id}`), email } } : {}),
    lineItems: (Array.isArray(p.line_items) ? p.line_items : []).map((li) => ({
      externalId: String(li.id), title: String(li.title ?? li.name ?? "").slice(0, 1000), quantity: Number(li.quantity),
      originalUnitPrice: money(li.price_set?.shop_money?.amount ?? li.price) ?? "0.00",
    })),
    refunds,
    ...(landing ? { landingUrl: landing } : {}),
    ...(referrer ? { referrer } : {}),
    ...(survey ? { attributionSurvey: survey } : {}),
    ...(region ? { shippingAddress: region } : {}),
  };
}

const shopMoney = (bag) => money(bag?.shopMoney?.amount);
const nodes = (c) => (Array.isArray(c) ? c : Array.isArray(c?.nodes) ? c.nodes : Array.isArray(c?.edges) ? c.edges.map((e) => e.node) : []);

/** An order of the Admin GraphQL API (refunds/create), with the fields of shopify-admin.server.js orderFields. */
export function orderFromGraphql(n, opts) {
  const id = n.legacyResourceId ? String(n.legacyResourceId) : numericId(n.id);
  const visit = n.customerJourneySummary?.lastVisit ?? n.customerJourneySummary?.firstVisit;
  const email = firstEmail(n.email);
  const region = shippingRegion(n.shippingAddress?.countryCodeV2, n.shippingAddress?.provinceCode);
  const landing = landingUrl(visit?.landingPage, opts.domain);
  const referrer = text(visit?.referrerUrl, 2000);
  const survey = surveyFrom(n.customAttributes);
  return {
    externalId: id,
    createdAt: String(n.createdAt ?? ""),
    ...(n.updatedAt ? { updatedAt: String(n.updatedAt) } : {}),
    cancelledAt: n.cancelledAt ? String(n.cancelledAt) : null,
    currency: String(n.currencyCode ?? "").toUpperCase(),
    fulfillmentStatus: String(n.displayFulfillmentStatus ?? "UNFULFILLED").toLowerCase(),
    test: n.test === true,
    pricing: {
      subtotal: shopMoney(n.subtotalPriceSet) ?? "0.00",
      totalDiscounts: shopMoney(n.totalDiscountsSet) ?? "0.00",
      totalTax: shopMoney(n.totalTaxSet) ?? "0.00",
      totalShipping: shopMoney(n.totalShippingPriceSet) ?? "0.00",
      totalPrice: shopMoney(n.totalPriceSet) ?? "0.00",
      totalReceived: shopMoney(n.totalReceivedSet) ?? "0.00",
      netPayment: shopMoney(n.netPaymentSet) ?? "0.00",
    },
    discountCodes: (Array.isArray(n.discountCodes) ? n.discountCodes : []).map((c) => String(c).trim()).filter(Boolean),
    ...(email ? { customer: { externalId: `order-${id}`, email } } : {}),
    lineItems: nodes(n.lineItems).map((li) => ({
      externalId: numericId(li.id), title: String(li.title ?? "").slice(0, 1000), quantity: Number(li.quantity), originalUnitPrice: shopMoney(li.originalUnitPriceSet) ?? "0.00",
    })),
    refunds: nodes(n.refunds).map((r) => ({ externalId: numericId(r.id), createdAt: String(r.createdAt ?? ""), totalRefunded: shopMoney(r.totalRefundedSet) ?? "0.00" })),
    ...(landing ? { landingUrl: landing } : {}),
    ...(referrer ? { referrer } : {}),
    ...(survey ? { attributionSurvey: survey } : {}),
    ...(region ? { shippingAddress: region } : {}),
  };
}
