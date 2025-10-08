// File: routes/api/discount/purchase.ts

import { json } from '@remix-run/node';
import prisma from '../db.server';
import { apiVersion } from '../shopify.server';



export const loader = async ({ request }) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  return json({ ok: true }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
};

export const action = async ({ params, request }) => {
  try {
    const { email, sku, shop } = params;

    if (!email || !sku || !shop) {
      throw new Error('Missing required fields');
    }

    console.log(email, sku, shop, '==== Incoming Redeem Request ====');

    const session = await prisma.session.findFirst({ where: { shop } });
    const loyalty = await prisma.loyalty.findFirst({ where: { shop } });
    if (!session) throw new Error('Session not found');

    const { accessToken } = session;
    const { loyaltyEngageID, loyaltyEngageSecret } = loyalty;
    const authHeader = 'Basic ' + Buffer.from(`${loyaltyEngageID}:${loyaltyEngageSecret}`).toString('base64');
    console.log(sku, "this is SKU ============>>>>> ")
    // 1. Buy Discount Code
    const buyRes = await fetch(`https://app.loyaltyengage.tech/api/v1/loyalty/shop/${email}/cart/buy_discount_code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({ sku }),
    });

    const buyData = await buyRes.json();
    console.log('buyData:', buyData);


    if (buyData.message === "AVAILABLE_COINS_INSUFFICIENT") {
      console.log("YourCoinesis kamhay");
      return new Response(
        JSON.stringify({ success: false, message: "Not Enough Coins" }),
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    } else if (buyData.message === "CONTACT_NOT_FOUND") {
      console.log("YourCoinesis kamhay");
      return new Response(
        JSON.stringify({ success: false, message: "Subscribe first loyalty Engage" }),
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
    else if (!buyRes.ok || !buyData.discountCode) {
      throw new Error('Failed to buy discount code');
    }

    const { discountCode, discountPercentage } = buyData;

    const discountValue = discountPercentage / 100; // Convert to percentage value
    // 2. Fetch Customer ID from Shopify
    const findCustomerByEmailQuery = `
      query {
        customers(first: 250) {
          edges {
            node {
              id
              email
            }
          }
        }
      }
    `;

    const customerLookupRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: findCustomerByEmailQuery }),
    });

    const customerLookupData = await customerLookupRes.json();

    if (!customerLookupRes.ok || customerLookupData.errors) {
      throw new Error('Failed to fetch customers from Shopify');
    }

    const allCustomers = customerLookupData.data.customers.edges.map(edge => edge.node);
    const matchedCustomer = allCustomers.find(c => c.email === email);

    if (!matchedCustomer) {
      throw new Error(`No Shopify customer found with email: ${email}`);
    }

    const custId = matchedCustomer.id.replace('gid://shopify/Customer/', '');
    console.log('Resolved Customer ID:', custId);

    // 3. Redeem Discount Code
    const redeemRes = await fetch(`https://app.loyaltyengage.tech/api/v1/discount/${discountCode}/redeem`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({ email }),
    });

    if (!redeemRes.ok) {
      throw new Error('Failed to redeem discount');
    }

    // 4. Create Automatic Discount for This Customer in Shopify
    const discountCodeMutation = `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;


    const discountCodeInput = {
      basicCodeDiscount: {
        title: `Loyalty Discount ${discountCode}`,
        code: discountCode,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        customerSelection: {
          customers: {
            add: [`gid://shopify/Customer/${custId}`]
          }
        },
        customerGets: {
          value: {
            percentage: parseFloat(discountValue),
          },
          items: {
            all: true,
          },
        },
        usageLimit: 1,
        appliesOncePerCustomer: true,
      }
    };


    const shopifyRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: discountCodeMutation,
        variables: { basicCodeDiscount: discountCodeInput.basicCodeDiscount },
      }),
    });


    const shopifyData = await shopifyRes.json();
    console.log('shopifyData:', shopifyData);
    const userErrors = shopifyData?.data?.discountCodeBasicCreate?.userErrors;

    if (shopifyData.errors || (userErrors && userErrors.length)) {
      console.error('Shopify Errors:', userErrors || shopifyData.errors);
      throw new Error('Automatic discount creation failed');
    }

    return new Response(
      JSON.stringify({
        success: true,
        discountCode,
        discountPercentage: parseFloat(discountValue),
      }),
      {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      }
    );
  } catch (error) {
    console.error('Purchase Discount Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        message: error.message || 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      }
    );
  }
};
