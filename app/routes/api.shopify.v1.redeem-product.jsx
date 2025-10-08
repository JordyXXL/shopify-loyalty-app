import { json } from "@remix-run/node";
import prisma from "../../db.server";
import { apiVersion } from "../../shopify.server";

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
    endpoint: "/api/shopify/v1/redeem-product",
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

    const { tenant: tenantName, email, sku, variantId, price } = body;

    if (!tenantName || !email || !sku || !variantId || !price) {
      const error = "tenant, email, sku, variantId and price are required";
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

    // Normalize price to string with dot as decimal separator
    const normalizedPrice = String(price).replace(',', '.');

    if (normalizedPrice === '0' || normalizedPrice === '0.0') {
      const error = "Product price cannot be zero";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Step 1: Add product to LoyaltyEngage cart
    const addToCartSuccess = await addProductToLoyaltyCart(tenant, email, sku, 1);
    if (!addToCartSuccess) {
      const error = "Failed to add product to loyalty cart";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Small delay to ensure cart is updated
    await new Promise(resolve => setTimeout(resolve, 200));

    // Step 2: Purchase from LoyaltyEngage cart
    const orderNumber = 'LE-' + Date.now().toString(36).toUpperCase();
    const purchaseSuccess = await purchaseFromLoyaltyCart(tenant, email, orderNumber, [{ sku, quantity: 1 }]);
    if (!purchaseSuccess) {
      const error = "Failed to purchase from loyalty cart";
      logData.error = error;
      logData.statusCode = 400;
      return json({ error }, { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Step 3: Create Shopify discount code for the specific variant
    const discountCode = 'LE-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const discountSuccess = await createShopifyDiscountForVariant(
      tenant,
      discountCode,
      normalizedPrice,
      variantId
    );

    if (!discountSuccess) {
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
      order_number: orderNumber,
    };

    logData.response = JSON.stringify(response);
    logData.statusCode = 200;
    logData.duration = Date.now() - startTime;

    return json(response, { 
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*" }
    });

  } catch (error) {
    console.error("Product redemption error:", error);
    
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

// Add product to LoyaltyEngage cart
async function addProductToLoyaltyCart(tenant, email, sku, quantity = 1) {
  try {
    const url = `https://app.loyaltyengage.tech/api/v1/loyalty/shop/${encodeURIComponent(email)}/cart/add`;
    const authHeader = 'Basic ' + Buffer.from(`${tenant.loyaltyLogin}:${tenant.loyaltyToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sku, quantity }),
    });

    const data = await response.json();
    console.log('[LoyaltyEngage] Add to cart response:', data);

    if (!response.ok || data.error) {
      console.error('[LoyaltyEngage] Add to cart failed:', data);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[LoyaltyEngage] Add to cart error:', error);
    return false;
  }
}

// Purchase from LoyaltyEngage cart
async function purchaseFromLoyaltyCart(tenant, email, orderNumber, products) {
  try {
    const url = `https://app.loyaltyengage.tech/api/v1/loyalty/shop/${encodeURIComponent(email)}/cart/purchase`;
    const authHeader = 'Basic ' + Buffer.from(`${tenant.loyaltyLogin}:${tenant.loyaltyToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderNumber,
        products,
      }),
    });

    const data = await response.json();
    console.log('[LoyaltyEngage] Purchase response:', data);

    if (!response.ok || data.error) {
      console.error('[LoyaltyEngage] Purchase failed:', data);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[LoyaltyEngage] Purchase error:', error);
    return false;
  }
}

// Get product GID from variant GID
async function getProductGidByVariantGid(tenant, variantGid) {
  try {
    const query = {
      query: `
        query($id: ID!) {
          productVariant(id: $id) {
            product { id }
          }
        }
      `,
      variables: { id: variantGid }
    };

    const response = await shopifyGraphQLRequest(tenant.shopDomain, tenant.accessToken, query);
    
    if (!response?.data?.productVariant?.product?.id) {
      console.error('[Shopify] Variant→Product lookup failed:', response);
      return null;
    }

    return response.data.productVariant.product.id;
  } catch (error) {
    console.error('[Shopify] Variant→Product lookup error:', error);
    return null;
  }
}

// Create Shopify discount for specific variant with fixed amount
async function createShopifyDiscountForVariant(tenant, code, amount, variantId) {
  try {
    console.log(`[Shopify] Creating variant discount ${code} - ${amount} for variant ${variantId}`);

    // Ensure variant ID is in GID format
    const variantGid = variantId.startsWith('gid://shopify/ProductVariant/') 
      ? variantId 
      : `gid://shopify/ProductVariant/${variantId}`;

    // Get product GID from variant GID
    const productGid = await getProductGidByVariantGid(tenant, variantGid);
    if (!productGid) {
      console.error('[Shopify] Could not find product for variant:', variantId);
      return false;
    }

    // Normalize amount as string with dot decimal
    const normalizedAmount = String(amount).replace(',', '.');

    const mutation = {
      query: `
        mutation discountCodeBasicCreate($input: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $input) {
            codeDiscountNode { id }
            userErrors { field message }
          }
        }
      `,
      variables: {
        input: {
          title: 'Loyalty Product Free',
          code: code,
          startsAt: new Date().toISOString(),
          usageLimit: 1,
          customerSelection: { all: true },
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: true,
            shippingDiscounts: true
          },
          customerGets: {
            value: {
              discountAmount: {
                amount: normalizedAmount,
                appliesOnEachItem: true
              }
            },
            items: {
              products: {
                productsToAdd: [productGid]
              }
            }
          }
        }
      }
    };

    const response = await shopifyGraphQLRequest(
      tenant.shopDomain,
      tenant.accessToken,
      mutation
    );

    console.log('[Shopify] Variant discount creation response:', JSON.stringify(response, null, 2));

    if (!response?.data?.discountCodeBasicCreate) {
      console.error('[Shopify] Invalid discount creation response');
      return false;
    }

    const userErrors = response.data.discountCodeBasicCreate.userErrors || [];
    if (userErrors.length > 0) {
      console.error('[Shopify] Discount creation errors:', userErrors);
      return false;
    }

    console.log(`[Shopify] Successfully created variant discount: ${code}`);
    return true;

  } catch (error) {
    console.error('[Shopify] Variant discount creation error:', error);
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
