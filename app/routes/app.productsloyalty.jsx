import { useLoaderData, Form, useActionData } from "@remix-run/react";
import { json } from "@remix-run/node";
import { DataTable, Page, Layout, Button, Card } from "@shopify/polaris";

import prisma from "../db.server";
import { apiVersion, authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop, accessToken } = session;

  const loyaltyData = await prisma.loyalty.findFirst({
    where: { shop },
    select: {
      loyaltyEngageID: true,
      loyaltyEngageSecret: true,
      E_Mail_Address: true,
    },
  });
  console.log("Loyalty Data:", loyaltyData.E_Mail_Address);
  const credentials = btoa(`${loyaltyData.loyaltyEngageID}:${loyaltyData.loyaltyEngageSecret}`);
  const res = await fetch(`https://app.loyaltyengage.tech/api/v1/loyalty/shop/available_products`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      Authorization: `Basic ${credentials}`,
    },
  });

  const data = await res.json();
  const loyaltyProducts = data.availableProducts || [];
  console.log("Fetched Loyalty Products:", loyaltyProducts);
  return json({ loyaltyProducts });
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const { shop, accessToken } = session;

  const loyaltyData = await prisma.loyalty.findFirst({
    where: { shop },
    select: {
      loyaltyEngageID: true,
      loyaltyEngageSecret: true,
      E_Mail_Address: true,
    },
  });

  const credentials = btoa(`${loyaltyData.loyaltyEngageID}:${loyaltyData.loyaltyEngageSecret}`);

  const publish = await admin.graphql(`
    query {
      publications(first: 10) {
        edges {
          node {
            id
            name
          }
        }
      }
  }`);

  const publish_ID = (await publish.json()).data?.publications?.edges?.find(
    (edge) => edge.node.name === "Online Store"
  )?.node?.id;

  const collectionCheckRes = await admin.graphql(`
    query {
      collections(first: 10, query: "title:Loyalty Products") {
        edges {
          node {
            id
            title
            handle
          }
        }
      }
  }`);
  const collectionCheckData = await collectionCheckRes.json();
  let loyaltyCollectionId = collectionCheckData?.data?.collections?.edges?.[0]?.node?.id;

  if (!loyaltyCollectionId) {
    const createCollectionRes = await admin.graphql(`
      mutation {
        collectionCreate(input: {
          title: "Loyalty Products",
          handle: "loyalty-products",
          descriptionHtml: "A collection of loyalty reward products."
        }) {
          collection {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }
    `);
    const created = await createCollectionRes.json();
    loyaltyCollectionId = created?.data?.collectionCreate?.collection?.id;

    // if (loyaltyCollectionId && publish_ID) {
    //   await admin.graphql(
    //     `
    //       mutation publishablePublish($input: PublishablePublishInput!) {
    //         publishablePublish(input: $input) {
    //           userErrors {
    //             field
    //             message
    //           }
    //         }
    //       }
    //     `,
    //     {
    //       variables: {
    //         input: {
    //           id: loyaltyCollectionId,
    //           publicationId: publish_ID,
    //         },
    //       },
    //     }
    //   );
    // }
  }

  const res = await fetch(`https://app.loyaltyengage.tech/api/v1/loyalty/shop/available_products`, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
    },
  });

  const data = await res.json();
  const loyaltyProducts = data.availableProducts || [];

  const productCreateMutation = `
  mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product { id title }
        userErrors { field message }
      }
    }
`;

  //   const productVariantsBulkCreateMutation = `
  //   mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  //     productVariantsBulkCreate(productId: $productId, variants: $variants) {
  //       product {
  //         id
  //         variants(first: 5) {
  //           edges {
  //             node {
  //               id
  //               sku
  //               price
  //             }
  //           }
  //         }
  //       }
  //       userErrors {
  //         field
  //         message
  //       }
  //     }
  //   }
  // `;


  const productUpdateMutation = `
  mutation productUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title }
      userErrors { field message }
    }
  }
`;
  const productMediaMutation = `
    mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
      productCreateMedia(media: $media, productId: $productId) {
        media { status preview { image { url } } }
        mediaUserErrors { field message }
      }
    }
  `;

  const productQueryBySKU = `
    query($sku: String!) {
      productVariants(first: 1, query: $sku) {
        edges {
          node {
            id
            sku
            price
            product {
              id
              title
            }
          }
        }
      }
    }
  `;

  const createdProducts = [];
  const productGIDs = [];




  for (const product of loyaltyProducts) {
    try {
      // Check if product exists by SKU
      const checkRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: productQueryBySKU,
          variables: { sku: product.sku },
        }),
      });

      const checkResult = await checkRes.json();
      const variant = checkResult.data?.productVariants?.edges?.[0]?.node;
      const existingProduct = variant?.product;

      if (existingProduct) {
        // Handle updating existing product
        const priceChanged = parseFloat(variant.price) !== parseFloat(product.coinPrice);
        const titleChanged = existingProduct.title !== product.title;

        if (!priceChanged && !titleChanged) {
          console.log(`✅ Product "${product.sku}" is up to date. Skipping...`);
          continue;
        }

        console.log(`✏️ Updating product "${product.sku}" due to price/title change.`);

        const updateRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: productUpdateMutation,
            variables: {
              product: {
                id: existingProduct.id,
                title: product.title,
              },
            },
          }),
        });

        const updateResult = await updateRes.json();
        if (updateResult.errors || updateResult.data.productUpdate.userErrors.length > 0) {
          console.error("❌ Product update error:", updateResult.errors || updateResult.data.productUpdate.userErrors);
          continue;
        }

        createdProducts.push(updateResult.data.productUpdate.product);
        productGIDs.push(updateResult.data.productUpdate.product.id);
        continue;
      }

      // Product doesn't exist — create it
      const createRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: productCreateMutation,
          variables: {
            input: {
              title: product.title,
              descriptionHtml: `<p>${product.shortDescription}</p>`,
              productType: product.type,
              tags: ["loyalty", "reward"],
            },
          },
        }),
      });


      const createResult = await createRes.json();
      const newProduct = createResult.data?.productCreate?.product;

      if (createResult.errors || createResult.data.productCreate.userErrors.length > 0) {
        console.error("❌ Product creation failed:", createResult.errors || createResult.data.productCreate.userErrors);
        continue;
      }
      console.log(newProduct.id, "this SKU FO PRoducts ")
      // Create variant for the new product
      const variantBulkMutation = `
          mutation {
            productVariantsBulkCreate(
              productId: "${newProduct.id}",
              variants: [
                {
                  sku: "${product.sku}",
                  price: "00"
                }
              ]
            ) {
              product {
                id
                variants(first: 5) {
                  edges {
                    node {
                      id
                      sku
                      price
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

      // Send it via fetch
      const variantBulkRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: variantBulkMutation,
        }),
      });


      const variantBulkResult = await variantBulkRes.json();

      console.log(variantBulkResult, "thsi Check SKU Mutation seta")
      createdProducts.push(newProduct);
      productGIDs.push(newProduct.id);

      // Add product to collection
      if (newProduct.id && loyaltyCollectionId) {
        const productIdNumeric = newProduct.id.split("/").pop();
        const collectionIdNumeric = loyaltyCollectionId.split("/").pop();

        await fetch(`https://${shop}/admin/api/${apiVersion}/collects.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            collect: {
              product_id: productIdNumeric,
              collection_id: collectionIdNumeric,
            },
          }),
        });

        console.log(`📦 Added product ${newProduct.title} to loyalty collection.`);
      }

      // Add media (image) to the product
      if (product.imageUrl && newProduct?.id) {
        const mediaRes = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query: productMediaMutation,
            variables: {
              productId: newProduct.id,
              media: [{
                originalSource: product.imageUrl,
                mediaContentType: "IMAGE",
                alt: product.title,
              }],
            },
          }),
        });

        const mediaResult = await mediaRes.json();
        if (mediaResult.errors || mediaResult.data.productCreateMedia.mediaUserErrors.length > 0) {
          console.error("❌ Media upload failed:", mediaResult.errors || mediaResult.data.productCreateMedia.mediaUserErrors);
        }
      }
    } catch (err) {
      console.error("💥 Unexpected error while syncing product:", product.title, err);
    }
  }

  return json({
    success: true,
    createdCount: createdProducts.length,
    products: createdProducts,
  });
};


export default function SyncProductsLoyalty() {
  const { loyaltyProducts } = useLoaderData();
  //  const actionData = useActionData();
  // const { show, toastMessages } = useToast();

  //  useEffect(() => {
  //   if (actionData?.messages?.length) {
  //     for (const msg of actionData.messages) {
  //       show({
  //         content: msg.message,
  //         tone: msg.status === "exists" ? "critical" : "success",
  //       });
  //     }
  //   }
  // }, [actionData]);

  const rows = loyaltyProducts.map(product => [
    product.title,
    product.sku,
    product.coinPrice,
    product.type,
  ]);

  return (
    <Page title="Loyalty Products Sync">
      <Layout>
        <Layout.Section>
          <Form method="post">
            <Button submit primary>Sync Products</Button>
          </Form>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "text"]}
              headings={["Title", "SKU", "Coin Price", "Type"]}
              rows={rows}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
