/**
 * Where Loyalty Connect lives. Configuration only, so a change of domain needs no code change.
 *
 *   LOYALTY_CONNECT_URL   the origin of Loyalty Connect, without a path (default https://connect.valtracs.com). The server API
 *                         (/api/v1/...) and the browser collector (/collect) are both under it; the web pixel gets it as its
 *                         collectorUrl, and the pixel only accepts an https origin (or http://localhost for development).
 */
export const DEFAULT_LOYALTY_CONNECT_URL = "https://connect.valtracs.com";

/** The configured origin, without a trailing slash. A value that is not an https origin (or http://localhost) falls back to the default. */
export function loyaltyConnectUrl(env = process.env) {
  const raw = String(env.LOYALTY_CONNECT_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_LOYALTY_CONNECT_URL;
  if (/^https:\/\/[^\s/]+$/.test(raw) || /^http:\/\/localhost(:\d+)?$/.test(raw)) return raw;
  console.error("[LoyaltyConnect] LOYALTY_CONNECT_URL must be an https origin without a path; using the default");
  return DEFAULT_LOYALTY_CONNECT_URL;
}

/** The scopes the web pixel needs (webPixelCreate/Update/Delete). Optional scopes: asked for only when a shop switches Loyalty Connect on. */
export const PIXEL_SCOPES = ["write_pixels", "read_customer_events"];

/** Key formats, as Connect checks them (cs_pub_ for the browser, cs_sec_ for the server API; at most 200 characters). */
export const PUBLIC_KEY_RE = /^cs_pub_[A-Za-z0-9_-]{4,100}$/;
export const SECRET_KEY_RE = /^cs_sec_[A-Za-z0-9_-]{4,190}$/;

/** The Admin API version this app uses everywhere (shopify.server.js ApiVersion.January25, webhooks api_version in the toml). */
export const SHOPIFY_ADMIN_API_VERSION = "2025-01";
