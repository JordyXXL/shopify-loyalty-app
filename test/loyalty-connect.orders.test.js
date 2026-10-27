// The order mapping equals Loyalty Connect's own Shopify mapping: the expected outputs below are Connect's own golden expectations
// (Connect test/platform-shopify.test.ts "Shopify orders -> the generic order contract") for the same fixtures.
import { describe, expect, it } from "vitest";
import { clampMoney, money, subMoney, sumMoney } from "../app/loyalty-connect/money.js";
import { landingUrl, numericId, orderFromGraphql, orderFromWebhook, shippingRegion, SURVEY_ATTRIBUTE, surveyFrom } from "../app/loyalty-connect/orders.js";
import { gqlOrder, restOrder, restRefund } from "./fixtures/shopify-orders.js";

describe("Shopify orders -> Loyalty Connect's order contract (golden, as Connect's own app maps them)", () => {
  it("maps an orders/create webhook (golden), reading only the e-mail address of the customer", () => {
    const body = orderFromWebhook(restOrder(), { domain: "winkel.example" });
    expect(body).toEqual({
      externalId: "6123456789012", createdAt: "2026-10-19T14:05:12+02:00", updatedAt: "2026-10-19T14:05:14+02:00", cancelledAt: null, currency: "EUR",
      fulfillmentStatus: "unfulfilled", test: false,
      pricing: { subtotal: "90.00", totalDiscounts: "10.00", totalTax: "16.48", totalShipping: "4.95", totalPrice: "94.95", totalReceived: "94.95", netPayment: "94.95" },
      discountCodes: ["WELKOM10"], customer: { externalId: "7012345678901", email: "bob.norman@mail.example.com" },
      lineItems: [
        { externalId: "14123456789011", title: "Wandelschoen", quantity: 1, originalUnitPrice: "80.00" },
        { externalId: "14123456789012", title: "Sokken", quantity: 2, originalUnitPrice: "10.00" },
      ],
      refunds: [],
      landingUrl: "https://winkel.example/collections/schoenen?utm_source=instagram&utm_medium=social&utm_campaign=herfst&fbclid=IwAR0abc",
      referrer: "https://l.instagram.com/", attributionSurvey: "instagram_facebook", shippingAddress: { countryCode: "NL", provinceCode: "NH" },
    });
    expect(JSON.stringify(body)).not.toMatch(/Norman|Keizersgracht|203\.0\.113|Safari|cadeau|statuskey|\+316|Amsterdam|1015|Noord-Holland/);
  });

  it("maps refunds and cancellation: successful refund transactions only, netPayment after refunds", () => {
    const body = orderFromWebhook(restOrder({
      cancelled_at: "2026-10-20T10:00:00+02:00", cancel_reason: "customer", financial_status: "partially_refunded", fulfillment_status: "partial",
      updated_at: "2026-10-20T10:00:01+02:00", refunds: [restRefund(9123456789011, "20.00"), restRefund(9123456789021, "4.95", { created_at: "2026-10-20T09:45:00+02:00" })],
    }), { domain: "winkel.example" });
    expect(body).toMatchObject({
      cancelledAt: "2026-10-20T10:00:00+02:00", fulfillmentStatus: "partially_fulfilled",
      pricing: { totalPrice: "94.95", totalReceived: "94.95", netPayment: "70.00" },
      refunds: [
        { externalId: "9123456789011", createdAt: "2026-10-20T09:30:00+02:00", totalRefunded: "20.00" },
        { externalId: "9123456789021", createdAt: "2026-10-20T09:45:00+02:00", totalRefunded: "4.95" },
      ],
    });
    // an unpaid order: nothing received yet
    expect(orderFromWebhook(restOrder({ total_outstanding: "94.95", financial_status: "pending" }), { domain: "w.example" }).pricing).toMatchObject({ totalReceived: "0.00", netPayment: "0.00" });
  });

  it("maps a GraphQL order (refunds/create) to the same shape (golden)", () => {
    expect(orderFromGraphql(gqlOrder(5550001), { domain: "winkel.example" })).toEqual({
      externalId: "5550001", createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T08:00:00Z", cancelledAt: null, currency: "EUR", fulfillmentStatus: "fulfilled", test: false,
      pricing: { subtotal: "45.00", totalDiscounts: "5.00", totalTax: "7.81", totalShipping: "0.00", totalPrice: "45.00", totalReceived: "45.00", netPayment: "35.00" },
      discountCodes: ["HERFST"], customer: { externalId: "order-5550001", email: "gql.customer@mail.example.com" },
      lineItems: [{ externalId: "55500011", title: "Shirt", quantity: 1, originalUnitPrice: "50.00" }],
      refunds: [{ externalId: "55500019", createdAt: "2026-10-02T08:00:00Z", totalRefunded: "10.00" }],
      landingUrl: "https://winkel.example/?utm_source=google&gclid=Cj0K", referrer: "https://www.google.com/", attributionSurvey: "google",
      shippingAddress: { countryCode: "BE", provinceCode: "VAN" },
    });
    expect(orderFromGraphql(gqlOrder(5550002, { customAttributes: [{ key: "valtracs_survey", value: "Mijn buurvrouw" }] }), { domain: "w.example" })).not.toHaveProperty("attributionSurvey");
  });

  it("a GraphQL order read without protected customer data comes without customer and region", () => {
    const { email: _e, shippingAddress: _s, customerJourneySummary: _c, ...bare } = gqlOrder(5550003);
    const body = orderFromGraphql(bare, { domain: "winkel.example" });
    expect(body).not.toHaveProperty("customer");
    expect(body).not.toHaveProperty("shippingAddress");
    expect(body).not.toHaveProperty("landingUrl");
    expect(body.externalId).toBe("5550003");
  });

  it("the event of the web pixel and the order share the order id", () => {
    expect(orderFromWebhook({ id: 6123456789012, created_at: "2026-10-20T12:00:00Z", line_items: [] }, { domain: "winkel.example" }).externalId).toBe("6123456789012");
  });

  it("e-mail falls back from customer to email to contact_email, and is left out when there is none", () => {
    expect(orderFromWebhook(restOrder({ customer: null, email: "", contact_email: "c@mail.example.com" }), { domain: "w.example" }).customer).toEqual({ externalId: "order-6123456789012", email: "c@mail.example.com" });
    expect(orderFromWebhook(restOrder({ customer: null, email: null, contact_email: null }), { domain: "w.example" })).not.toHaveProperty("customer");
  });
});

describe("the small helpers behave as Connect's", () => {
  it("money as decimal strings", () => {
    expect(money("12.3")).toBe("12.30");
    expect(money(12.34567)).toBe("12.3457");
    expect(money("-4.5")).toBe("-4.50");
    expect(money("abc")).toBeUndefined();
    expect(sumMoney(["1.10", "2.205", null])).toBe("3.305");
    expect(subMoney("10", "2.5")).toBe("7.50");
    expect(clampMoney("120.00", "0", "100.00")).toBe("100.00");
    expect(clampMoney("-5", "0", "100.00")).toBe("0.00");
  });

  it("ids, landing URLs, regions and the survey", () => {
    expect(numericId("gid://shopify/Order/820982911946154508")).toBe("820982911946154508");
    expect(numericId(42)).toBe("42");
    expect(landingUrl("/a?b=1", "shop.example")).toBe("https://shop.example/a?b=1");
    expect(landingUrl("https://x.example/", "shop.example")).toBe("https://x.example/");
    expect(landingUrl("relative", "shop.example")).toBeUndefined();
    expect(shippingRegion("nl", "nh")).toEqual({ countryCode: "NL", provinceCode: "NH" });
    expect(shippingRegion("1", "NH")).toBeUndefined();
    expect(surveyFrom([{ name: SURVEY_ATTRIBUTE, value: " TikTok " }])).toBe("tiktok");
    expect(surveyFrom([{ key: SURVEY_ATTRIBUTE, value: "free text" }])).toBeUndefined();
  });
});
