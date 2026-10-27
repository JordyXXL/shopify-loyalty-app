import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

// Moved unchanged from app/routes/api.shopify.v1.update-profile.jsx: a route module
// may only export loader/action/default for the client build to succeed.

// Background processor function (to be called by cron job)
export async function processProfileQueue() {
  const profiles = await prisma.profileQueue.findMany({
    where: { status: "PENDING" },
    include: { tenant: true },
    orderBy: { createdAt: "asc" },
    take: 100, // Process in batches
  });

  if (profiles.length === 0) {
    return { processed: 0, failed: 0 };
  }

  let processed = 0;
  let failed = 0;

  for (const queueItem of profiles) {
    try {
      // Mark as processing
      await prisma.profileQueue.update({
        where: { id: queueItem.id },
        data: { status: "PROCESSING" },
      });

      const profile = JSON.parse(queueItem.profile);
      const success = await sendProfileToShopify(queueItem.tenant, profile);

      await prisma.profileQueue.update({
        where: { id: queueItem.id },
        data: { 
          status: success ? "DONE" : "FAILED",
          retryCount: { increment: 1 },
          lastError: success ? null : "Shopify sync failed",
        },
      });

      if (success) {
        processed++;
      } else {
        failed++;
      }

    } catch (error) {
      console.error(`Failed to process profile queue item ${queueItem.id}:`, error);
      
      await prisma.profileQueue.update({
        where: { id: queueItem.id },
        data: { 
          status: "FAILED",
          retryCount: { increment: 1 },
          lastError: error.message,
        },
      });
      
      failed++;
    }
  }

  return { processed, failed };
}

// Send profile to Shopify (ported from WordPress plugin)
async function sendProfileToShopify(tenant, profile) {
  try {
    const email = profile.email;
    if (!email) {
      console.error("Profile sync skipped: no email provided");
      return false;
    }

    const shopDomain = tenant.shopDomain;
    const accessToken = tenant.accessToken;

    // 1. Search for existing customer
    const searchQuery = {
      query: `{ customers(query: "email:${email.replace(/"/g, '\\"')}", first: 1) { edges { node { id } } } }`
    };

    const searchResponse = await shopifyGraphQLRequest(shopDomain, accessToken, searchQuery);
    
    if (!searchResponse || !searchResponse.data) {
      console.error("Shopify search failed for", email, searchResponse);
      return false;
    }

    // Check if customer exists
    let customer = null;
    if (searchResponse.data.customers?.edges?.length > 0) {
      customer = searchResponse.data.customers.edges[0].node;
    }

    // 2. Build metafields payload
    const metafieldsArray = [];
    const metafieldsString = [];

    for (const [key, value] of Object.entries(profile)) {
      if (key.startsWith('custom_le_')) {
        if (value === '' || value === null || value === undefined) {
          continue; // Skip empty values
        }

        const shopifyKey = 'le_' + key.substring(10);
        const type = typeof value === 'number' 
          ? (Number.isInteger(value) ? 'number_integer' : 'number_decimal')
          : 'single_line_text_field';
        
        const stringValue = String(value);

        metafieldsArray.push({
          namespace: 'loyalty',
          key: shopifyKey,
          value: stringValue,
          type: type,
        });

        metafieldsString.push(`{ namespace: "loyalty", key: "${shopifyKey}", value: "${stringValue.replace(/"/g, '\\"')}", type: "${type}" }`);
      }
    }

    if (metafieldsArray.length === 0) {
      console.log("No loyalty metafields to sync for", email);
      return true; // Not an error, just nothing to sync
    }

    // 3. Create or update customer with metafields
    let mutation;
    
    if (customer) {
      // Update existing customer metafields
      const ownerMetafields = metafieldsArray.map(mf => 
        `{ ownerId: "${customer.id}", namespace: "${mf.namespace}", key: "${mf.key}", value: "${mf.value.replace(/"/g, '\\"')}", type: "${mf.type}" }`
      ).join(', ');

      mutation = {
        query: `mutation { metafieldsSet(metafields: [${ownerMetafields}]) { metafields { id key namespace value type } userErrors { field message } } }`
      };
    } else {
      // Create new customer with metafields
      const metafieldsStr = metafieldsString.join(', ');
      mutation = {
        query: `mutation { customerCreate(input: { email: "${email.replace(/"/g, '\\"')}", metafields: [${metafieldsStr}] }) { customer { id email } userErrors { field message } } }`
      };
    }

    // 4. Execute mutation
    const mutationResponse = await shopifyGraphQLRequest(shopDomain, accessToken, mutation);

    if (!mutationResponse?.data) {
      console.error("Shopify mutation response invalid for", email, mutationResponse);
      return false;
    }

    // Check for errors
    const errors = mutationResponse.data.metafieldsSet?.userErrors || 
                  mutationResponse.data.customerCreate?.userErrors || 
                  [];

    if (errors.length > 0) {
      console.error("Shopify userErrors for", email, errors);
      return false;
    }

    console.log("Successfully synced profile for", email);
    return true;

  } catch (error) {
    console.error('Shopify sync error for', profile.email, error);
    return false;
  }
}

// Shopify GraphQL request helper
async function shopifyGraphQLRequest(shopDomain, accessToken, payload) {
  try {
    const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("Shopify GraphQL request failed:", response.status, response.statusText);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Shopify GraphQL request error:", error);
    return null;
  }
}
