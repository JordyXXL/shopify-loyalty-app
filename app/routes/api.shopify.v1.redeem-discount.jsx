import { json } from "@remix-run/node";
import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

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
    endpoint: "/api/shopify/v1/redeem-discount",
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

    const { tenant: tenantName, email, sku } = body;

    if (!tenantName || !email || !sku) {
      const error = "tenant, email and sku are required";
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

    logData.shop = tenant.shopDomain;

    // Call LoyaltyEngage API to buy discount code
    const loyaltyUrl = `https://app.loyaltyengage.tech/api/v1/loyalty/shop/${encodeURIComponent(email)}/cart/buy_discount_code`;
    const authHeader = 'Basic ' + Buffer.from(`${tenant.loyaltyLogin}:${tenant.loyaltyToken}`).toString('base64');

    const loyaltyResponse = await fetch(loyaltyUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sku }),
    });

    const loyaltyData = await loyaltyResponse.json();
    console.log('[LoyaltyEngage] Buy discount response:', loyaltyData);

    if (!loyaltyResponse.ok) {
      let errorMessage = "Failed to purchase discount from LoyaltyEngage";
      
      if (loyaltyData.message === "AVAILABLE_COINS_INSUFFICIENT") {
        errorMessage = "Not enough coins available";
      } else if (loyaltyData.message === "CONTACT_NOT_FOUND") {
        errorMessage = "Please subscribe to loyalty program first";
      }

      logData.error = errorMessage;
      logData.statusCode = 400;
      return json({ error: errorMessage }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    if (!loyaltyData.discountCode) {
      const error = "No discount code received from LoyaltyEngage";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const { discountCode, discountAmount, discountPercentage } = loyaltyData;

    // Determine discount type and value
    let discountType = 'AMOUNT';
    let discountValue = discountAmount;

    if (discountPercentage && !discountAmount) {
      discountType = 'PERCENTAGE';
      discountValue = discountPercentage;
    }

    // Create discount code in Shopify
    const success = await createShopifyDiscountCode(
      tenant,
      discountCode,
      discountValue,
      discountType
    );

    if (!success) {
      const error = "Failed to create discount code in Shopify";
      logData.error = error;
      logData.statusCode = 500;
      return json({ error }, { 
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const response = {
      success: true,
      discount_code: discountCode,
      discount_type: discountType.toLowerCase(),
      discount_value: discountValue,
    };

    logData.response = JSON.stringify(response);
    logData.statusCode = 200;
    logData.duration = Date.now() - startTime;

    return json(response, { 
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" }
    });

  } catch (error) {
    console.error("Discount redemption error:", error);
    
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

// Create discount code in Shopify
async function createShopifyDiscountCode(tenant, code, amount, type = 'AMOUNT') {
  try {
    console.log(`[Shopify] Creating discount code ${code} - ${amount} ${type}`);

    let customerGetsValue;
    
    if (type === 'PERCENTAGE') {
      customerGetsValue = {
        percentage: parseFloat(amount) / 100 // Convert to decimal
      };
    } else {
      customerGetsValue = {
        discountAmount: {
          amount: String(amount)
        }
      };
    }

    const mutation = {
      query: `
        mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        basicCodeDiscount: {
          title: 'Loyalty Discount',
          code: code,
          customerGets: {
            value: customerGetsValue,
            items: { all: true }
          },
          customerSelection: { all: true },
          startsAt: new Date().toISOString(),
          usageLimit: 1,
          appliesOncePerCustomer: true,
        }
      }
    };

    const response = await shopifyGraphQLRequest(
      tenant.shopDomain,
      tenant.accessToken,
      mutation
    );

    console.log('[Shopify] Discount creation response:', JSON.stringify(response, null, 2));

    if (!response?.data?.discountCodeBasicCreate) {
      console.error('[Shopify] Invalid discount creation response');
      return false;
    }

    const userErrors = response.data.discountCodeBasicCreate.userErrors || [];
    if (userErrors.length > 0) {
      console.error('[Shopify] Discount creation errors:', userErrors);
      return false;
    }

    console.log(`[Shopify] Successfully created discount code: ${code}`);
    return true;

  } catch (error) {
    console.error('[Shopify] Discount creation error:', error);
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
