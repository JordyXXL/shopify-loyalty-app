import { json } from "@remix-run/node";
import prisma from "../db.server";
import { apiVersion } from "../shopify.server";

export const loader = async ({ request, params }) => {
  const url = new URL(request.url);

  const { shop } = params
  // const shop = "testing-loyalty-store.myshopify.com";
  console.log(shop,url, "=========================>>>>>>>><<<<<<<<<<<<||||||||||")
  const session = await prisma.session.findFirst({ where: { shop } });
  const loyalty = await prisma.loyalty.findFirst({ where: { shop } });
  if (!session) {
    return json({ success: false, message: "Shop session not found" }, { status: 404 });
  }
  const { accessToken, } = session;
  const {  loyaltyEngageID, loyaltyEngageSecret, E_Mail_Address } = loyalty;

  // Fetch Shopify products
  let allProducts = [];
  let hasNextPage = true;
  let endCursor = null;

  while (hasNextPage) {
    const query = `
      query {
        products(first: 250${endCursor ? `, after: "${endCursor}"` : ""}, query: "published_status:published") {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              tags
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    price
                  }
                }
              }
              images(first: 1) {
                edges {
                  node {
                    originalSrc
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    });

    const jsonRes = await response.json();
    const data = jsonRes?.data?.products;

    if (data?.edges) {
      allProducts.push(...data.edges.map(edge => edge.node));
    }

    hasNextPage = data?.pageInfo?.hasNextPage;
    endCursor = data?.pageInfo?.endCursor;
  }

  // Fetch Loyalty Engage products
  const credentials = btoa(`${loyaltyEngageID}:${loyaltyEngageSecret}`);

  const loyaltyRes = await fetch(`https://app.loyaltyengage.tech/api/v1/loyalty/shop/available_products`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      Authorization: `Basic ${credentials}`,
    },
  });



  if (!loyaltyRes.ok) {
    return json({ success: false, message: "Failed to fetch loyalty products" }, { status: 500 });
  }

  const data = await loyaltyRes.json();
  const loyaltyProducts = data.availableProducts || [];

  // Match loyalty products to Shopify products by title
 const matchedProducts = loyaltyProducts.map(lp => {
  const match = allProducts.find(sp =>
    sp.title.trim().toLowerCase() === lp.title.trim().toLowerCase()
  );
console.log(lp.discountPercentage)
  if (match) {
    return {
      loyalty: {
        percentage: lp.discountPercentage,
        title: lp.title,
        coinPrice: lp.coinPrice,
        description: lp.shortDescription,
        sku: lp.sku,
        supplementaryPoints: lp.supplementaryPoints,
        requiredTier: lp.requiredLoyaltyTierName,
        requiredPoints: lp.requiredLoyaltyTierPoints,
        imageUrl: lp.imageUrl,
        product_type: lp.type
      },
      shopify: {
        id: match.id,
        title: match.title,
        variantId: match.variants.edges[0]?.node?.id,
        image: match.images.edges[0]?.node?.originalSrc || null,
        sku: match.variants.edges[0]?.node?.sku,
      },
    };
  }

  return null;
}).filter(Boolean);

return json({ success: true, matchedProducts }, {
  headers: {
    "Access-Control-Allow-Origin": "*",
  },
});
};
