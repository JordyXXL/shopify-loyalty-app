// app/routes/webhooks.jsx with Loyalty Connect in it: the Loyalty Engage forwarding makes the same calls and gives Shopify the same
// answer whether Loyalty Connect is off or on, Loyalty Connect off makes no call to it at all, and Loyalty Connect's own topics never
// reach the Loyalty Engage code. Shopify's authentication, the database and every outgoing HTTP call are fakes.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restOrder } from "./fixtures/shopify-orders.js";

const h = vi.hoisted(() => {
  process.env.LOYALTY_CONNECT_URL = "https://connect.test.example";
  return { db: undefined, webhook: undefined };
});

vi.mock("../app/shopify.server.js", () => ({ authenticate: { webhook: (...args) => h.webhook(...args) } }));
vi.mock("../app/db.server.js", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma.js");
  h.db = createFakePrisma();
  return { default: h.db };
});

const { action } = await import("../app/routes/webhooks.jsx");
const { saveSettings } = await import("../app/loyalty-connect/settings.server.js");

const SHOP = "winkel-test.myshopify.com";
const CONNECT_ORIGIN = "https://connect.test.example";
let calls;

beforeEach(() => {
  process.env.LOYALTY_CONNECT_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  for (const name of ["tenant", "session", "loyalty", "loyaltyConnectSettings", "loyaltyConnectQueue"]) h.db[name].rows.length = 0;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    const u = new URL(String(url));
    if (u.origin === CONNECT_ORIGIN) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: body.orders.map((_, index) => ({ index, status: "accepted" })) }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function tenant() {
  return h.db.tenant.create({ data: { name: "main", shopDomain: SHOP, accessToken: "shpat_test", loyaltyLogin: "le-login", loyaltyToken: "le-token" } });
}

/** Runs the route as Shopify would call it; returns the answer (returned or thrown, as Remix sends both). */
async function deliver(topic, payload, { admin = {} } = {}) {
  h.webhook = async () => ({ topic, shop: SHOP, admin, payload, webhookId: `wh-${topic}` });
  let res;
  try {
    res = await action({ request: new Request("https://app.example/webhooks", { method: "POST" }) });
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    res = thrown;
  }
  return { status: res.status, text: await res.text() };
}

const loyaltyEngageCalls = () => calls.filter((c) => !c.url.startsWith(CONNECT_ORIGIN));
const connectCalls = () => calls.filter((c) => c.url.startsWith(CONNECT_ORIGIN));

describe("webhooks route", () => {
  it("orders/create: Loyalty Engage makes the same calls and Shopify gets the same answer with Loyalty Connect off or on", async () => {
    const t = await tenant();
    const off = await deliver("ORDERS_CREATE", restOrder());
    const offCalls = loyaltyEngageCalls();
    expect(offCalls.length).toBeGreaterThan(0);
    expect(offCalls[0].url).toBe("https://app.loyaltyengage.tech/api/v1/events");
    await vi.runAllTimersAsync();
    expect(connectCalls()).toHaveLength(0);
    expect(h.db.loyaltyConnectQueue.rows).toHaveLength(0);

    await saveSettings(h.db, t, { enabled: true, publicKey: "cs_pub_TESTONLYpublic0000", secretKey: "cs_sec_TESTONLYsecret0000" });
    calls = [];
    const on = await deliver("ORDERS_CREATE", restOrder());
    expect(on).toEqual(off);
    expect(loyaltyEngageCalls()).toEqual(offCalls);
    expect(h.db.loyaltyConnectQueue.rows).toHaveLength(1);

    // Loyalty Connect delivers shortly after, on its own
    expect(connectCalls()).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(connectCalls().map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/orders"]);
  });

  it("Loyalty Connect's own topics answer 200 and never reach the Loyalty Engage code; off, they call nothing", async () => {
    await tenant();
    for (const topic of ["ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE"]) {
      expect(await deliver(topic, restOrder())).toEqual({ status: 200, text: "" });
    }
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(0);
    expect(console.log).not.toHaveBeenCalledWith("Webhook Triggered:", expect.anything(), "for shop:", expect.anything());
  });

  it("compliance topics: the same answer as before, with Loyalty Connect off or on", async () => {
    const t = await tenant();
    const payload = { shop_domain: SHOP, customer: { id: 1, email: "someone@mail.example.com" }, orders_to_redact: [6123456789012] };
    const offNoAdmin = await deliver("CUSTOMERS_REDACT", payload, { admin: undefined });
    const offAdmin = await deliver("CUSTOMERS_REDACT", payload);
    const offShop = await deliver("SHOP_REDACT", { shop_domain: SHOP }, { admin: undefined });
    await saveSettings(h.db, t, { enabled: true, publicKey: "cs_pub_TESTONLYpublic0000", secretKey: "cs_sec_TESTONLYsecret0000" });
    expect(await deliver("CUSTOMERS_REDACT", payload, { admin: undefined })).toEqual(offNoAdmin);
    expect(await deliver("CUSTOMERS_REDACT", payload)).toEqual(offAdmin);
    expect(h.db.loyaltyConnectQueue.rows.map((r) => r.kind)).toEqual(["ERASE"]); // the second delivery has the same webhook id
    expect(await deliver("SHOP_REDACT", { shop_domain: SHOP }, { admin: undefined })).toEqual(offShop);
    expect(h.db.loyaltyConnectSettings.rows).toHaveLength(0);
    expect(h.db.loyaltyConnectQueue.rows).toHaveLength(0);
    expect(loyaltyEngageCalls()).toHaveLength(0);
  });
});
