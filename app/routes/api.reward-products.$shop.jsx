import { json } from '@remix-run/node';
import prisma from '../db.server';
import { apiVersion } from '../shopify.server';

export const loader = async ({ request, params }) => {
  if (request.method === 'OPTIONS') {
    const { shop } = params;

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const { shop } = params;
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) {
    return json(
      { success: false, message: 'Shop session not found' },
      {
        status: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      }
    );
  }

  const accessToken = session.accessToken;
  const GRAPHQL_URL = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const REST_URL = `https://${shop}/admin/api/${apiVersion}/products`;

  // STEP 1: Try to find the product by title
  const existingProductQuery = `
    query {
      products(first: 1, query: "title:'Loyalty Purchase Reward'") {
        edges {
          node {
            id
            title
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                }
              }
            }
          }
        }
      }
    }
  `;

  const existingRes = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query: existingProductQuery }),
  });

  const existingJson = await existingRes.json();
  const existingProduct = existingJson?.data?.products?.edges?.[0]?.node;

  if (existingProduct) {
    const variant = existingProduct?.variants?.edges?.[0]?.node;
    if (variant?.id && variant?.price) {
      return json(
        {
          success: true,
          product: {
            variantId: variant.id,
            price: variant.price,
            currencyCode: 'USD',
          },
        },
        {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        }
      );
    }
  }

  // STEP 2: Create new product if not found
  const sku = `LOYALTY-${Date.now()}`;
  const createMutation = `
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // Create the product
  const createRes = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      query: createMutation,
      variables: {
        input: {
          title: 'Loyalty Purchase Reward',
          descriptionHtml: '<p>Redeem this reward using your coins to make a purchase.</p>',
          vendor: 'XXL Nutrition',
          productType: 'Loyalty Reward',
          tags: ['loyalty', 'reward'],
          metafields: [
            {
              namespace: 'loyalty',
              key: 'reward_description',
              value: 'Redeem this reward using your coins to make a purchase.',
              type: 'single_line_text_field',
            },
          ],
        },
      },
    }),
  });

  const createJson = await createRes.json();
  const createErrors = createJson?.data?.productCreate?.userErrors;
  const createdProduct = createJson?.data?.productCreate?.product;

  if (createErrors?.length > 0 || !createdProduct?.id) {
    console.error('❌ Product creation failed:', createErrors || createJson.errors);
    return json(
      { success: false, error: createErrors || createJson.errors },
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      }
    );
  }

  // STEP 3: Create variant using REST API
  const productId = createdProduct.id.split('/').pop(); // Extract numeric product ID
  const variantRes = await fetch(`${REST_URL}/${productId}/variants.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({
      variant: {
        price: '20.00',
        sku,
        inventory_policy: 'continue',
      },
    }),
  });

  const variantJson = await variantRes.json();
  if (!variantRes.ok || variantJson.errors) {
    console.error('❌ Variant creation failed:', variantJson.errors || variantJson);
    return json(
      { success: false, error: variantJson.errors || 'Failed to create variant' },
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      }
    );
  }

  const createdVariant = variantJson.variant;

  return json(
    {
      success: true,
      product: {
        variantId: `gid://shopify/ProductVariant/${createdVariant.id}`,
        price: createdVariant.price,
        currencyCode: 'USD',
      },
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    }
  );
};
