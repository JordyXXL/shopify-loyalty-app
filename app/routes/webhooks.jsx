import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { handleLoyaltyConnectWebhook } from "../loyalty-connect/index.server";
import { LOYALTY_CONNECT_ONLY_TOPICS } from "../loyalty-connect/webhooks.server";

const db = prisma;

function formatPhone(phone) {
  if (!phone) return null;

  // If already starts with +, assume it's valid
  if (phone.startsWith('+')) return phone;

  // Example: assume Pakistan if local number starts with 03
  if (phone.startsWith('03')) {
    return '+92' + phone.slice(1);
  }

  return null; // If unrecognized format
}

// The Loyalty Engage handling, unchanged.
async function loyaltyEngageWebhook({ topic, shop, admin, payload }) {

  console.log("Webhook Triggered:", topic, "for shop:", shop);

  // Get tenant configuration for this shop
  const tenant = await prisma.tenant.findFirst({ 
    where: { 
      shopDomain: shop,
      isActive: true,
    } 
  });

  // Fallback to legacy loyalty config if no tenant found
  let loyaltyConfig = null;
  if (!tenant) {
    loyaltyConfig = await prisma.loyalty.findFirst({ where: { shop } });
    if (!loyaltyConfig) {
      console.warn("No tenant or loyalty config found for shop:", shop);
      return new Response();
    }
  }

  const credentials = tenant 
    ? btoa(`${tenant.loyaltyLogin}:${tenant.loyaltyToken}`)
    : btoa(`${loyaltyConfig.loyaltyEngageID}:${loyaltyConfig.loyaltyEngageSecret}`);
  
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Basic ${credentials}`,
  };

  if (topic === "ORDERS_CREATE") {
    const firstLineItem = payload.line_items?.[0];
    const rawProperties = firstLineItem?.properties || [];
    const customer_Email = payload.customer?.email;
    const order_Id = payload.id;
    const orderDate = payload.created_at;
    const totalvalue = payload.total_price || "10";
    const quantity = firstLineItem?.quantity || 1;
    const isPhysical = rawProperties[0]?.value || null;

    if (!isPhysical) {
      // ➤ Call Loyalty Engage Events API
      const eventPayload = {
        event: "Purchase",
        email: customer_Email,
        Value: totalvalue.toString(),
        orderId: order_Id.toString(),
        orderDate,
      };

      console.log("Triggering LoyaltyEngage Event", quantity, "times");

      for (let i = 0; i < quantity; i++) {
        try {
          const eventRes = await fetch("https://app.loyaltyengage.tech/api/v1/events", {
            method: "POST",
            headers,
            body: JSON.stringify([eventPayload]),
          });

          const data = await eventRes.json();
          console.log(`✅ Loyalty Event Response (${i + 1}):`, data);
        } catch (err) {
          console.error(`❌ Loyalty Event Error on attempt ${i + 1}:`, err);
        }
      }
    } else {

      const { sku } = firstLineItem;
      const user_email = payload.email;

      try {
        const cartAddRes = await fetch(
          `https://app.loyaltyengage.tech/api/v1/loyalty/shop/${user_email}/cart/add`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ sku, quantity }),
          }
        );
        const cartAddData = await cartAddRes.json();
        console.log("✅ Loyalty Cart Add:", cartAddData);

        const purchaseRes = await fetch(
          `https://app.loyaltyengage.tech/api/v1/loyalty/shop/${user_email}/cart/purchase`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ order_Id }),
          }
        );
        const purchaseData = await purchaseRes.json();
        console.log("✅ Loyalty Purchase:", purchaseData);
      } catch (err) {
        console.error("❌ Loyalty Cart/Purchase Error:", err);
      }
    }

    // ➤ Sync Loyalty Summary to Klaviyo
    try {
      // 1. Get loyalty summary
      const summaryRes = await fetch(
        `https://app.loyaltyengage.tech/api/v1/contact/${customer_Email}/loyalty_status`,
        { method: "GET", headers }
      );
      const loyaltyData = await summaryRes.json();

      const {
        currentPoints,
        reservedCoins,
        availableCoins,
        currentTier,
        currentTierId,
        nextTier,
        nextTierId,
        pointsRequiredForNextTier,
        pointsRemainingToNextTier,
      } = loyaltyData;

      // 2. Get Klaviyo profile by email
      const profileRes = await fetch(
        `https://a.klaviyo.com/api/profiles?filter=equals(email,"${customer_Email}")`,
        {
          method: "GET",
          headers: {
            accept: "application/vnd.api+json",
            revision: "2025-04-15",
            Authorization: `Klaviyo-API-Key pk_58bdcbd4ec2527a3431758468a39b49e9e`,
          },
        }
      );
      const profileJson = await profileRes.json();
      const profileId = profileJson.data?.[0]?.id || null;
      console.log("Klaviyo Profile ID:", profileId);
      // 3. Build common properties
      const properties = {
        currentPoints,
        reservedCoins,
        availableCoins,
        currentTier,
        currentTierId,
        nextTier,
        nextTierId,
        pointsRequiredForNextTier,
        pointsRemainingToNextTier,
      };


      if (profileId !== null) {
        // ✅ Update profile
        const formattedPhone = formatPhone(payload.customer?.phone || "");
        const patchRes = await fetch(
          `https://a.klaviyo.com/api/profiles/${profileId}`,
          {
            method: "PATCH",
            headers: {
              accept: "application/vnd.api+json",
              "content-type": "application/vnd.api+json",
              revision: "2025-04-15",
              Authorization: `Klaviyo-API-Key pk_58bdcbd4ec2527a3431758468a39b49e9e`,
            },
            body: JSON.stringify({
              data: {
                type: "profile",
                id: profileId,
                attributes: {
                  email: customer_Email,
                  first_name: payload.customer?.first_name || "",
                  last_name: payload.customer?.last_name || "",
                  phone_number: formatPhone(payload.customer?.phone || ""),
                  external_id: `shopify_customer_${payload.customer?.id}`,
                  properties: {
                    currentPoints,
                    reservedCoins,
                    availableCoins,
                    currentTier,
                    currentTierId,
                    nextTier,
                    nextTierId,
                    pointsRequiredForNextTier,
                    pointsRemainingToNextTier,
                  }
                }
              }
            }),
          }
        );
        const patchResult = await patchRes.json();
        console.log("✅ Klaviyo Profile Updated:", patchResult);
      } else {
        // ✅ Create new profile
        const createRes = await fetch("https://a.klaviyo.com/api/profiles", {
          method: "POST",
          headers: {
            "accept": "application/vnd.api+json",
            "content-type": "application/vnd.api+json",
            "revision": "2025-04-15",
            "Authorization": `Klaviyo-API-Key pk_58bdcbd4ec2527a3431758468a39b49e9e`,
          },
          body: JSON.stringify({
            data: {
              type: "profile",
              attributes: {
                email: customer_Email,
                first_name: payload.customer?.first_name || "",
                last_name: payload.customer?.last_name || "",
                phone_number: payload.customer?.phone || "",
                properties,
              },
            },
          }),
        });
        const createResult = await createRes.json();
        console.log("✅ Klaviyo Profile Created:", createResult);
      }
    } catch (err) {
      console.error("❌ Klaviyo Sync Failed:", err);
    }


  }

  // Optional: CUSTOMERS_CREATE logic
  if (topic === "CUSTOMERS_CREATE") {
    // You can add future logic for new customers here
  }

  // ➤ GDPR / App uninstall handling
  if (!admin && topic !== "SHOP_REDACT") {
    throw new Response();
  }

  switch (topic) {
    case "APP_UNINSTALLED":
      await db.session.deleteMany({ where: { shop } });
      break;

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
      // GDPR-related handlers (optional)
      break;

    default:
      console.warn("⚠️ Unhandled webhook topic:", topic);
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
}

export const action = async ({ request }) => {
  const { topic, shop, admin, payload, webhookId } = await authenticate.webhook(request);

  // Loyalty Connect's own topics (orders/updated, orders/cancelled, refunds/create): queued for Loyalty Connect when it is on for
  // the shop, and always answered 200; the Loyalty Engage code never sees them.
  if (LOYALTY_CONNECT_ONLY_TOPICS.has(topic)) {
    await handleLoyaltyConnectWebhook({ topic, shop, webhookId, payload });
    return new Response();
  }

  // Every other topic goes to Loyalty Engage exactly as before. Loyalty Connect works alongside: started first, awaited last, never
  // throwing, so it neither delays nor changes the Loyalty Engage forwarding or the answer to Shopify.
  const loyaltyConnect = handleLoyaltyConnectWebhook({ topic, shop, webhookId, payload });
  try {
    return await loyaltyEngageWebhook({ topic, shop, admin, payload });
  } finally {
    await loyaltyConnect;
  }
};
