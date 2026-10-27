/**
 * The Loyalty Connect queue (table LoyaltyConnectQueue): what the webhooks hand over is stored first and delivered afterwards, so a
 * webhook never waits for Loyalty Connect and a failed delivery is tried again. It runs next to the Loyalty Engage queues: shortly
 * after a webhook (a "kick") and on every run of /api/cron/process-queues, after the Loyalty Engage work.
 *
 *   ORDER    an order version mapped from orders/create|updated|cancelled; delivered in batches (<= 100 orders, < 1.5 MB)
 *   REFUND   refunds/create names only the order: the order is read again through the Admin API (as Connect's own app does) and
 *            delivered as a new version
 *   ERASE    customers/redact: {emailSha256?, orderExternalIds?} to /api/v1/erase
 *
 * Per item Connect answers accepted | duplicate | not_forwarded (done: Connect counted it; nothing to resend) or refused (failed: the
 * same message would be refused again). Network errors, 401/403, 408, 429 and 5xx are retried with backoff: 1, 2, 4 ... minutes, at
 * most 6 hours apart (429: at least Retry-After), at most MAX_ATTEMPTS times (about two days), then failed.
 *
 * Payloads are encrypted (an order message holds the customer's e-mail address) and emptied as soon as the item is done, failed or
 * skipped. Items are claimed with a token, so two processes (PM2 cluster, a kick and the cron) never send the same item twice.
 * Nothing here logs a payload.
 */
import { randomUUID } from "node:crypto";
import { createConnectClient, MAX_BATCH_BYTES, MAX_ORDERS_PER_REQUEST } from "./client.server.js";
import { decrypt, encrypt, tryDecrypt } from "./crypto.server.js";
import { orderFromGraphql } from "./orders.js";
import { queueLabel, secretKeyLabel } from "./settings.server.js";
import { orderByIdTolerant } from "./shopify-admin.server.js";

export const MAX_ATTEMPTS = 15;
export const STALE_LOCK_MS = 10 * 60_000;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 6 * 3600_000;
const KEEP_DONE_MS = 7 * 86_400_000;
const KEEP_FAILED_MS = 30 * 86_400_000;

export const backoffMs = (attempts) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));

const short = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 500);

/**
 * deps: db (Prisma client), client (createConnectClient), now (() => Date), getAccessToken (shop => offline token), shopifyFetch and
 * wait (for the Admin API; tests pass fakes).
 */
export function createQueue(deps) {
  const db = deps.db;
  const client = deps.client ?? createConnectClient();
  const now = deps.now ?? (() => new Date());
  const q = () => db.loyaltyConnectQueue;

  /** Stores items for a tenant: [{kind, dedupeKey, payload}]. An item with a dedupeKey the tenant has already is ignored. */
  async function enqueue(tenantId, items) {
    if (!items.length) return 0;
    const at = now();
    const r = await q().createMany({
      data: items.map((it) => ({
        tenantId, kind: it.kind, dedupeKey: String(it.dedupeKey).slice(0, 191), payload: encrypt(JSON.stringify(it.payload), queueLabel(tenantId)),
        status: "PENDING", attempts: 0, nextAttemptAt: at,
      })),
      skipDuplicates: true,
    });
    return r?.count ?? 0;
  }

  const finish = (item, data) => q().update({ where: { id: item.id }, data: { claimToken: null, lockedAt: null, ...data } });
  const done = (item, result, httpStatus) => finish(item, { status: "DONE", payload: "", result, attempts: item.attempts + 1, lastHttpStatus: httpStatus ?? null, lastError: null });
  const failed = (item, error, httpStatus, result) => finish(item, { status: "FAILED", payload: "", result: result ?? "failed", attempts: item.attempts + 1, lastHttpStatus: httpStatus ?? null, lastError: short(error) });
  const skipped = (item, reason) => finish(item, { status: "SKIPPED", payload: "", result: "skipped", lastError: short(reason) });
  async function retry(item, error, httpStatus, retryAfter) {
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) return failed(item, `gave up after ${attempts} attempts: ${error}`, httpStatus);
    const delay = Math.max(backoffMs(attempts), retryAfter ?? 0);
    return finish(item, { status: "PENDING", attempts, nextAttemptAt: new Date(now().getTime() + delay), lastHttpStatus: httpStatus ?? null, lastError: short(error) });
  }

  /** The tenant's "last delivery" in the admin screen. ok: Connect answered 200. */
  async function note(settingsId, ok, status, error) {
    if (!settingsId) return;
    const at = now();
    await db.loyaltyConnectSettings.update({
      where: { id: settingsId },
      data: ok ? { lastDeliveryAt: at, lastDeliveryStatus: short(status) } : { lastDeliveryStatus: short(status), lastErrorAt: at, lastError: short(error) },
    }).catch((e) => console.error(`[LoyaltyConnect] could not record delivery status: ${e.message}`));
  }

  function batches(ready) {
    const out = [];
    let cur = [];
    let bytes = 0;
    for (const r of ready) {
      const size = Buffer.byteLength(JSON.stringify(r.body));
      if (cur.length && (cur.length >= MAX_ORDERS_PER_REQUEST || bytes + size > MAX_BATCH_BYTES)) {
        out.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(r);
      bytes += size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function processTenant(tenantId, items, sum) {
    const row = await db.loyaltyConnectSettings.findFirst({ where: { tenantId }, include: { tenant: true } });
    const live = Boolean(row?.enabled && row?.tenant?.isActive);
    const secretKey = row ? tryDecrypt(row.secretKeyEnc, secretKeyLabel(tenantId)) : undefined;
    const shop = row?.tenant?.shopDomain ?? row?.shopDomain;
    const domain = row?.storefrontDomain || shop;
    const orderLike = items.filter((i) => i.kind === "ORDER" || i.kind === "REFUND");
    const erases = items.filter((i) => i.kind === "ERASE");

    // ---------------------------------------------------------------- orders: only while Loyalty Connect is on
    const ready = [];
    for (const item of orderLike) {
      if (!live || !secretKey) {
        await skipped(item, !live ? "Loyalty Connect is off for this tenant" : "no readable secret key");
        sum.skipped++;
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(decrypt(item.payload, queueLabel(tenantId)));
      } catch {
        await failed(item, "the queued message cannot be read (encryption key changed?)");
        sum.failed++;
        continue;
      }
      if (item.kind === "ORDER") {
        ready.push({ item, body: payload.order });
        continue;
      }
      // REFUND: the order again, with its refunds, as Connect's own app does on refunds/create
      try {
        const token = shop ? await deps.getAccessToken?.(shop) : undefined;
        if (!token) {
          await skipped(item, "no Shopify access token for the shop (app uninstalled?)");
          sum.skipped++;
          continue;
        }
        const node = await orderByIdTolerant({ shop, token, fetch: deps.shopifyFetch, wait: deps.wait }, payload.orderId);
        if (!node) {
          await done(item, "ignored: order not found");
          sum.delivered++;
          continue;
        }
        ready.push({ item, body: orderFromGraphql(node, { domain }) });
      } catch (e) {
        await retry(item, `Shopify: ${e.message}`);
        sum.retrying++;
      }
    }

    for (const batch of batches(ready)) {
      const out = await client.postOrders(secretKey, batch.map((r) => r.body));
      if (out.kind === "ok") {
        const tally = {};
        for (let i = 0; i < batch.length; i++) {
          const { item } = batch[i];
          const r = out.results[i];
          const status = r?.status;
          tally[status ?? "missing"] = (tally[status ?? "missing"] ?? 0) + 1;
          if (status === "accepted" || status === "duplicate") {
            await done(item, status, out.httpStatus);
            sum.delivered++;
          } else if (status === "not_forwarded") {
            await done(item, `not_forwarded${r.reason ? `: ${r.reason}` : ""}`, out.httpStatus);
            sum.delivered++;
          } else if (status === "refused") {
            await failed(item, `refused by Loyalty Connect: ${[r.reason, r.detail].filter(Boolean).join(": ")}`, out.httpStatus, `refused${r.reason ? `: ${r.reason}` : ""}`);
            sum.failed++;
          } else {
            await retry(item, "no answer for this order in Loyalty Connect's reply", out.httpStatus);
            sum.retrying++;
          }
        }
        const text = Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ");
        await note(row?.id, true, `200 orders: ${text}${out.warning ? ` (${out.warning})` : ""}`);
      } else {
        for (const { item } of batch) {
          if (out.kind === "retry") {
            await retry(item, out.error, out.httpStatus, out.retryAfterMs);
            sum.retrying++;
          } else {
            await failed(item, out.error, out.httpStatus);
            sum.failed++;
          }
        }
        await note(row?.id, false, `${out.httpStatus ?? "no answer"} orders: ${out.kind === "retry" ? "will retry" : "failed"}`, out.error);
      }
    }

    // ---------------------------------------------------------------- erasures: whenever a secret key is there (webhooks.server.js decides)
    for (const item of erases) {
      if (!secretKey) {
        await skipped(item, "no readable secret key");
        sum.skipped++;
        continue;
      }
      let body;
      try {
        body = JSON.parse(decrypt(item.payload, queueLabel(tenantId)));
      } catch {
        await failed(item, "the queued message cannot be read (encryption key changed?)");
        sum.failed++;
        continue;
      }
      const out = await client.postErase(secretKey, body);
      if (out.kind === "ok") {
        await done(item, "erased", out.httpStatus);
        sum.delivered++;
        await note(row?.id, true, "200 erase");
      } else if (out.kind === "retry") {
        await retry(item, out.error, out.httpStatus, out.retryAfterMs);
        sum.retrying++;
        await note(row?.id, false, `${out.httpStatus ?? "no answer"} erase: will retry`, out.error);
      } else {
        await failed(item, out.error, out.httpStatus);
        sum.failed++;
        await note(row?.id, false, `${out.httpStatus} erase: failed`, out.error);
      }
    }
  }

  /** Delivers what is due. tenantId: only that tenant's items (the kick after a webhook). */
  async function process({ tenantId, limit = 300 } = {}) {
    const at = now();
    const sum = { delivered: 0, retrying: 0, failed: 0, skipped: 0, cleaned: 0 };
    // claims of a process that died are released
    await q().updateMany({ where: { status: "PROCESSING", lockedAt: { lt: new Date(at.getTime() - STALE_LOCK_MS) } }, data: { status: "PENDING", claimToken: null, lockedAt: null } });
    const due = await q().findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: at }, ...(tenantId ? { tenantId } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit, select: { id: true, tenantId: true },
    });
    const byTenant = new Map();
    for (const d of due) byTenant.set(d.tenantId, [...(byTenant.get(d.tenantId) ?? []), d.id]);
    for (const [tid, ids] of byTenant) {
      const token = randomUUID();
      await q().updateMany({ where: { id: { in: ids }, status: "PENDING" }, data: { status: "PROCESSING", claimToken: token, lockedAt: at } });
      const items = await q().findMany({ where: { claimToken: token, status: "PROCESSING" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (!items.length) continue;
      try {
        await processTenant(tid, items, sum);
      } catch (e) {
        console.error(`[LoyaltyConnect] delivering for tenant ${tid} failed: ${e.message}`);
        const left = await q().findMany({ where: { claimToken: token, status: "PROCESSING" } });
        for (const item of left) {
          await retry(item, `internal error: ${e.message}`).catch(() => undefined);
          sum.retrying++;
        }
      }
    }
    if (!tenantId) sum.cleaned = await cleanup(at);
    return sum;
  }

  async function cleanup(at) {
    const a = await q().deleteMany({ where: { status: { in: ["DONE", "SKIPPED"] }, updatedAt: { lt: new Date(at.getTime() - KEEP_DONE_MS) } } });
    const b = await q().deleteMany({ where: { status: "FAILED", updatedAt: { lt: new Date(at.getTime() - KEEP_FAILED_MS) } } });
    return (a?.count ?? 0) + (b?.count ?? 0);
  }

  /** Switched off: what waits is not sent (erasures excepted). */
  async function skipPending(tenantId, reason = "Loyalty Connect switched off") {
    const r = await q().updateMany({ where: { tenantId, status: "PENDING", kind: { in: ["ORDER", "REFUND"] } }, data: { status: "SKIPPED", payload: "", result: "skipped", lastError: reason } });
    return r?.count ?? 0;
  }

  return { enqueue, process, skipPending };
}
