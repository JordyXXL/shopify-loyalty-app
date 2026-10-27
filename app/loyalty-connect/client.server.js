/**
 * Loyalty Connect's server API, as this app calls it (Connect README "Server APIs"):
 *
 *   POST /api/v1/orders            {"orders": [...]}, at most 100 per request and 2 MB; Authorization: Bearer cs_sec_...
 *   POST /api/v1/orders/validate   the same body; Connect stores and forwards nothing (the "Test" button)
 *   POST /api/v1/erase             {emailSha256?, orderExternalIds?} (at most 1000 order ids)
 *
 * Every answer is turned into one of three outcomes, never an exception:
 *   ok     200: per item accepted | duplicate | not_forwarded | refused (with a reason)
 *   retry  network error, timeout, 401/403 (a wrong or rotated key: retried until the key is fixed), 408, 429 (Retry-After), 5xx
 *   fail   400, 413, 415 and other 4xx: sending the same body again cannot help
 *
 * Error texts carry Connect's status and error code only, never a request body (it can hold an e-mail address).
 */
import { loyaltyConnectUrl } from "./config.server.js";

export const MAX_ORDERS_PER_REQUEST = 100;
/** Connect takes 2 MB per request; batches stay under this, measured on the JSON text. */
export const MAX_BATCH_BYTES = 1_500_000;
export const MAX_ERASE_ORDER_IDS = 1000;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "LoyaltyEngageConnector (Loyalty Connect)";

/** Retry-After in ms: seconds or an HTTP date; 60 seconds when absent or unreadable (Connect's advice). */
export function retryAfterMs(header, nowMs = Date.now()) {
  if (header === null || header === undefined || header === "") return 60_000;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.max(1000, secs * 1000);
  const at = Date.parse(String(header));
  return Number.isFinite(at) ? Math.max(1000, at - nowMs) : 60_000;
}

const short = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 300);

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** The outcome of one HTTP exchange with Connect (see the header comment). */
async function exchange(doFetch, url, secretKey, body, nowMs) {
  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { kind: "retry", httpStatus: null, error: timeout ? "timeout" : `network error: ${short(e?.message)}` };
  }
  const status = res.status;
  const data = await readJson(res);
  const code = data && typeof data === "object" ? [data.error, data.detail].filter(Boolean).map(String).join(": ") : "";
  if (status === 200) {
    if (!data || typeof data !== "object") return { kind: "retry", httpStatus: status, error: "unreadable answer from Loyalty Connect" };
    return { kind: "ok", httpStatus: status, data };
  }
  if (status === 401 || status === 403) return { kind: "retry", httpStatus: status, error: "unauthorized: Loyalty Connect did not accept the secret key" };
  if (status === 429) return { kind: "retry", httpStatus: status, retryAfterMs: retryAfterMs(res.headers.get("retry-after"), nowMs), error: "rate limited" };
  if (status === 408 || status >= 500) return { kind: "retry", httpStatus: status, error: short(`HTTP ${status}${code ? ` ${code}` : ""}`) };
  return { kind: "fail", httpStatus: status, error: short(`HTTP ${status}${code ? ` ${code}` : ""}`) };
}

export function createConnectClient({ baseUrl = loyaltyConnectUrl(), fetch: doFetch = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const url = (path) => `${baseUrl.replace(/\/+$/, "")}${path}`;
  return {
    baseUrl,

    /**
     * Orders in one request. ok: `results[i]` belongs to `bodies[i]` ({status, reason?, detail?, forwarded?}), plus Connect's
     * top-level `warning` ("no_active_subscription" when the source has no product connected yet).
     */
    async postOrders(secretKey, bodies) {
      const out = await exchange(doFetch, url("/api/v1/orders"), secretKey, { orders: bodies }, now());
      if (out.kind !== "ok") return out;
      const results = Array.isArray(out.data.results) ? out.data.results : [];
      return { kind: "ok", httpStatus: out.httpStatus, warning: out.data.warning, results: bodies.map((_, i) => results.find((r) => r?.index === i) ?? results[i]) };
    },

    /** One erase. ok: Connect's {erased, bufferedRows, subscriptions, waiting}. */
    async postErase(secretKey, body) {
      const out = await exchange(doFetch, url("/api/v1/erase"), secretKey, body, now());
      return out.kind === "ok" ? { kind: "ok", httpStatus: out.httpStatus, erased: out.data } : out;
    },

    /**
     * The "Test" button: a made-up test order to /api/v1/orders/validate. Connect checks the secret key and the order and stores,
     * counts and forwards nothing. Says whether the source has a product connected (subscribed).
     */
    async validate(secretKey) {
      const at = new Date(now()).toISOString();
      const probe = {
        externalId: "loyalty-connect-test", createdAt: at, updatedAt: at, cancelledAt: null, currency: "EUR", fulfillmentStatus: "unfulfilled", test: true,
        pricing: { subtotal: "0.00", totalDiscounts: "0.00", totalTax: "0.00", totalShipping: "0.00", totalPrice: "0.00", totalReceived: "0.00", netPayment: "0.00" },
        discountCodes: [], lineItems: [{ externalId: "1", title: "Loyalty Connect test", quantity: 1, originalUnitPrice: "0.00" }], refunds: [],
      };
      const out = await exchange(doFetch, url("/api/v1/orders/validate"), secretKey, { orders: [probe] }, now());
      if (out.kind !== "ok") {
        const message = out.httpStatus === 401 || out.httpStatus === 403 ? "The secret key was not accepted by Loyalty Connect." : `Loyalty Connect could not be reached or refused the test: ${out.error}`;
        return { ok: false, httpStatus: out.httpStatus, message };
      }
      const first = Array.isArray(out.data.results) ? out.data.results[0] : undefined;
      if (first?.status === "refused") return { ok: false, httpStatus: 200, message: `The key works, but Loyalty Connect refused the test order: ${short([first.reason, first.detail].filter(Boolean).join(": "))}` };
      const subscribed = out.data.subscribed === true;
      return {
        ok: true, httpStatus: 200, subscribed,
        message: subscribed ? "Connected. The secret key works and a product is connected to this source." : "The secret key works, but no product is connected to this source in Loyalty Connect yet: data would be counted but not passed on.",
      };
    },
  };
}
