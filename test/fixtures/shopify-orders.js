/**
 * Shopify order fixtures, copied from Loyalty Connect's own Shopify tests (Connect test/platform-shopify.test.ts "fixtures"), so the
 * golden outputs in test/loyalty-connect.orders.test.js are Connect's own expectations for the same payloads. All data is made up
 * (example.com addresses, a TEST-NET IP address).
 */

/** A REST order as the orders/create webhook sends it (shopify.dev webhook reference, with realistic ids and Dutch data). */
export function restOrder(over = {}, pii = { email: "bob.norman@mail.example.com", first: "Bob", last: "Norman", street: "Keizersgracht 123", ip: "203.0.113.17", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15" }) {
  return {
    id: 6123456789012, admin_graphql_api_id: "gid://shopify/Order/6123456789012", app_id: 580111, browser_ip: pii.ip, buyer_accepts_marketing: true,
    cancel_reason: null, cancelled_at: null, cart_token: "Z2NwLWV1cm9wZS13ZXN0NDowMUpYWVo", checkout_id: 37000000001, checkout_token: "bd5a8aa1ecd019dd3520ff791ee3a24c",
    client_details: { accept_language: "nl-NL", browser_height: null, browser_ip: pii.ip, browser_width: null, session_hash: null, user_agent: pii.ua },
    confirmation_number: "XPB7J3KQ2", confirmed: true, contact_email: pii.email, created_at: "2026-10-19T14:05:12+02:00", currency: "EUR",
    current_subtotal_price: "90.00", current_total_discounts: "10.00", current_total_price: "94.95", current_total_tax: "16.48", customer_locale: "nl",
    discount_codes: [{ code: "WELKOM10", amount: "10.00", type: "fixed_amount" }], email: pii.email, estimated_taxes: false, financial_status: "paid", fulfillment_status: null,
    landing_site: "/collections/schoenen?utm_source=instagram&utm_medium=social&utm_campaign=herfst&fbclid=IwAR0abc", landing_site_ref: null,
    name: "#1001", note: `Graag als cadeau inpakken, groet ${pii.first}`, note_attributes: [{ name: "valtracs_survey", value: "instagram_facebook" }, { name: "gift_wrap", value: "ja" }],
    number: 1, order_number: 1001, order_status_url: "https://winkel.example/55/orders/abc/authenticate?key=statuskey9f8e7d", payment_gateway_names: ["shopify_payments"],
    phone: "+31612345678", presentment_currency: "EUR", processed_at: "2026-10-19T14:05:11+02:00", referring_site: "https://l.instagram.com/", source_name: "web",
    subtotal_price: "90.00", subtotal_price_set: { shop_money: { amount: "90.00", currency_code: "EUR" }, presentment_money: { amount: "90.00", currency_code: "EUR" } },
    tags: "", tax_lines: [{ price: "16.48", rate: 0.21, title: "BTW" }], taxes_included: true, test: false, token: "b1946ac92492d2347c6235b4d2611184",
    total_discounts: "10.00", total_line_items_price: "100.00", total_outstanding: "0.00", total_price: "94.95",
    total_shipping_price_set: { shop_money: { amount: "4.95", currency_code: "EUR" }, presentment_money: { amount: "4.95", currency_code: "EUR" } },
    total_tax: "16.48", total_tip_received: "0.00", total_weight: 1200, updated_at: "2026-10-19T14:05:14+02:00", user_id: null,
    billing_address: { first_name: pii.first, last_name: pii.last, address1: pii.street, city: "Amsterdam", zip: "1015 CJ", country: "Netherlands", country_code: "NL", phone: "+31612345678", name: `${pii.first} ${pii.last}` },
    shipping_address: { first_name: pii.first, last_name: pii.last, address1: pii.street, city: "Amsterdam", zip: "1015 CJ", country: "Netherlands", country_code: "NL", province: "Noord-Holland", province_code: "NH", latitude: 52.37, longitude: 4.88, phone: "+31612345678" },
    customer: { id: 7012345678901, email: pii.email, first_name: pii.first, last_name: pii.last, phone: "+31612345678", state: "enabled", verified_email: true, default_address: { address1: pii.street, city: "Amsterdam", zip: "1015 CJ" } },
    line_items: [
      { id: 14123456789011, admin_graphql_api_id: "gid://shopify/LineItem/14123456789011", name: "Wandelschoen - 42", price: "80.00", price_set: { shop_money: { amount: "80.00", currency_code: "EUR" } }, product_id: 8123456789011, quantity: 1, sku: "WS-42", title: "Wandelschoen", variant_id: 45123456789011, variant_title: "42", vendor: "Testmerk", total_discount: "0.00", tax_lines: [] },
      { id: 14123456789012, admin_graphql_api_id: "gid://shopify/LineItem/14123456789012", name: "Sokken", price: "10.00", price_set: { shop_money: { amount: "10.00", currency_code: "EUR" } }, product_id: 8123456789012, quantity: 2, sku: "SOK", title: "Sokken", variant_id: 45123456789012, variant_title: null, vendor: "Testmerk", total_discount: "0.00", tax_lines: [] },
    ],
    refunds: [], shipping_lines: [{ id: 5123456789011, price: "4.95", title: "PostNL" }],
    ...over,
  };
}

/** A REST refund inside an order (refunds/create sends the same object on its own). */
export const restRefund = (id, amount, over = {}) => ({
  id, order_id: 6123456789012, created_at: "2026-10-20T09:30:00+02:00", note: "retour", processed_at: "2026-10-20T09:30:00+02:00", restock: true,
  refund_line_items: [{ id: id + 1, line_item_id: 14123456789012, quantity: 2, subtotal: 20, total_tax: 3.47 }],
  transactions: [{ id: id + 2, amount, kind: "refund", status: "success", gateway: "shopify_payments", currency: "EUR" }, { id: id + 3, amount: "5.00", kind: "refund", status: "failure", currency: "EUR" }],
  ...over,
});

/** A GraphQL order with the fields of orderFields. */
export const gqlOrder = (id, over = {}) => ({
  id: `gid://shopify/Order/${id}`, legacyResourceId: String(id), createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T08:00:00Z", cancelledAt: null, test: false,
  currencyCode: "EUR", displayFulfillmentStatus: "FULFILLED", discountCodes: ["HERFST"], customAttributes: [{ key: "valtracs_survey", value: "google" }],
  email: "gql.customer@mail.example.com",
  customerJourneySummary: { firstVisit: { landingPage: "https://winkel.example/?utm_source=google&gclid=Cj0K", referrerUrl: "https://www.google.com/" }, lastVisit: null },
  subtotalPriceSet: { shopMoney: { amount: "45.0" } }, totalDiscountsSet: { shopMoney: { amount: "5.0" } }, totalTaxSet: { shopMoney: { amount: "7.81" } },
  totalShippingPriceSet: { shopMoney: { amount: "0.0" } }, totalPriceSet: { shopMoney: { amount: "45.0" } }, totalReceivedSet: { shopMoney: { amount: "45.0" } },
  netPaymentSet: { shopMoney: { amount: "35.0" } },
  shippingAddress: { countryCodeV2: "BE", provinceCode: "VAN", address1: "Meir 1", city: "Antwerpen", zip: "2000", firstName: "Gql", lastName: "Klant" },
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/LineItem/${id}1`, title: "Shirt", quantity: 1, originalUnitPriceSet: { shopMoney: { amount: "50.0" } } }] },
  refunds: [{ id: `gid://shopify/Refund/${id}9`, createdAt: "2026-10-02T08:00:00Z", totalRefundedSet: { shopMoney: { amount: "10.0" } } }],
  ...over,
});
