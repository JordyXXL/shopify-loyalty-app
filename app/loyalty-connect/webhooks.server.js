/**
 * Loyalty Connect's part of the Shopify webhooks (app/routes/webhooks.jsx). It only stores work in the queue (queue.server.js) and
 * returns: it never calls Loyalty Connect itself, never throws, and never changes what the Loyalty Engage code does with the same
 * webhook. For a shop without Loyalty Connect switched on it does one database read and nothing else.
 *
 *   orders/create, orders/updated, orders/cancelled   the order, mapped as Connect's own app maps it (orders.js), one message per
 *                                                     order version (id + updated_at; a redelivered webhook is the same version)
 *   refunds/create                                    the order is read again and sent as a new version (queue.server.js)
 *   customers/redact                                  an erase: the e-mail address as SHA-256 (what Connect's erase API takes; the
 *                                                     address itself is not stored) and the order ids Shopify names. Also for a
 *                                                     tenant that is switched off but sent data before: the erase must reach it.
 *   customers/data_request                            nothing to send: what Loyalty Connect holds is retrieved through Loyalty
 *                                                     Connect's own privacy request flow (README "Loyalty Connect")
 *   shop/redact                                       the shop's Loyalty Connect settings and queued messages are deleted
 *   app/uninstalled                                   Shopify removes the web pixel itself; the status says so
 */
import { createHash, randomUUID } from "node:crypto";
import { MAX_ERASE_ORDER_IDS } from "./client.server.js";
import { numericId, orderFromWebhook } from "./orders.js";
import { settingsForShop } from "./settings.server.js";

/** Topics only Loyalty Connect uses: the Loyalty Engage code never sees them (webhooks.jsx answers them with 200). */
export const LOYALTY_CONNECT_ONLY_TOPICS = new Set(["ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE"]);
const ORDER_TOPICS = new Set(["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED"]);

const EMAIL_ONLY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A trimmed value that looks like one e-mail address, or undefined (Connect's asEmail). */
const asEmail = (v) => {
  const s = (typeof v === "string" ? v : "").trim();
  return s && s.length <= 254 && EMAIL_ONLY.test(s) ? s : undefined;
};
/** sha256hex(lowercase(trim(email))): Connect's emailSha256. */
export const emailSha256 = (email) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** deps: db, queue (createQueue), now, kick (tenantId => void: deliver soon). */
export function createWebhookHandler(deps) {
  const { db, queue } = deps;
  const now = deps.now ?? (() => new Date());
  const kick = deps.kick ?? (() => undefined);

  async function handle({ topic, shop, webhookId, payload }) {
    if (ORDER_TOPICS.has(topic)) {
      const s = await settingsForShop(db, shop);
      if (!s) return { action: "off" };
      const order = orderFromWebhook(payload ?? {}, { domain: s.domain });
      const queued = await queue.enqueue(s.tenant.id, [{ kind: "ORDER", dedupeKey: `order:${order.externalId}:${order.updatedAt ?? order.createdAt}`, payload: { order } }]);
      kick(s.tenant.id);
      return { action: "queued", queued };
    }

    if (topic === "REFUNDS_CREATE") {
      const s = await settingsForShop(db, shop);
      if (!s) return { action: "off" };
      const orderId = numericId(payload?.order_id);
      if (!/^\d+$/.test(orderId)) return { action: "ignored: no order id" };
      const refundId = numericId(payload?.id) || webhookId || randomUUID();
      const queued = await queue.enqueue(s.tenant.id, [{ kind: "REFUND", dedupeKey: `refund:${orderId}:${refundId}`, payload: { orderId } }]);
      kick(s.tenant.id);
      return { action: "queued", queued };
    }

    if (topic === "CUSTOMERS_REDACT") {
      const s = await settingsForShop(db, shop, { forErase: true });
      if (!s) return { action: "off" };
      const email = asEmail(payload?.customer?.email);
      const orders = [...new Set((Array.isArray(payload?.orders_to_redact) ? payload.orders_to_redact : []).map((x) => numericId(x)).filter((x) => /^\d{1,30}$/.test(x)))];
      if (!email && !orders.length) {
        console.info(`[LoyaltyConnect] customers/redact for ${shop}: no e-mail address and no orders, nothing Loyalty Connect can match`);
        return { action: "nothing to erase" };
      }
      const hash = email ? emailSha256(email) : undefined;
      const parts = [];
      if (!orders.length) parts.push({ emailSha256: hash });
      for (let i = 0; i < orders.length; i += MAX_ERASE_ORDER_IDS) {
        parts.push({ ...(i === 0 && hash ? { emailSha256: hash } : {}), orderExternalIds: orders.slice(i, i + MAX_ERASE_ORDER_IDS) });
      }
      const id = webhookId || randomUUID();
      const queued = await queue.enqueue(s.tenant.id, parts.map((body, i) => ({ kind: "ERASE", dedupeKey: `erase:${id}:${i}`, payload: body })));
      kick(s.tenant.id);
      return { action: "queued", queued };
    }

    if (topic === "CUSTOMERS_DATA_REQUEST") {
      const rows = await db.loyaltyConnectSettings.findMany({ where: { shopDomain: shop }, select: { id: true } });
      if (rows.length) {
        console.info(`[LoyaltyConnect] customers/data_request for ${shop}: this app keeps no customer data for Loyalty Connect; what Loyalty Connect holds is retrieved with an access request on Loyalty Connect's privacy page`);
      }
      return { action: rows.length ? "documented" : "off" };
    }

    if (topic === "SHOP_REDACT") {
      const tenants = await db.tenant.findMany({ where: { shopDomain: shop }, select: { id: true } });
      const ids = tenants.map((t) => t.id);
      const droppedQueue = ids.length ? await db.loyaltyConnectQueue.deleteMany({ where: { tenantId: { in: ids } } }) : { count: 0 };
      const settings = await db.loyaltyConnectSettings.deleteMany({ where: { shopDomain: shop } });
      if (settings.count || droppedQueue.count) console.info(`[LoyaltyConnect] shop/redact for ${shop}: settings and queued messages deleted`);
      return { action: "dropped", settings: settings.count, queued: droppedQueue.count };
    }

    if (topic === "APP_UNINSTALLED") {
      await db.loyaltyConnectSettings.updateMany({ where: { shopDomain: shop }, data: { pixelStatus: "uninstalled", pixelError: null, pixelUpdatedAt: now() } });
      return { action: "noted" };
    }

    return { action: "ignored" };
  }

  /** Never throws: an error is logged (topic and shop only, never the payload) and the webhook goes on. */
  return async function handleLoyaltyConnectWebhook(webhook) {
    try {
      return await handle(webhook);
    } catch (e) {
      console.error(`[LoyaltyConnect] ${webhook?.topic} for ${webhook?.shop} failed: ${e?.message}`);
      return { action: "error" };
    }
  };
}
