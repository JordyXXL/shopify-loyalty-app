/**
 * Loyalty Connect, wired to this app's database: the instances the routes use. Everything below is built from factories that the
 * tests build with fakes instead (test/loyalty-connect.*.test.js).
 */
import prisma from "../db.server.js";
import { createConnectClient } from "./client.server.js";
import { createQueue } from "./queue.server.js";
import { createWebhookHandler } from "./webhooks.server.js";

/** The shop's offline Admin API token: the app's offline session, else the tenant's stored token. */
async function offlineAccessToken(shop) {
  const session = (await prisma.session.findUnique({ where: { id: `offline_${shop}` } })) ?? (await prisma.session.findFirst({ where: { shop, isOnline: false } }));
  if (session?.accessToken) return session.accessToken;
  const tenant = await prisma.tenant.findFirst({ where: { shopDomain: shop, isActive: true } });
  return tenant?.accessToken || undefined;
}

export const loyaltyConnectQueue = createQueue({ db: prisma, client: createConnectClient(), getAccessToken: offlineAccessToken });

// a webhook's items go out about a second later, together with whatever else arrived for the tenant meanwhile
const scheduled = new Set();
function kick(tenantId) {
  if (scheduled.has(tenantId)) return;
  scheduled.add(tenantId);
  setTimeout(() => {
    scheduled.delete(tenantId);
    loyaltyConnectQueue.process({ tenantId }).catch((e) => console.error(`[LoyaltyConnect] delivery for tenant ${tenantId} failed: ${e.message}`));
  }, 1000);
}

export const handleLoyaltyConnectWebhook = createWebhookHandler({ db: prisma, queue: loyaltyConnectQueue, kick });

let running = false;
/** The cron's part: runs in the background after the Loyalty Engage queues, one run at a time per process. */
export function runLoyaltyConnectQueueInBackground() {
  if (running) return;
  running = true;
  loyaltyConnectQueue
    .process()
    .then((r) => {
      if (r.delivered || r.retrying || r.failed || r.skipped || r.cleaned) {
        console.log(`[CRON] Loyalty Connect queue: ${r.delivered} delivered, ${r.retrying} to retry, ${r.failed} failed, ${r.skipped} skipped, ${r.cleaned} cleaned up`);
      }
    })
    .catch((e) => console.error(`[CRON] Loyalty Connect queue failed: ${e.message}`))
    .finally(() => {
      running = false;
    });
}
