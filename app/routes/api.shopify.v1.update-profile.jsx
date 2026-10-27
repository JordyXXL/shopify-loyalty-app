import { json } from "@remix-run/node";
import prisma from "../db.server";

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
