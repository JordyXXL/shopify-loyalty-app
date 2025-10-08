import { json } from "@remix-run/node";
import prisma from "../../db.server";
import { apiVersion } from "../../shopify.server";

// Helper function to authorize requests
async function authorizeRequest(request, shop) {
  const authHeader = request.headers.get("authorization");
  
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return { error: "Missing or invalid authorization header", status: 401 };
  }

  try {
    const credentials = Buffer.from(authHeader.slice(6), "base64").toString();
    const [username, password] = credentials.split(":");

    // Get tenant configuration for this shop
    const tenant = await prisma.tenant.findFirst({
      where: { 
        shopDomain: shop,
        isActive: true,
        basicAuthUser: username,
        basicAuthPass: password,
      },
    });

    if (!tenant) {
      return { error: "Invalid credentials or inactive tenant", status: 401 };
    }

    // Check IP restrictions if configured
    if (tenant.allowedIps) {
      const allowedIps = JSON.parse(tenant.allowedIps);
      const clientIp = request.headers.get("x-forwarded-for") || 
                      request.headers.get("x-real-ip") || 
                      "unknown";
      
      if (!allowedIps.includes(clientIp)) {
        return { error: `Access denied from IP: ${clientIp}`, status: 403 };
      }
    }

    return { tenant, status: 200 };
  } catch (error) {
    return { error: "Authorization failed", status: 401 };
  }
}

// Handle CORS preflight
export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  return json({ ok: true }, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
};

export const action = async ({ request }) => {
  const startTime = Date.now();
  let logData = {
    endpoint: "/api/shopify/v1/update-profile",
    method: request.method,
    requestBody: null,
    response: null,
    statusCode: null,
    duration: null,
    error: null,
  };

  try {
    // Parse request body
    const body = await request.json();
    logData.requestBody = JSON.stringify(body);

    // Extract shop from URL or body
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || body.shop;
    
    if (!shop) {
      const error = "Shop parameter is required";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    logData.shop = shop;

    // Authorize request
    const authResult = await authorizeRequest(request, shop);
    if (authResult.error) {
      logData.error = authResult.error;
      logData.statusCode = authResult.status;
      return json({ error: authResult.error }, { 
        status: authResult.status,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const { tenant } = authResult;

    // Parse profiles data
    let profiles = [];
    
    // Support both formats from WordPress plugin
    if (body.profiles && Array.isArray(body.profiles)) {
      // Format 1: { tenant: "name", profiles: [...] }
      profiles = body.profiles;
    } else if (Array.isArray(body)) {
      // Format 2: Direct array of profiles
      profiles = body;
    } else if (body.email) {
      // Format 3: Single profile object
      profiles = [body];
    }

    if (profiles.length === 0) {
      const error = "No profiles provided";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Queue profiles for processing
    let queuedCount = 0;
    for (const profile of profiles) {
      if (!profile.email) {
        console.warn("Skipping profile without email:", profile);
        continue;
      }

      try {
        await prisma.profileQueue.create({
          data: {
            tenantId: tenant.id,
            profile: JSON.stringify(profile),
            status: "PENDING",
          },
        });
        queuedCount++;
      } catch (error) {
        console.error("Failed to queue profile:", error);
      }
    }

    const response = {
      message: `${queuedCount} profiles queued for Shopify sync.`,
      queued: queuedCount,
      total: profiles.length,
    };

    logData.response = JSON.stringify(response);
    logData.statusCode = 202;
    logData.duration = Date.now() - startTime;

    return json(response, { 
      status: 202,
      headers: { "Access-Control-Allow-Origin": "*" }
    });

  } catch (error) {
    console.error("Profile update error:", error);
    
    logData.error = error.message;
    logData.statusCode = 500;
    logData.duration = Date.now() - startTime;

    return json(
      { error: "Internal server error" },
      { 
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" }
      }
    );
  } finally {
    // Log the API request for debugging
    try {
      await prisma.apiLog.create({
        data: logData,
      });
    } catch (logError) {
      console.error("Failed to log API request:", logError);
    }
  }
};

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
