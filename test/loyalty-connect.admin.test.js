// The Loyalty Connect block of the tenant screen: saving installs or removes the web pixel (as Connect's own app does it), asks for
// the pixel permissions when they are missing, the Test button calls the validate endpoint, and a tenant of another shop is refused.
import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { afterTenantChange, loyaltyConnectAction, loyaltyConnectView } from "../app/loyalty-connect/admin.server.js";
import { createQueue } from "../app/loyalty-connect/queue.server.js";
import { createFakePrisma } from "./helpers/fake-prisma.js";

const SHOP = "winkel-test.myshopify.com";
const PUBLIC = "cs_pub_TESTONLYpublickey00000000";
const SECRET = "cs_sec_TESTONLYsecretkey000000000000";

beforeAll(() => {
  process.env.LOYALTY_CONNECT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.LOYALTY_CONNECT_URL = "https://connect.test.example";
});

/** Shopify's Admin GraphQL (shop, webPixel, webPixelCreate/Update/Delete) and Loyalty Connect's validate endpoint, in one fake fetch. */
function fakeNetwork() {
  const state = { pixel: null, calls: [] };
  state.fetch = vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    const u = new URL(url);
    state.calls.push({ host: u.host, path: u.pathname, query: body.query, variables: body.variables, auth: init.headers?.Authorization });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (u.host === "connect.test.example") return reply({ testMode: true, stored: false, subscribed: true, products: ["attribute"], results: [{ index: 0, status: "accepted" }] });
    const q = body.query;
    if (q.includes("primaryDomain")) return reply({ data: { shop: { myshopifyDomain: SHOP, primaryDomain: { host: "www.winkel.example" } } } });
    if (q.includes("webPixelCreate")) { state.pixel = { id: "gid://shopify/WebPixel/1", settings: body.variables.settings }; return reply({ data: { webPixelCreate: { webPixel: { id: state.pixel.id }, userErrors: [] } } }); }
    if (q.includes("webPixelUpdate")) { state.pixel.settings = body.variables.settings; return reply({ data: { webPixelUpdate: { webPixel: { id: state.pixel.id }, userErrors: [] } } }); }
    if (q.includes("webPixelDelete")) { state.pixel = null; return reply({ data: { webPixelDelete: { deletedWebPixelId: "gid://shopify/WebPixel/1", userErrors: [] } } }); }
    if (q.includes("webPixel")) return state.pixel ? reply({ data: { webPixel: state.pixel } }) : reply({ errors: [{ message: "No web pixel was found for this app." }] });
    return reply({ errors: [{ message: "unexpected query" }] });
  });
  return state;
}

const scopesWith = (granted) => ({ query: vi.fn(async () => ({ granted, required: [], optional: ["write_pixels", "read_customer_events"] })), request: vi.fn(async () => undefined) });
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, String(v)); return f; };

let db, net, queue, tenant, session;
beforeEach(async () => {
  db = createFakePrisma();
  net = fakeNetwork();
  queue = createQueue({ db, client: { postOrders: vi.fn(), postErase: vi.fn() } });
  tenant = await db.tenant.create({ data: { name: "main", shopDomain: SHOP, accessToken: "shpat_test" } });
  session = { shop: SHOP, accessToken: "shpat_session" };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const act = (intent, fields, scopes = scopesWith(["write_pixels", "read_customer_events"])) =>
  loyaltyConnectAction({ db, intent, formData: form({ tenantId: tenant.id, ...fields }), session, scopes, queue, fetch: net.fetch });

describe("tenant screen: Loyalty Connect", () => {
  it("saving it on stores the keys encrypted, the storefront domain, and installs the pixel with the public key", async () => {
    const res = await act("loyalty_connect_save", { enabled: "true", publicKey: PUBLIC, secretKey: SECRET });
    expect(res).toEqual({ status: "success", message: "Loyalty Connect saved: on; the browser pixel is installed." });
    expect(JSON.parse(net.pixel.settings)).toEqual({ collectorUrl: "https://connect.test.example", siteKey: PUBLIC });
    expect(net.calls.every((c) => c.host === SHOP && c.path === "/admin/api/2025-01/graphql.json")).toBe(true);
    const row = db.loyaltyConnectSettings.rows[0];
    expect(row).toMatchObject({ enabled: true, storefrontDomain: "www.winkel.example", pixelStatus: "installed", shopDomain: SHOP });
    expect(JSON.stringify(row)).not.toContain(SECRET);

    // the screen sees the public key and a hint, never the secret
    const view = await loyaltyConnectView({ ...db, loyaltyConnectQueue: { ...db.loyaltyConnectQueue, groupBy: async () => [{ tenantId: tenant.id, status: "DONE", _count: { _all: 3 } }] } }, [tenant.id]);
    expect(view.byTenant[tenant.id]).toMatchObject({ enabled: true, publicKey: PUBLIC, secretKeyHint: "cs_sec_…0000", pixelStatus: "installed", counts: { DONE: 3, FAILED: 0 } });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it("without the pixel permissions it says so, and the grant asks Shopify for exactly those scopes", async () => {
    const res = await act("loyalty_connect_save", { enabled: "true", publicKey: PUBLIC, secretKey: SECRET }, scopesWith([]));
    expect(res.message).toMatch(/needs your permission/);
    expect(db.loyaltyConnectSettings.rows[0].pixelStatus).toBe("needs_permission");
    expect(net.pixel).toBeNull();
    const scopes = scopesWith(["write_pixels", "read_customer_events"]);
    await act("loyalty_connect_scopes", {}, scopes);
    expect(scopes.request).toHaveBeenCalledWith(["write_pixels", "read_customer_events"]);
    expect(db.loyaltyConnectSettings.rows[0].pixelStatus).toBe("installed");
  });

  it("switching off removes the pixel and skips what still waits", async () => {
    await act("loyalty_connect_save", { enabled: "true", publicKey: PUBLIC, secretKey: SECRET });
    await queue.enqueue(tenant.id, [{ kind: "ORDER", dedupeKey: "order:1:1", payload: { order: {} } }, { kind: "ERASE", dedupeKey: "erase:1:0", payload: { emailSha256: "0".repeat(64) } }]);
    const res = await act("loyalty_connect_save", { enabled: "false", publicKey: PUBLIC, secretKey: "" });
    expect(res.message).toBe("Loyalty Connect saved: off; the browser pixel is not installed.");
    expect(net.pixel).toBeNull();
    expect(db.loyaltyConnectQueue.rows.map((r) => [r.kind, r.status])).toEqual([["ORDER", "SKIPPED"], ["ERASE", "PENDING"]]);
  });

  it("Test connection calls the validate endpoint with the secret key and records the result", async () => {
    await act("loyalty_connect_save", { enabled: "false", publicKey: PUBLIC, secretKey: SECRET });
    const res = await act("loyalty_connect_test", {});
    expect(res).toMatchObject({ status: "success", message: expect.stringMatching(/^Connected/) });
    const call = net.calls.find((c) => c.host === "connect.test.example");
    expect(call).toMatchObject({ path: "/api/v1/orders/validate", auth: `Bearer ${SECRET}` });
    expect(db.loyaltyConnectSettings.rows[0]).toMatchObject({ lastTestOk: true });
  });

  it("refuses a tenant of another shop, and an unknown key format", async () => {
    session = { shop: "other.myshopify.com", accessToken: "x" };
    expect(await act("loyalty_connect_save", { enabled: "true", publicKey: PUBLIC, secretKey: SECRET })).toEqual({ status: "error", message: "Tenant not found for this shop." });
    session = { shop: SHOP, accessToken: "x" };
    expect((await act("loyalty_connect_save", { enabled: "true", publicKey: SECRET, secretKey: SECRET })).status).toBe("error");
    expect(db.loyaltyConnectSettings.rows).toHaveLength(0);
  });

  it("deactivating or deleting the tenant takes the pixel away; tenants without Loyalty Connect are left alone", async () => {
    await afterTenantChange({ db, tenantId: tenant.id, session, scopes: scopesWith(["write_pixels", "read_customer_events"]), fetch: net.fetch });
    expect(net.calls).toHaveLength(0);
    await act("loyalty_connect_save", { enabled: "true", publicKey: PUBLIC, secretKey: SECRET });
    tenant.isActive = false;
    db.tenant.rows[0].isActive = false;
    await afterTenantChange({ db, tenantId: tenant.id, session, scopes: scopesWith(["write_pixels", "read_customer_events"]), fetch: net.fetch });
    expect(net.pixel).toBeNull();
    expect(db.loyaltyConnectSettings.rows[0].pixelStatus).toBe("removed");
    db.tenant.rows[0].isActive = true;
    await afterTenantChange({ db, tenantId: tenant.id, session, scopes: scopesWith(["write_pixels", "read_customer_events"]), fetch: net.fetch });
    expect(net.pixel).not.toBeNull();
    await afterTenantChange({ db, tenantId: tenant.id, session, scopes: scopesWith(["write_pixels", "read_customer_events"]), deleting: true, fetch: net.fetch });
    expect(net.pixel).toBeNull();
  });
});
