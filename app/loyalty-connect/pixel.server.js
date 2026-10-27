/**
 * The web pixel (extensions/loyalty-connect-pixel), switched on and off with Loyalty Connect, the way Connect's own Shopify app does
 * it: webPixelCreate / webPixelUpdate with the settings {collectorUrl, siteKey}, webPixelDelete when switched off. Shopify loads the
 * pixel only for visitors who granted analytics and marketing (Customer Privacy API; the extension's [customer_privacy]).
 *
 * The pixel needs the optional scopes write_pixels and read_customer_events; a shop that has not granted them yet gets the status
 * "needs_permission" and the admin screen offers the grant.
 */
import { loyaltyConnectUrl } from "./config.server.js";
import { tryDecrypt } from "./crypto.server.js";
import { publicKeyLabel } from "./settings.server.js";
import { deleteWebPixel, ShopifyError, upsertWebPixel } from "./shopify-admin.server.js";

/**
 * Brings the shop's pixel in line with the settings row (with its tenant). shopClient: { shop, token, fetch? }; scopesGranted:
 * whether the shop granted the pixel scopes. Records and returns { status, error }.
 */
export async function syncPixel({ db, row, tenant, shopClient, scopesGranted, now = () => new Date(), collectorUrl = loyaltyConnectUrl() }) {
  const live = Boolean(row.enabled && tenant?.isActive);
  let status;
  let error = null;
  try {
    if (live) {
      const siteKey = tryDecrypt(row.publicKeyEnc, publicKeyLabel(row.tenantId));
      if (!scopesGranted) status = "needs_permission";
      else if (!siteKey) {
        status = "error";
        error = "no readable public key";
      } else {
        const problem = await upsertWebPixel(shopClient, { collectorUrl, siteKey });
        status = problem ? "error" : "installed";
        error = problem ?? null;
      }
    } else if (scopesGranted) {
      const problem = await deleteWebPixel(shopClient);
      status = problem ? "error" : "removed";
      error = problem ?? null;
    } else {
      status = "removed"; // without the pixel scopes this app cannot have created one
    }
  } catch (e) {
    status = e instanceof ShopifyError && e.kind === "access" ? "needs_permission" : "error";
    error = String(e?.message ?? e).slice(0, 300);
  }
  await db.loyaltyConnectSettings.update({ where: { id: row.id }, data: { pixelStatus: status, pixelError: error, pixelUpdatedAt: now() } });
  return { status, error };
}
