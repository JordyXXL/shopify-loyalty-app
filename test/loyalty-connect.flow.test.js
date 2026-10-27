// Loyalty Connect end to end, with an in-memory database, a fake Loyalty Connect and a fake Shopify Admin API: webhook -> queue ->
// delivery, the per-item answers, retries with backoff, refunds, erasure and shop redaction, and "off means nothing is sent".
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectClient } from "../app/loyalty-connect/client.server.js";
import { decrypt, encrypt } from "../app/loyalty-connect/crypto.server.js";
import { orderFromGraphql, orderFromWebhook } from "../app/loyalty-connect/orders.js";
import { backoffMs, createQueue, MAX_ATTEMPTS } from "../app/loyalty-connect/queue.server.js";
import { publicKeyLabel, queueLabel, saveSettings, secretKeyLabel, settingsForShop } from "../app/loyalty-connect/settings.server.js";
import { createWebhookHandler, LOYALTY_CONNECT_ONLY_TOPICS } from "../app/loyalty-connect/webhooks.server.js";
import { gqlOrder, restOrder, restRefund } from "./fixtures/shopify-orders.js";
import { createFakePrisma } from "./helpers/fake-prisma.js";

const SHOP = "winkel-test.myshopify.com";
const CONNECT = "https://connect.test.example";
const SECRET = "cs_sec_TESTONLYsecretkey000000000000";
const PUBLIC = "cs_pub_TESTONLYpublickey00000000";
const EMAIL = "bob.norman@mail.example.com";

beforeAll(() => {
  process.env.LOYALTY_CONNECT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

/** A fake Loyalty Connect: records every request; `answer` decides the reply per request. */
function fakeConnect() {
  const calls = [];
  const fake = {
    calls,
    answer: (path, body) => {
      if (path === "/api/v1/erase") return { status: 200, body: { erased: true, bufferedRows: 0, subscriptions: 1, waiting: 0 } };
      return { status: 200, body: { accepted: body.orders.length, results: body.orders.map((_, index) => ({ index, status: "accepted", forwarded: 1 })) } };
    },
    fetch: vi.fn(async (url, init) => {
      const u = new URL(url);
      const body = JSON.parse(init.body);
      calls.push({ path: u.pathname, origin: u.origin, auth: init.headers.Authorization, body });
      const out = fake.answer(u.pathname, body);
      if (out.error) throw out.error;
      return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { "content-type": "application/json", ...(out.headers ?? {}) } });
    }),
  };
  return fake;
}

/** A fake Shopify Admin GraphQL endpoint answering order(id:) with `order` (and refusing protected fields when `denyProtected`). */
function fakeShopify(order, { denyProtected = false } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, token: init.headers["x-shopify-access-token"], query: body.query, variables: body.variables });
    if (denyProtected && /customerJourneySummary/.test(body.query)) {
      return new Response(JSON.stringify({ errors: [{ message: "Access denied for customerJourneySummary field. This app is not approved to access protected customer data." }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { order } }), { status: 200 });
  });
  return { calls, fetch };
}

let clock;
let db;
let connect;
let queue;
let handle;
let kicks;
let logs;

async function setup({ enabled = true, active = true, delivered = false } = {}) {
  const tenant = await db.tenant.create({ data: { name: `t-${db.tenant.rows.length + 1}`, shopDomain: SHOP, accessToken: "shpat_test_token", isActive: active } });
  const saved = await saveSettings(db, tenant, { enabled: false, publicKey: PUBLIC, secretKey: SECRET, storefrontDomain: "winkel.example" });
  expect(saved.ok).toBe(true);
  await db.loyaltyConnectSettings.update({ where: { id: saved.row.id }, data: { enabled, ...(delivered ? { lastDeliveryAt: clock.now() } : {}) } });
  return tenant;
}

const webhook = (topic, payload, webhookId = `wh-${Math.random().toString(36).slice(2)}`) => handle({ topic, shop: SHOP, webhookId, payload });
const rows = () => db.loyaltyConnectQueue.rows;

beforeEach(() => {
  let t = Date.parse("2026-10-27T10:00:00Z");
  clock = { now: () => new Date(t), advance: (ms) => { t += ms; } };
  db = createFakePrisma({ now: clock.now });
  connect = fakeConnect();
  kicks = [];
  queue = createQueue({ db, client: createConnectClient({ baseUrl: CONNECT, fetch: connect.fetch, now: () => clock.now().getTime() }), now: clock.now, getAccessToken: async () => "shpat_test_token", wait: async () => undefined });
  handle = createWebhookHandler({ db, queue, now: clock.now, kick: (id) => kicks.push(id) });
  const sink = [];
  logs = sink;
  const capture = (...args) => { sink.push(args.map(String).join(" ")); };
  for (const level of ["log", "info", "warn", "error"]) vi.spyOn(console, level).mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  // nothing this feature logs may carry a customer's e-mail address
  expect(logs.join("\n")).not.toMatch(/@mail\.example\.com|bob\.norman/i);
});

describe("off means nothing goes to Loyalty Connect", () => {
  it("no settings, switched off, or an inactive tenant: nothing is queued and nothing is called", async () => {
    // no settings at all
    expect(await webhook("ORDERS_CREATE", restOrder())).toEqual({ action: "off" });
    // switched off
    await setup({ enabled: false });
    for (const topic of ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED"]) expect(await webhook(topic, restOrder())).toEqual({ action: "off" });
    expect(await webhook("REFUNDS_CREATE", restRefund(9123456789011, "20.00"))).toEqual({ action: "off" });
    expect(await webhook("CUSTOMERS_REDACT", { customer: { email: EMAIL }, orders_to_redact: [6123456789012] })).toEqual({ action: "off" });
    // on, but the tenant is inactive
    db.tenant.rows.length = 0;
    db.loyaltyConnectSettings.rows.length = 0;
    await setup({ enabled: true, active: false });
    expect(await webhook("ORDERS_CREATE", restOrder())).toEqual({ action: "off" });

    expect(rows()).toHaveLength(0);
    expect(kicks).toHaveLength(0);
    expect(await queue.process()).toMatchObject({ delivered: 0, retrying: 0, failed: 0, skipped: 0 });
    expect(connect.fetch).not.toHaveBeenCalled();
  });

  it("a secret key that cannot be read (encryption key changed) counts as no key", async () => {
    await setup();
    const row = db.loyaltyConnectSettings.rows[0];
    row.secretKeyEnc = encrypt(SECRET, "another label");
    expect(await settingsForShop(db, SHOP)).toBeUndefined();
    expect(await webhook("ORDERS_CREATE", restOrder())).toEqual({ action: "off" });
    expect(connect.fetch).not.toHaveBeenCalled();
  });

  it("switching off skips what waits, and the processor skips orders of a tenant that is off", async () => {
    const tenant = await setup();
    await webhook("ORDERS_CREATE", restOrder());
    await webhook("ORDERS_UPDATED", restOrder({ updated_at: "2026-10-19T15:00:00+02:00" }));
    expect(await queue.skipPending(tenant.id)).toBe(2);
    await webhook("ORDERS_UPDATED", restOrder({ updated_at: "2026-10-19T16:00:00+02:00" }));
    db.loyaltyConnectSettings.rows[0].enabled = false;
    expect(await queue.process()).toMatchObject({ skipped: 1, delivered: 0 });
    expect(rows().map((r) => r.status)).toEqual(["SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(rows().every((r) => r.payload === "")).toBe(true);
    expect(connect.fetch).not.toHaveBeenCalled();
  });
});

describe("orders", () => {
  it("queues the mapped order (encrypted), delivers it with the secret key, and records the answer", async () => {
    const tenant = await setup();
    expect(await webhook("ORDERS_CREATE", restOrder())).toEqual({ action: "queued", queued: 1 });
    expect(kicks).toEqual([tenant.id]);
    const [row] = rows();
    expect(row).toMatchObject({ kind: "ORDER", status: "PENDING", dedupeKey: "order:6123456789012:2026-10-19T14:05:14+02:00" });
    // encrypted at rest: the e-mail address is not readable in the database
    expect(row.payload).not.toMatch(/mail\.example|Wandelschoen/);
    expect(JSON.parse(decrypt(row.payload, queueLabel(tenant.id))).order).toEqual(orderFromWebhook(restOrder(), { domain: "winkel.example" }));

    expect(await queue.process({ tenantId: tenant.id })).toMatchObject({ delivered: 1 });
    expect(connect.calls).toHaveLength(1);
    const [call] = connect.calls;
    expect(call).toMatchObject({ origin: CONNECT, path: "/api/v1/orders", auth: `Bearer ${SECRET}` });
    // exactly what Connect's own Shopify app would put through its door for this webhook
    expect(call.body).toEqual({ orders: [orderFromWebhook(restOrder(), { domain: "winkel.example" })] });
    expect(rows()[0]).toMatchObject({ status: "DONE", result: "accepted", payload: "", attempts: 1, lastHttpStatus: 200 });
    const settings = db.loyaltyConnectSettings.rows[0];
    expect(settings.lastDeliveryAt).toEqual(clock.now());
    expect(settings.lastDeliveryStatus).toBe("200 orders: 1 accepted");
  });

  it("one message per order version: a redelivered webhook is not queued twice; updates and cancellation are new versions", async () => {
    await setup();
    await webhook("ORDERS_CREATE", restOrder(), "wh-1");
    expect(await webhook("ORDERS_CREATE", restOrder(), "wh-1-retry")).toEqual({ action: "queued", queued: 0 });
    await webhook("ORDERS_UPDATED", restOrder({ updated_at: "2026-10-19T15:00:00+02:00", fulfillment_status: "fulfilled" }));
    await webhook("ORDERS_CANCELLED", restOrder({ updated_at: "2026-10-20T10:00:01+02:00", cancelled_at: "2026-10-20T10:00:00+02:00" }));
    expect(rows().map((r) => r.dedupeKey)).toEqual([
      "order:6123456789012:2026-10-19T14:05:14+02:00", "order:6123456789012:2026-10-19T15:00:00+02:00", "order:6123456789012:2026-10-20T10:00:01+02:00",
    ]);
    await queue.process();
    // one request, the versions in the order they came
    expect(connect.calls).toHaveLength(1);
    expect(connect.calls[0].body.orders.map((o) => [o.updatedAt, o.fulfillmentStatus, o.cancelledAt])).toEqual([
      ["2026-10-19T14:05:14+02:00", "unfulfilled", null], ["2026-10-19T15:00:00+02:00", "fulfilled", null], ["2026-10-20T10:00:01+02:00", "unfulfilled", "2026-10-20T10:00:00+02:00"],
    ]);
  });

  it("handles Connect's per-item answers: accepted, duplicate, not_forwarded are done; refused fails (resending cannot help)", async () => {
    await setup();
    for (let i = 1; i <= 4; i++) await webhook("ORDERS_CREATE", restOrder({ id: 1000 + i }));
    connect.answer = () => ({
      status: 200,
      body: {
        accepted: 1, duplicates: 1, refused: 1, notForwarded: 1, warning: "no_active_subscription",
        results: [
          { index: 0, status: "accepted", forwarded: 1 }, { index: 1, status: "duplicate" },
          { index: 2, status: "not_forwarded", reason: "no_active_subscription", forwarded: 0 }, { index: 3, status: "refused", reason: "invalid", detail: "lineItems: Too small" },
        ],
      },
    });
    expect(await queue.process()).toMatchObject({ delivered: 3, failed: 1 });
    expect(rows().map((r) => [r.status, r.result])).toEqual([
      ["DONE", "accepted"], ["DONE", "duplicate"], ["DONE", "not_forwarded: no_active_subscription"], ["FAILED", "refused: invalid"],
    ]);
    expect(rows()[3].lastError).toBe("refused by Loyalty Connect: invalid: lineItems: Too small");
    expect(db.loyaltyConnectSettings.rows[0].lastDeliveryStatus).toBe("200 orders: 1 accepted, 1 duplicate, 1 not_forwarded, 1 refused (no_active_subscription)");
    expect(rows().every((r) => r.payload === "")).toBe(true);
  });

  it("retries a 5xx with backoff until Connect accepts", async () => {
    await setup();
    await webhook("ORDERS_CREATE", restOrder());
    connect.answer = () => ({ status: 503, body: { error: "maintenance" } });
    expect(await queue.process()).toMatchObject({ retrying: 1 });
    expect(rows()[0]).toMatchObject({ status: "PENDING", attempts: 1, lastHttpStatus: 503, lastError: "HTTP 503 maintenance" });
    expect(rows()[0].nextAttemptAt).toEqual(new Date(clock.now().getTime() + backoffMs(1)));
    expect(rows()[0].payload).not.toBe("");
    expect(db.loyaltyConnectSettings.rows[0]).toMatchObject({ lastDeliveryStatus: "503 orders: will retry", lastError: "HTTP 503 maintenance" });

    // not due yet: nothing is sent
    await queue.process();
    expect(connect.calls).toHaveLength(1);

    clock.advance(backoffMs(1));
    connect.answer = (_path, body) => ({ status: 200, body: { results: body.orders.map((_, index) => ({ index, status: "accepted" })) } });
    expect(await queue.process()).toMatchObject({ delivered: 1 });
    expect(connect.calls).toHaveLength(2);
    expect(rows()[0]).toMatchObject({ status: "DONE", attempts: 2, result: "accepted" });
    expect(backoffMs(2)).toBe(2 * backoffMs(1));
    expect(backoffMs(30)).toBe(6 * 3600_000);
  });

  it("waits Retry-After on 429, retries network errors and a rejected key, and gives up after MAX_ATTEMPTS", async () => {
    await setup();
    await webhook("ORDERS_CREATE", restOrder());
    connect.answer = () => ({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "600" } });
    await queue.process();
    expect(rows()[0].nextAttemptAt).toEqual(new Date(clock.now().getTime() + 600_000));

    clock.advance(600_000);
    connect.answer = () => ({ error: new TypeError("fetch failed") });
    await queue.process();
    expect(rows()[0]).toMatchObject({ status: "PENDING", attempts: 2, lastError: "network error: fetch failed" });

    connect.answer = () => ({ status: 401, body: { error: "unauthorized" } });
    for (let i = 3; i <= MAX_ATTEMPTS; i++) {
      clock.advance(backoffMs(i));
      await queue.process();
    }
    expect(rows()[0]).toMatchObject({ status: "FAILED", attempts: MAX_ATTEMPTS, payload: "" });
    expect(rows()[0].lastError).toMatch(/^gave up after 15 attempts: unauthorized/);
  });

  it("fails at once on a 400 (the same body would be refused again)", async () => {
    await setup();
    await webhook("ORDERS_CREATE", restOrder());
    connect.answer = () => ({ status: 400, body: { error: "\"orders\" must be a non-empty array" } });
    expect(await queue.process()).toMatchObject({ failed: 1 });
    expect(rows()[0]).toMatchObject({ status: "FAILED", attempts: 1, lastHttpStatus: 400, payload: "" });
  });

  it("two processes never send the same item: a claimed item is left alone, a stale claim is released", async () => {
    await setup();
    await webhook("ORDERS_CREATE", restOrder());
    rows()[0].status = "PROCESSING";
    rows()[0].claimToken = "someone-else";
    rows()[0].lockedAt = clock.now();
    await queue.process();
    expect(connect.fetch).not.toHaveBeenCalled();
    clock.advance(11 * 60_000);
    await queue.process();
    expect(connect.calls).toHaveLength(1);
    expect(rows()[0].status).toBe("DONE");
  });

  it("cleans up: done items after 7 days, failed ones after 30", async () => {
    await setup();
    await webhook("ORDERS_CREATE", restOrder());
    await queue.process();
    clock.advance(8 * 86_400_000);
    expect(await queue.process()).toMatchObject({ cleaned: 1 });
    expect(rows()).toHaveLength(0);
  });
});

describe("refunds/create", () => {
  it("reads the order again through the Admin API and delivers it as a new version (as Connect's own app does)", async () => {
    const tenant = await setup();
    const shopify = fakeShopify(gqlOrder(6123456789012));
    queue = createQueue({ db, client: createConnectClient({ baseUrl: CONNECT, fetch: connect.fetch }), now: clock.now, getAccessToken: async (shop) => (shop === SHOP ? "shpat_offline" : undefined), shopifyFetch: shopify.fetch, wait: async () => undefined });
    handle = createWebhookHandler({ db, queue, now: clock.now, kick: () => undefined });
    expect(await webhook("REFUNDS_CREATE", restRefund(9123456789011, "20.00"))).toEqual({ action: "queued", queued: 1 });
    expect(rows()[0]).toMatchObject({ kind: "REFUND", dedupeKey: "refund:6123456789012:9123456789011" });
    expect(JSON.parse(decrypt(rows()[0].payload, queueLabel(tenant.id)))).toEqual({ orderId: "6123456789012" });

    await queue.process();
    expect(shopify.calls).toHaveLength(1);
    expect(shopify.calls[0]).toMatchObject({ url: `https://${SHOP}/admin/api/2025-01/graphql.json`, token: "shpat_offline", variables: { id: "gid://shopify/Order/6123456789012" } });
    expect(connect.calls[0].body).toEqual({ orders: [orderFromGraphql(gqlOrder(6123456789012), { domain: "winkel.example" })] });
    expect(rows()[0]).toMatchObject({ status: "DONE", result: "accepted" });
  });

  it("asks again without protected customer data when Shopify refuses it", async () => {
    await setup();
    const shopify = fakeShopify(gqlOrder(6123456789012), { denyProtected: true });
    queue = createQueue({ db, client: createConnectClient({ baseUrl: CONNECT, fetch: connect.fetch }), now: clock.now, getAccessToken: async () => "shpat_offline", shopifyFetch: shopify.fetch, wait: async () => undefined });
    handle = createWebhookHandler({ db, queue, now: clock.now, kick: () => undefined });
    await webhook("REFUNDS_CREATE", restRefund(9123456789011, "20.00"));
    await queue.process();
    expect(shopify.calls).toHaveLength(2);
    expect(shopify.calls[1].query).not.toMatch(/customerJourneySummary|email|shippingAddress/);
    expect(connect.calls).toHaveLength(1);
  });

  it("an order Shopify no longer has is done without a call to Connect", async () => {
    await setup();
    const shopify = fakeShopify(null);
    queue = createQueue({ db, client: createConnectClient({ baseUrl: CONNECT, fetch: connect.fetch }), now: clock.now, getAccessToken: async () => "shpat_offline", shopifyFetch: shopify.fetch, wait: async () => undefined });
    handle = createWebhookHandler({ db, queue, now: clock.now, kick: () => undefined });
    await webhook("REFUNDS_CREATE", restRefund(9123456789011, "20.00"));
    await queue.process();
    expect(rows()[0]).toMatchObject({ status: "DONE", result: "ignored: order not found" });
    expect(connect.fetch).not.toHaveBeenCalled();
  });
});

describe("GDPR", () => {
  const sha = (s) => createHash("sha256").update(s).digest("hex");

  it("customers/redact: an erase with the e-mail as SHA-256 and the order ids; the address itself is never stored", async () => {
    const tenant = await setup();
    const res = await webhook("CUSTOMERS_REDACT", { shop_id: 954889, shop_domain: SHOP, customer: { id: 7012345678901, email: "  BOB.Norman@mail.example.com ", phone: "+31612345678" }, orders_to_redact: [6123456789012, "gid://shopify/Order/6123456789013", "x"] }, "wh-redact-1");
    expect(res).toEqual({ action: "queued", queued: 1 });
    const [row] = rows();
    expect(row).toMatchObject({ kind: "ERASE", dedupeKey: "erase:wh-redact-1:0" });
    const stored = decrypt(row.payload, queueLabel(tenant.id));
    expect(JSON.parse(stored)).toEqual({ emailSha256: sha(EMAIL), orderExternalIds: ["6123456789012", "6123456789013"] });
    expect(stored).not.toMatch(/@|mail\.example|\+316/i);

    await queue.process();
    expect(connect.calls).toEqual([{ path: "/api/v1/erase", origin: CONNECT, auth: `Bearer ${SECRET}`, body: { emailSha256: sha(EMAIL), orderExternalIds: ["6123456789012", "6123456789013"] } }]);
    expect(rows()[0]).toMatchObject({ status: "DONE", result: "erased", payload: "" });
  });

  it("customers/redact splits more than 1000 order ids (Connect's limit), the first part with the hash; without e-mail and orders nothing is sent", async () => {
    await setup();
    const orders = Array.from({ length: 1500 }, (_, i) => 7000000000000 + i);
    await webhook("CUSTOMERS_REDACT", { customer: { email: EMAIL }, orders_to_redact: orders }, "wh-big");
    await queue.process();
    expect(connect.calls.map((c) => [c.body.emailSha256 ? "hash" : "-", c.body.orderExternalIds.length])).toEqual([["hash", 1000], ["-", 500]]);
    expect(await webhook("CUSTOMERS_REDACT", { customer: { id: 1 }, orders_to_redact: [] })).toEqual({ action: "nothing to erase" });
  });

  it("customers/redact still reaches Loyalty Connect for a tenant switched off after it sent data, never for one that sent nothing", async () => {
    await setup({ enabled: false, delivered: true });
    expect(await webhook("CUSTOMERS_REDACT", { customer: { email: EMAIL } })).toEqual({ action: "queued", queued: 1 });
    await queue.process();
    expect(connect.calls.map((c) => c.path)).toEqual(["/api/v1/erase"]);

    db.tenant.rows.length = 0;
    db.loyaltyConnectSettings.rows.length = 0;
    await setup({ enabled: false, delivered: false });
    expect(await webhook("CUSTOMERS_REDACT", { customer: { email: EMAIL } })).toEqual({ action: "off" });
  });

  it("shop/redact deletes the shop's Loyalty Connect settings and queued messages, and nothing of another shop", async () => {
    const tenant = await setup();
    await webhook("ORDERS_CREATE", restOrder());
    const other = await db.tenant.create({ data: { name: "other", shopDomain: "other.myshopify.com", accessToken: "x" } });
    await saveSettings(db, other, { enabled: true, publicKey: PUBLIC, secretKey: SECRET });
    await db.loyaltyConnectQueue.create({ data: { tenantId: other.id, kind: "ORDER", dedupeKey: "order:1:1", payload: "" } });

    expect(await webhook("SHOP_REDACT", { shop_id: 954889, shop_domain: SHOP })).toEqual({ action: "dropped", settings: 1, queued: 1 });
    expect(db.loyaltyConnectSettings.rows.map((r) => r.tenantId)).toEqual([other.id]);
    expect(rows().map((r) => r.tenantId)).toEqual([other.id]);
    expect(db.tenant.rows.map((t) => t.id)).toContain(tenant.id); // the Loyalty Engage tenant itself stays
    await queue.process();
    expect(connect.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
  });

  it("customers/data_request sends nothing (documented: Loyalty Connect's own privacy request flow)", async () => {
    await setup();
    expect(await webhook("CUSTOMERS_DATA_REQUEST", { customer: { email: EMAIL }, orders_requested: [1] })).toEqual({ action: "documented" });
    expect(rows()).toHaveLength(0);
  });
});

describe("robustness", () => {
  it("the webhook handler never throws (a broken database is logged, the webhook goes on)", async () => {
    const broken = createWebhookHandler({ db: { loyaltyConnectSettings: { findMany: async () => { throw new Error("db down"); } } }, queue });
    expect(await broken({ topic: "ORDERS_CREATE", shop: SHOP, webhookId: "x", payload: restOrder() })).toEqual({ action: "error" });
    expect(logs.join("\n")).toMatch(/ORDERS_CREATE for winkel-test\.myshopify\.com failed: db down/);
  });

  it("Loyalty Connect's own topics are exactly the three the Loyalty Engage code never handled", () => {
    expect([...LOYALTY_CONNECT_ONLY_TOPICS].sort()).toEqual(["ORDERS_CANCELLED", "ORDERS_UPDATED", "REFUNDS_CREATE"]);
  });

  it("keys are stored encrypted, bound to their tenant", async () => {
    const tenant = await setup();
    const row = db.loyaltyConnectSettings.rows[0];
    expect(row.secretKeyEnc).not.toContain(SECRET);
    expect(row.publicKeyEnc).not.toContain(PUBLIC);
    expect(row.secretKeyHint).toBe("cs_sec_…0000");
    expect(decrypt(row.secretKeyEnc, secretKeyLabel(tenant.id))).toBe(SECRET);
    expect(decrypt(row.publicKeyEnc, publicKeyLabel(tenant.id))).toBe(PUBLIC);
    expect(() => decrypt(row.secretKeyEnc, secretKeyLabel(tenant.id + 1))).toThrow();
  });

  it("settings: switching on needs both keys, one tenant per shop, and switching off always works", async () => {
    const a = await db.tenant.create({ data: { name: "a", shopDomain: SHOP, accessToken: "x" } });
    const b = await db.tenant.create({ data: { name: "b", shopDomain: SHOP, accessToken: "x" } });
    expect((await saveSettings(db, a, { enabled: true, publicKey: PUBLIC })).ok).toBe(false);
    expect((await saveSettings(db, a, { enabled: true, publicKey: "cs_sec_wrongkind", secretKey: SECRET })).ok).toBe(false);
    expect((await saveSettings(db, a, { enabled: true, publicKey: PUBLIC, secretKey: SECRET })).ok).toBe(true);
    expect(await saveSettings(db, b, { enabled: true, publicKey: PUBLIC, secretKey: SECRET })).toMatchObject({ ok: false, message: expect.stringMatching(/another tenant/) });
    // an empty secret keeps the stored one
    expect((await saveSettings(db, a, { enabled: true, publicKey: PUBLIC, secretKey: "" })).ok).toBe(true);
    expect(decrypt(db.loyaltyConnectSettings.rows[0].secretKeyEnc, secretKeyLabel(a.id))).toBe(SECRET);
    const key = process.env.LOYALTY_CONNECT_ENCRYPTION_KEY;
    delete process.env.LOYALTY_CONNECT_ENCRYPTION_KEY;
    try {
      expect((await saveSettings(db, a, { enabled: false })).ok).toBe(true);
      expect((await saveSettings(db, a, { enabled: true, publicKey: PUBLIC, secretKey: SECRET })).ok).toBe(false);
    } finally {
      process.env.LOYALTY_CONNECT_ENCRYPTION_KEY = key;
    }
  });
});
