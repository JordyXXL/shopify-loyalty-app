// The web pixel's pure part, with the expectations of Loyalty Connect's own pixel tests (Connect test/platform-shopify-pixel.test.ts):
// same ids, same events, same consent, nothing about the buyer.
import { describe, expect, it } from "vitest";
import { body, buildEvent, CID, cleanUrl, endpointOf, eventId, LAST, orderIdOf, SESSION_MS, sessionIds, SID, SUBSCRIBED } from "../extensions/loyalty-connect-pixel/src/payload.js";
import { orderFromWebhook } from "../app/loyalty-connect/orders.js";

/** browser.localStorage / browser.sessionStorage of the pixel sandbox: async, string values. */
class Store {
  m = new Map();
  async getItem(k) { return this.m.get(k) ?? null; }
  async setItem(k, v) { this.m.set(k, v); }
}
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const T = Date.parse("2026-10-20T12:00:00Z");

const context = (href, referrer = "") => ({ document: { location: { href }, referrer, title: "Winkel" }, navigator: { userAgent: "Mozilla/5.0 SentinelUA" }, window: { origin: "https://winkel.example" } });
const pageViewed = { id: "sh-88153c5a-8F2D-4CCA-3231-EF5C032A4C3B", name: "page_viewed", timestamp: "2026-10-20T11:59:00.000Z", clientId: "shopify-client-1", context: context("https://winkel.example/collections/schoenen?utm_source=instagram&email=jan%40example.com#top", "https://l.instagram.com/"), data: {} };
const productViewed = { id: "sh-0a1b2c3d-1111-4222-8333-444455556666", name: "product_viewed", timestamp: "2026-10-20T11:59:30.000Z", context: context("https://winkel.example/products/wandelschoen"), data: { productVariant: { price: { amount: 80, currencyCode: "EUR" }, product: { id: "8123456789011", title: "Wandelschoen" } } } };
const checkoutCompleted = {
  id: "sh-ffffeeee-dddd-4ccc-bbbb-aaaa99998888", name: "checkout_completed", timestamp: "2026-10-20T12:00:00.000Z",
  context: context("https://winkel.example/checkouts/cn/Z2NwLWV1cm9wZS13ZXN0NDow/thank-you"),
  data: { checkout: { order: { id: "6123456789012", customer: { id: "7012345678901", isFirstOrder: true } }, totalPrice: { amount: 94.95, currencyCode: "EUR" }, currencyCode: "EUR", email: "bob.norman@mail.example.com", phone: "+31612345678", billingAddress: { firstName: "Bob", lastName: "Norman", address1: "Keizersgracht 123" }, lineItems: [{ title: "Wandelschoen", quantity: 1 }] } },
};

describe("web pixel: ids like Loyalty Connect's browser tag", () => {
  it("keeps the visitor in localStorage vt_cid and the session in sessionStorage vt_sid / vt_last (30 minutes)", async () => {
    const local = new Store();
    const session = new Store();
    const a = await sessionIds(local, session, T, uuid);
    expect(a.fresh).toBe(true);
    expect(local.m.get(CID)).toBe(a.clientId);
    expect(session.m.get(SID)).toBe(a.sessionKey);
    expect(session.m.get(LAST)).toBe(String(T));
    const b = await sessionIds(local, session, T + SESSION_MS - 1000, uuid);
    expect(b).toEqual({ clientId: a.clientId, sessionKey: a.sessionKey, fresh: false });
    const c = await sessionIds(local, session, T + 2 * SESSION_MS + 1, uuid);
    expect(c.clientId).toBe(a.clientId);
    expect(c.sessionKey).not.toBe(a.sessionKey);
    expect(c.fresh).toBe(true);
    local.m.set(CID, "tag-set-visitor-id-01");
    expect((await sessionIds(local, session, T, uuid)).clientId).toBe("tag-set-visitor-id-01");
    local.m.set(CID, "x");
    expect((await sessionIds(local, session, T, uuid)).clientId).not.toBe("x");
  });
});

describe("web pixel: payload in the collector contract", () => {
  const ids = { clientId: "11111111-2222-4333-8444-555555555555", sessionKey: "66666666-7777-4888-8999-000000000000", fresh: true };

  it("sends page_view with the landing referrer, consent granted for both types, and a cleaned URL", () => {
    expect(buildEvent(pageViewed, ids, uuid)).toEqual({
      id: "88153c5a-8f2d-4cca-3231-ef5c032a4c3b", name: "page_view", ts: Date.parse("2026-10-20T11:59:00.000Z"),
      url: "https://winkel.example/collections/schoenen?utm_source=instagram", referrer: "https://l.instagram.com/",
      clientId: ids.clientId, sessionKey: ids.sessionKey, consent: { analytics_storage: "granted", ad_storage: "granted" },
    });
    expect(buildEvent(pageViewed, { ...ids, fresh: false }, uuid)).not.toHaveProperty("referrer");
  });

  it("sends purchase with the order id the webhooks use, value and currency, and nothing about the buyer", () => {
    const e = buildEvent(checkoutCompleted, { ...ids, fresh: false }, uuid);
    expect(e).toMatchObject({ name: "purchase", orderId: "6123456789012", value: 94.95, currency: "EUR" });
    expect(JSON.stringify(e)).not.toMatch(/bob|Norman|Keizersgracht|\+316|7012345678901|SentinelUA/i);
    // the same id as the order this app sends to Loyalty Connect: event and order link
    expect(orderFromWebhook({ id: 6123456789012, created_at: "2026-10-20T12:00:00Z", line_items: [] }, { domain: "winkel.example" }).externalId).toBe(e.orderId);
    expect(buildEvent({ ...checkoutCompleted, data: { checkout: { ...checkoutCompleted.data.checkout, order: { id: "gid://shopify/Order/6123456789012" } } } }, ids, uuid).orderId).toBe("6123456789012");
    expect(buildEvent(productViewed, ids, uuid)).toMatchObject({ name: "view_item", value: 80, currency: "EUR" });
  });

  it("a batch has the collector's shape", () => {
    const events = [pageViewed, productViewed, checkoutCompleted].map((ev) => buildEvent(ev, ids, uuid));
    const parsed = JSON.parse(body(events));
    expect(parsed.events).toHaveLength(3);
    for (const e of parsed.events) {
      expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(e.clientId).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
      expect(Number.isInteger(e.ts) && e.ts > 0).toBe(true);
      expect(e.consent).toEqual({ analytics_storage: "granted", ad_storage: "granted" });
    }
  });

  it("subscribes to storefront and checkout events, never to those that carry contact or address data", () => {
    expect(SUBSCRIBED).toEqual(expect.arrayContaining(["page_viewed", "product_viewed", "product_added_to_cart", "checkout_started", "checkout_completed"]));
    expect(SUBSCRIBED).not.toContain("checkout_contact_info_submitted");
    expect(SUBSCRIBED).not.toContain("checkout_address_info_submitted");
    expect(SUBSCRIBED).not.toContain("search_submitted");
    expect(buildEvent({ ...pageViewed, name: "checkout_contact_info_submitted" }, ids, uuid)).toBeUndefined();
    // eslint-disable-next-line no-script-url -- a javascript: URL must be refused
    expect(buildEvent({ ...pageViewed, context: context("javascript:alert(1)") }, ids, uuid)).toBeUndefined();
  });

  it("small helpers: event ids, order ids, URLs, the endpoint from the pixel settings", () => {
    expect(eventId("sh-88153C5A-8F2D-4CCA-3231-EF5C032A4C3B", uuid)).toBe("88153c5a-8f2d-4cca-3231-ef5c032a4c3b");
    expect(eventId("weird", () => "fallback-uuid")).toBe("fallback-uuid");
    expect(orderIdOf(6123456789012)).toBe("6123456789012");
    expect(orderIdOf("gid://shopify/OrderIdentity/6123456789012")).toBe("6123456789012");
    expect(orderIdOf("#1001")).toBeUndefined();
    expect(cleanUrl("https://u:p@winkel.example/a/jan@example.com/b?token=abc&gclid=G1#x")).toBe("https://winkel.example/a/redacted/b?gclid=G1");
    expect(endpointOf({ collectorUrl: "https://connect.example/", siteKey: "cs_pub_abcDEF123" })).toBe("https://connect.example/collect?k=cs_pub_abcDEF123");
    expect(endpointOf({ collectorUrl: "https://connect.example", siteKey: "cs_sec_secret" })).toBeUndefined(); // never a secret key in a browser
    expect(endpointOf({ collectorUrl: "http://evil.example", siteKey: "cs_pub_abcDEF123" })).toBeUndefined();
    expect(endpointOf({})).toBeUndefined();
  });
});
