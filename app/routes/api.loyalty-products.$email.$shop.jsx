import { json } from "@remix-run/node";
import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

export async function loader({ params }) {
  const { email, shop } = params;

  const session = await prisma.session.findFirst({
    where: { shop },
    select: {
      accessToken: true,

    },
  });
  const loyalty = await prisma.loyalty.findFirst({
    where: { shop },
    select: {
      loyaltyEngageID: true,
      loyaltyEngageSecret: true,
      E_Mail_Address: true,
    },
  });

  if (!session) {
    return json({ success: false, message: "Session not found" }, { status: 404 });
  }

  const { accessToken } = session;
  const { loyaltyEngageID, loyaltyEngageSecret, E_Mail_Address } = loyalty;

  const credentials = Buffer.from(`${loyaltyEngageID}:${loyaltyEngageSecret}`).toString("base64");

  // === Fetch user loyalty status ===
  const loyaltyStatusRes = await fetch(`https://app.loyaltyengage.tech/api/v1/contact/${email}/loyalty_status`, {
    method: "GET",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
  });

  if (!loyaltyStatusRes.ok) {
    return json({ success: false, message: "Loyalty API failed" }, { status: 500 });
  }

  const user_data = await loyaltyStatusRes.json();




  // === Fetch available products ===
  const productRes = await fetch(`https://app.loyaltyengage.tech/api/v1/loyalty/shop/available_products`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
  });

  const productData = await productRes.json();
  const loyaltyTitles = (productData.availableProducts || []).map(p => p.title.toLowerCase());

  // === Compare with Shopify products ===
  const shopifyQuery = `
    query {
      products(first: 250) {
        edges {
          node {
            title
          }
        }
      }
    }
  `;

  const shopifyRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: shopifyQuery }),
  });

  const shopifyData = await shopifyRes.json();
  const shopifyTitles = shopifyData?.data?.products?.edges?.map(edge => edge.node.title.toLowerCase()) || [];

  const missingProducts = productData.availableProducts.filter(
    (p) => !shopifyTitles.includes(p.title.toLowerCase())
  );

  return json({
    success: true,
    user_data,
    missingProducts,
  }, {
    headers: {
      "Access-Control-Allow-Origin": "*",
    }
  });
}
