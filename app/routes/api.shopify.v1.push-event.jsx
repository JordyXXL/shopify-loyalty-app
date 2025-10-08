import { json } from "@remix-run/node";
import prisma from "../../db.server";

// Helper function to get tenant configuration
async function getTenantConfig(tenantName) {
  const tenant = await prisma.tenant.findFirst({
    where: { 
      name: tenantName,
      isActive: true,
    },
  });
  return tenant;
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
    endpoint: "/api/shopify/v1/push-event",
    method: request.method,
    requestBody: null,
    response: null,
    statusCode: null,
    duration: null,
    error: null,
  };

  try {
    const body = await request.json();
    logData.requestBody = JSON.stringify(body);

    const { tenant: tenantName } = body;

    if (!tenantName) {
      const error = "tenant is required";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Get tenant configuration
    const tenant = await getTenantConfig(tenantName);
    if (!tenant) {
      const error = "Unknown tenant";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    if (!tenant.loyaltyLogin || !tenant.loyaltyToken) {
      const error = "LoyaltyEngage credentials missing for this tenant";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    logData.shop = tenant.shopDomain;

    // Normalize input to array of {event, identifier}
    let payload = [];

    if (body.events && Array.isArray(body.events)) {
      // Format: { tenant: "name", events: [{event: "...", identifier: "..."}, ...] }
      for (const row of body.events) {
        const event = String(row.event || '').trim();
        const identifier = String(row.identifier || '').trim();
        
        if (event && identifier) {
          payload.push({ event, identifier });
        }
      }
    } else if (body.email && body.event) {
      // Format: { tenant: "name", email: "...", event: "..." }
      const event = String(body.event).trim();
      const identifier = String(body.email).trim();
      
      if (event && identifier) {
        payload.push({ event, identifier });
      }
    }

    if (payload.length === 0) {
      const error = "email and event are required (or use events[])";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    if (payload.length > 100) {
      const error = "Too many events in one request (max 100)";
      logData.error = error;
      logData.statusCode = 413;
      return json({ error }, { 
        status: 413,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Send events to LoyaltyEngage
    const loyaltyUrl = 'https://app.loyaltyengage.tech/api/v1/events';
    const authHeader = 'Basic ' + Buffer.from(`${tenant.loyaltyLogin}:${tenant.loyaltyToken}`).toString('base64');

    const loyaltyResponse = await fetch(loyaltyUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const loyaltyData = await loyaltyResponse.json();
    
    console.log(`[LoyaltyEngage] Push event batch size=${payload.length} tenant=${tenantName} → HTTP ${loyaltyResponse.status}`);
    console.log('[LoyaltyEngage] Response:', loyaltyData);

    if (!loyaltyResponse.ok) {
      const error = loyaltyData.error || 'LoyaltyEngage push failed';
      logData.error = error;
      logData.statusCode = 400;
      return json({ 
        error,
        details: loyaltyData 
      }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Check for LoyaltyEngage errors
    if (loyaltyData.error && loyaltyData.error !== false) {
      const error = loyaltyData.error;
      logData.error = error;
      logData.statusCode = 400;
      return json({ 
        error,
        details: loyaltyData 
      }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const response = {
      success: true,
      events_sent: payload.length,
      le_response: loyaltyData,
    };

    logData.response = JSON.stringify(response);
    logData.statusCode = 200;
    logData.duration = Date.now() - startTime;

    return json(response, { 
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" }
    });

  } catch (error) {
    console.error("Event push error:", error);
    
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
    // Log the API request
    try {
      await prisma.apiLog.create({
        data: logData,
      });
    } catch (logError) {
      console.error("Failed to log API request:", logError);
    }
  }
};
