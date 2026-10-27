import { json } from "@remix-run/node";
import prisma from "../db.server";
import { processProfileQueue } from "../queues/profile-queue.server";
import { runLoyaltyConnectQueueInBackground } from "../loyalty-connect/index.server";

// This endpoint will be called by a cron service to process queues
async function processLoyaltyEngageQueues({ request }) {
  const startTime = Date.now();
  
  // Verify this is a legitimate cron request (you can add authentication here)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || "your-secret-key";
  
  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("[CRON] Starting queue processing...");

    // Process profile queue
    const profileResults = await processProfileQueue();
    console.log(`[CRON] Profile queue: ${profileResults.processed} processed, ${profileResults.failed} failed`);

    // Process purchase queue
    const purchaseResults = await processPurchaseQueue();
    console.log(`[CRON] Purchase queue: ${purchaseResults.processed} processed, ${purchaseResults.failed} failed`);

    // Clean up old completed queue items (older than 7 days)
    const cleanupResults = await cleanupOldQueueItems();
    console.log(`[CRON] Cleanup: ${cleanupResults.profilesDeleted} profiles, ${cleanupResults.purchasesDeleted} purchases deleted`);

    const duration = Date.now() - startTime;
    console.log(`[CRON] Queue processing completed in ${duration}ms`);

    return json({
      success: true,
      duration,
      results: {
        profiles: profileResults,
        purchases: purchaseResults,
        cleanup: cleanupResults,
      },
    });

  } catch (error) {
    console.error("[CRON] Queue processing error:", error);
    return json(
      { error: "Queue processing failed", message: error.message },
      { status: 500 }
    );
  }
}

export const action = async (args) => {
  const response = await processLoyaltyEngageQueues(args);
  // Loyalty Connect's queue runs after the Loyalty Engage queues, in the background: it never delays or changes their result.
  // Not for a request the Loyalty Engage part refused as unauthorized (its only 401).
  if (response.status !== 401) runLoyaltyConnectQueueInBackground();
  return response;
};

// Process purchase queue (similar to WordPress plugin)
async function processPurchaseQueue() {
  const purchases = await prisma.purchaseQueue.findMany({
    where: { status: "PENDING" },
    include: { tenant: true },
    orderBy: { createdAt: "asc" },
    take: 50, // Process in batches
  });

  if (purchases.length === 0) {
    return { processed: 0, failed: 0 };
  }

  let processed = 0;
  let failed = 0;

  // Group by tenant for batch processing
  const batches = {};
  for (const purchase of purchases) {
    if (!batches[purchase.tenantId]) {
      batches[purchase.tenantId] = [];
    }
    batches[purchase.tenantId].push(purchase);
  }

  for (const [tenantId, tenantPurchases] of Object.entries(batches)) {
    const tenant = tenantPurchases[0].tenant;
    
    // Mark all as processing
    const ids = tenantPurchases.map(p => p.id);
    await prisma.purchaseQueue.updateMany({
      where: { id: { in: ids } },
      data: { status: "PROCESSING" },
    });

    // Prepare batch payload for LoyaltyEngage
    const payloads = tenantPurchases.map(purchase => {
      const payload = JSON.parse(purchase.payload);
      return {
        event: payload.event || "Purchase",
        identifier: payload.identifier || payload.email,
        orderId: payload.orderId,
        orderDate: payload.orderDate,
        products: payload.products || [],
      };
    });

    // Send batch to LoyaltyEngage
    const success = await sendPurchaseBatchToLoyaltyEngage(tenant, payloads);

    // Update status based on result
    for (const purchase of tenantPurchases) {
      try {
        await prisma.purchaseQueue.update({
          where: { id: purchase.id },
          data: { 
            status: success ? "DONE" : "FAILED",
            retryCount: { increment: 1 },
            lastError: success ? null : "LoyaltyEngage batch processing failed",
          },
        });

        if (success) {
          processed++;
        } else {
          failed++;
        }
      } catch (error) {
        console.error(`Failed to update purchase queue item ${purchase.id}:`, error);
        failed++;
      }
    }
  }

  return { processed, failed };
}

// Send purchase batch to LoyaltyEngage
async function sendPurchaseBatchToLoyaltyEngage(tenant, payloads) {
  try {
    const url = 'https://app.loyaltyengage.tech/api/v1/events';
    const authHeader = 'Basic ' + Buffer.from(`${tenant.loyaltyLogin}:${tenant.loyaltyToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payloads),
    });

    const data = await response.json();
    
    console.log(`[LoyaltyEngage] Purchase batch status: ${response.status}`);
    console.log(`[LoyaltyEngage] Response:`, data);

    if (!response.ok) {
      console.error("[LoyaltyEngage] Purchase batch failed:", data);
      return false;
    }

    // Check for successful processing
    return response.status === 200 &&
           data.acceptedEventCount > 0 &&
           (!data.invalidEvents || data.invalidEvents.length === 0);

  } catch (error) {
    console.error("[LoyaltyEngage] Purchase batch error:", error);
    return false;
  }
}

// Clean up old queue items
async function cleanupOldQueueItems() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Delete old completed profile queue items
  const profilesDeleted = await prisma.profileQueue.deleteMany({
    where: {
      status: "DONE",
      updatedAt: { lt: sevenDaysAgo },
    },
  });

  // Delete old completed purchase queue items
  const purchasesDeleted = await prisma.purchaseQueue.deleteMany({
    where: {
      status: "DONE",
      updatedAt: { lt: sevenDaysAgo },
    },
  });

  // Also clean up old API logs (keep only last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const logsDeleted = await prisma.apiLog.deleteMany({
    where: {
      createdAt: { lt: thirtyDaysAgo },
    },
  });

  return {
    profilesDeleted: profilesDeleted.count,
    purchasesDeleted: purchasesDeleted.count,
    logsDeleted: logsDeleted.count,
  };
}

// Handle GET requests for health check
export const loader = async ({ request }) => {
  return json({
    status: "ok",
    message: "Queue processing endpoint is ready",
    timestamp: new Date().toISOString(),
  });
};
