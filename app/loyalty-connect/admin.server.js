/**
 * The Loyalty Connect block of the tenant screen (app/routes/app.tenants.jsx): what the loader shows and what its buttons do.
 * Every action checks that the tenant belongs to the shop of the admin session. Keys go in, never out: the screen sees the public
 * key (it is public: it ends up in the storefront) and a hint of the secret key, never the secret itself.
 */
import { createConnectClient } from "./client.server.js";
import { encryptionReady, tryDecrypt } from "./crypto.server.js";
import { loyaltyConnectUrl, PIXEL_SCOPES } from "./config.server.js";
import { syncPixel } from "./pixel.server.js";
import { saveSettings, secretKeyLabel, settingsView } from "./settings.server.js";
import { deleteWebPixel, primaryDomain } from "./shopify-admin.server.js";

export const LOYALTY_CONNECT_INTENTS = new Set(["loyalty_connect_save", "loyalty_connect_test", "loyalty_connect_pixel", "loyalty_connect_scopes"]);

/** The block's data for every tenant on the screen. Never throws: without the tables (migration not applied) it says so. */
export async function loyaltyConnectView(db, tenantIds) {
  const base = { available: true, encryptionReady: encryptionReady(), connectUrl: loyaltyConnectUrl(), byTenant: {} };
  if (!tenantIds.length) return base;
  try {
    const rows = await db.loyaltyConnectSettings.findMany({ where: { tenantId: { in: tenantIds } } });
    const grouped = await db.loyaltyConnectQueue.groupBy({ by: ["tenantId", "status"], where: { tenantId: { in: tenantIds } }, _count: { _all: true } });
    const counts = {};
    for (const g of grouped) counts[g.tenantId] = { ...(counts[g.tenantId] ?? {}), [g.status]: g._count._all };
    for (const id of tenantIds) base.byTenant[id] = settingsView(rows.find((r) => r.tenantId === id), counts[id]);
    return base;
  } catch (e) {
    console.error(`[LoyaltyConnect] admin view failed: ${e.message}`);
    return { ...base, available: false };
  }
}

async function pixelScopesGranted(scopes) {
  try {
    const detail = await scopes.query();
    return PIXEL_SCOPES.every((s) => detail.granted.includes(s));
  } catch {
    return false;
  }
}

const PIXEL_TEXT = {
  installed: "the browser pixel is installed",
  removed: "the browser pixel is not installed",
  needs_permission: "the browser pixel needs your permission (Grant pixel permissions)",
  error: "the browser pixel could not be set up",
};

/**
 * One button of the block. Returns { status: "success" | "error", message }. "loyalty_connect_scopes" may throw Shopify's redirect
 * to the permission screen (scopes.request), which the route lets through.
 */
export async function loyaltyConnectAction({ db, intent, formData, session, scopes, queue, fetch: doFetch }) {
  const tenantId = parseInt(formData.get("tenantId"), 10);
  const tenant = Number.isInteger(tenantId) ? await db.tenant.findFirst({ where: { id: tenantId, shopDomain: session.shop } }) : null;
  if (!tenant) return { status: "error", message: "Tenant not found for this shop." };
  const shopClient = { shop: session.shop, token: session.accessToken, fetch: doFetch };

  if (intent === "loyalty_connect_save") {
    const enabled = formData.get("enabled") === "true";
    const storefrontDomain = await primaryDomain(shopClient).catch(() => undefined);
    const saved = await saveSettings(db, tenant, { enabled, publicKey: formData.get("publicKey"), secretKey: formData.get("secretKey"), storefrontDomain });
    if (!saved.ok) return { status: "error", message: saved.message };
    if (!enabled) await queue.skipPending(tenant.id);
    const pixel = await syncPixel({ db, row: saved.row, tenant, shopClient, scopesGranted: await pixelScopesGranted(scopes) });
    return { status: "success", message: `Loyalty Connect saved: ${enabled ? "on" : "off"}; ${PIXEL_TEXT[pixel.status] ?? pixel.status}${pixel.error ? ` (${pixel.error})` : ""}.` };
  }

  const row = await db.loyaltyConnectSettings.findFirst({ where: { tenantId: tenant.id } });
  if (!row) return { status: "error", message: "Save the Loyalty Connect settings first." };

  if (intent === "loyalty_connect_test") {
    const secretKey = tryDecrypt(row.secretKeyEnc, secretKeyLabel(tenant.id));
    const result = secretKey
      ? await createConnectClient({ fetch: doFetch }).validate(secretKey)
      : { ok: false, message: "No readable secret key stored (enter it again, and check LOYALTY_CONNECT_ENCRYPTION_KEY)." };
    await db.loyaltyConnectSettings.update({ where: { id: row.id }, data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message } });
    return { status: result.ok ? "success" : "error", message: result.message };
  }

  if (intent === "loyalty_connect_scopes") {
    // a full-page redirect to Shopify's permission screen when the scopes are missing; returns when they are granted
    await scopes.request(PIXEL_SCOPES);
  }

  if (intent === "loyalty_connect_scopes" || intent === "loyalty_connect_pixel") {
    const pixel = await syncPixel({ db, row, tenant, shopClient, scopesGranted: await pixelScopesGranted(scopes) });
    return { status: pixel.status === "error" ? "error" : "success", message: `Browser pixel: ${PIXEL_TEXT[pixel.status] ?? pixel.status}${pixel.error ? ` (${pixel.error})` : ""}.` };
  }

  return { status: "error", message: "Unknown Loyalty Connect action." };
}

/**
 * After a tenant is changed (active/inactive) or before it is deleted: a tenant with Loyalty Connect on keeps the shop's pixel in
 * line (an inactive or deleted tenant sends nothing, so its pixel goes). Best effort, and nothing at all for tenants without it.
 */
export async function afterTenantChange({ db, tenantId, session, scopes, deleting = false, fetch: doFetch }) {
  try {
    const row = await db.loyaltyConnectSettings.findFirst({ where: { tenantId }, include: { tenant: true } });
    // only a tenant of the admin's own shop: the pixel is changed with this shop's token
    if (!row?.enabled || row.shopDomain !== session.shop || row.tenant?.shopDomain !== session.shop) return;
    const shopClient = { shop: session.shop, token: session.accessToken, fetch: doFetch };
    const granted = await pixelScopesGranted(scopes);
    if (deleting) {
      if (granted) await deleteWebPixel(shopClient);
      return;
    }
    await syncPixel({ db, row, tenant: row.tenant, shopClient, scopesGranted: granted });
  } catch (e) {
    console.error(`[LoyaltyConnect] pixel update for tenant ${tenantId} failed: ${e.message}`);
  }
}
