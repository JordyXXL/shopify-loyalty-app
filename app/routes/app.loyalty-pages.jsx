import { useEffect, useState } from "react";
import { json, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  Banner,
  DataTable,
  Badge,
  Modal,
  TextContainer,
  ButtonGroup,
  Text,
  Box,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// === LOADER ===
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  // Get current shop's loyalty config
  const loyaltyConfig = await prisma.loyalty.findFirst({
    where: { shop: session.shop },
  });

  // Get tenants for this shop
  const tenants = await prisma.tenant.findMany({
    where: { shopDomain: session.shop },
    include: {
      loyaltyPages: true,
    },
  });

  // Get themes from Shopify
  let themes = [];
  try {
    const themesResponse = await admin.rest.resources.Theme.all({
      session,
    });
    themes = themesResponse.data || [];
  } catch (error) {
    console.error("Failed to fetch themes:", error);
  }

  return json({
    loyaltyConfig,
    tenants,
    themes,
    shop: session.shop,
  });
};

// === ACTION ===
export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const action = formData.get("action");

    if (action === "inject_loyalty_page") {
      const tenantId = parseInt(formData.get("tenantId"));
      const themeId = formData.get("themeId");
      
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant) {
        return json({ status: "error", message: "Tenant not found" }, { status: 400 });
      }

      // Create loyalty page template in theme
      const success = await injectLoyaltyPageToTheme(admin, session, themeId);
      
      if (success) {
        // Record in database
        await prisma.loyaltyPage.upsert({
          where: {
            tenantId_themeId: {
              tenantId: tenantId,
              themeId: themeId,
            },
          },
          update: {
            isActive: true,
            settings: JSON.stringify({
              injectedAt: new Date().toISOString(),
              templateKey: 'page.loyalty-program',
            }),
          },
          create: {
            tenantId: tenantId,
            themeId: themeId,
            templateKey: 'page.loyalty-program',
            isActive: true,
            settings: JSON.stringify({
              injectedAt: new Date().toISOString(),
              templateKey: 'page.loyalty-program',
            }),
          },
        });

        return json({ status: "success", message: "Loyalty page injected successfully" });
      } else {
        return json({ status: "error", message: "Failed to inject loyalty page" }, { status: 500 });
      }
    }

    if (action === "remove_loyalty_page") {
      const tenantId = parseInt(formData.get("tenantId"));
      const themeId = formData.get("themeId");
      
      // Remove from theme
      const success = await removeLoyaltyPageFromTheme(admin, session, themeId);
      
      if (success) {
        // Update database
        await prisma.loyaltyPage.updateMany({
          where: {
            tenantId: tenantId,
            themeId: themeId,
          },
          data: {
            isActive: false,
          },
        });

        return json({ status: "success", message: "Loyalty page removed successfully" });
      } else {
        return json({ status: "error", message: "Failed to remove loyalty page" }, { status: 500 });
      }
    }

    if (action === "create_loyalty_page") {
      const themeId = formData.get("themeId");
      
      // Create a page in Shopify that uses the loyalty template
      const success = await createLoyaltyPage(admin, session, themeId);
      
      if (success) {
        return json({ status: "success", message: "Loyalty page created successfully" });
      } else {
        return json({ status: "error", message: "Failed to create loyalty page" }, { status: 500 });
      }
    }

    return json({ status: "error", message: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Loyalty page management error:", error);
    return json(
      { status: "error", message: error.message || "Failed to process request" },
      { status: 500 }
    );
  }
};

// Inject loyalty page template to theme
async function injectLoyaltyPageToTheme(admin, session, themeId) {
  try {
    // Read the loyalty page template
    const fs = await import('fs');
    const path = await import('path');
    
    const templatePath = path.join(process.cwd(), 'extensions/loyalty-page/sections/loyalty-program.liquid');
    const templateContent = fs.readFileSync(templatePath, 'utf8');

    // Create the template in Shopify theme
    const asset = new admin.rest.resources.Asset({ session });
    asset.theme_id = parseInt(themeId);
    asset.key = 'sections/loyalty-program.liquid';
    asset.value = templateContent;
    
    await asset.save({
      update: true,
    });

    // Also create a page template that uses this section
    const pageTemplate = `
<div class="page-width">
  {% section 'loyalty-program' %}
</div>
`;

    const pageAsset = new admin.rest.resources.Asset({ session });
    pageAsset.theme_id = parseInt(themeId);
    pageAsset.key = 'templates/page.loyalty-program.liquid';
    pageAsset.value = pageTemplate;
    
    await pageAsset.save({
      update: true,
    });

    console.log(`Successfully injected loyalty page to theme ${themeId}`);
    return true;
  } catch (error) {
    console.error('Failed to inject loyalty page:', error);
    return false;
  }
}

// Remove loyalty page template from theme
async function removeLoyaltyPageFromTheme(admin, session, themeId) {
  try {
    // Remove section
    const sectionAsset = new admin.rest.resources.Asset({ session });
    sectionAsset.theme_id = parseInt(themeId);
    sectionAsset.key = 'sections/loyalty-program.liquid';
    
    await sectionAsset.delete();

    // Remove page template
    const pageAsset = new admin.rest.resources.Asset({ session });
    pageAsset.theme_id = parseInt(themeId);
    pageAsset.key = 'templates/page.loyalty-program.liquid';
    
    await pageAsset.delete();

    console.log(`Successfully removed loyalty page from theme ${themeId}`);
    return true;
  } catch (error) {
    console.error('Failed to remove loyalty page:', error);
    return false;
  }
}

// Create a loyalty page in Shopify
async function createLoyaltyPage(admin, session, themeId) {
  try {
    // Create a page that uses the loyalty template
    const page = new admin.rest.resources.Page({ session });
    page.title = 'Loyalty Program';
    page.handle = 'loyalty-program';
    page.body_html = '<p>This page uses the loyalty program template.</p>';
    page.template_suffix = 'loyalty-program';
    page.published = true;
    
    await page.save({
      update: true,
    });

    console.log('Successfully created loyalty page');
    return true;
  } catch (error) {
    console.error('Failed to create loyalty page:', error);
    return false;
  }
}

// === COMPONENT ===
export default function LoyaltyPagesPage() {
  const { loyaltyConfig, tenants, themes, shop } = useLoaderData();
  const fetcher = useFetcher();

  const [showInjectModal, setShowInjectModal] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [selectedTheme, setSelectedTheme] = useState('');
  const [successBanner, setSuccessBanner] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");

  useEffect(() => {
    if (fetcher.data?.status === "success") {
      setSuccessBanner(true);
      setErrorBanner("");
      setShowInjectModal(false);
      setSelectedTenant(null);
      setSelectedTheme('');
    } else if (fetcher.data?.status === "error") {
      setErrorBanner(fetcher.data?.message || "Something went wrong.");
      setSuccessBanner(false);
    }
  }, [fetcher.data]);

  const handleInject = (tenant) => {
    setSelectedTenant(tenant);
    setShowInjectModal(true);
  };

  const handleSubmitInject = () => {
    if (!selectedTenant || !selectedTheme) return;

    const formData = new FormData();
    formData.append("action", "inject_loyalty_page");
    formData.append("tenantId", selectedTenant.id);
    formData.append("themeId", selectedTheme);

    fetcher.submit(formData, { method: "post" });
  };

  const handleRemove = (tenant, themeId) => {
    if (!confirm("Are you sure you want to remove the loyalty page from this theme?")) return;

    const formData = new FormData();
    formData.append("action", "remove_loyalty_page");
    formData.append("tenantId", tenant.id);
    formData.append("themeId", themeId);

    fetcher.submit(formData, { method: "post" });
  };

  const handleCreatePage = (themeId) => {
    const formData = new FormData();
    formData.append("action", "create_loyalty_page");
    formData.append("themeId", themeId);

    fetcher.submit(formData, { method: "post" });
  };

  // Prepare table data
  const tableRows = tenants.flatMap((tenant) => 
    tenant.loyaltyPages.map((page) => {
      const theme = themes.find(t => t.id.toString() === page.themeId);
      return [
        tenant.name,
        theme ? theme.name : `Theme ${page.themeId}`,
        theme ? (theme.role === 'main' ? 'Published' : 'Unpublished') : 'Unknown',
        page.isActive ? <Badge status="success">Active</Badge> : <Badge status="critical">Inactive</Badge>,
        page.createdAt ? new Date(page.createdAt).toLocaleDateString() : "N/A",
        <ButtonGroup>
          <Button 
            size="slim" 
            onClick={() => handleCreatePage(page.themeId)}
            loading={fetcher.state !== "idle"}
          >
            Create Page
          </Button>
          <Button 
            size="slim" 
            destructive 
            onClick={() => handleRemove(tenant, page.themeId)}
            loading={fetcher.state !== "idle"}
          >
            Remove
          </Button>
        </ButtonGroup>
      ];
    })
  );

  return (
    <Page
      title="Loyalty Page Management"
      primaryAction={{
        content: "Inject Loyalty Page",
        onAction: () => setShowInjectModal(true),
        disabled: tenants.length === 0,
      }}
    >
      <TitleBar title="Loyalty App - Pages" />

      {successBanner && (
        <Banner
          title="Success"
          status="success"
          onDismiss={() => setSuccessBanner(false)}
        >
          <p>{fetcher.data?.message}</p>
        </Banner>
      )}

      {errorBanner && (
        <Banner
          title="Error"
          status="critical"
          onDismiss={() => setErrorBanner("")}
        >
          <p>{errorBanner}</p>
        </Banner>
      )}

      <BlockStack gap="500">
        {/* Overview Cards */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Themes Available</Text>
                <Text variant="headingLg">{themes.length}</Text>
                <Text variant="bodySm" color="subdued">
                  {themes.filter(t => t.role === 'main').length} published
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Tenants</Text>
                <Text variant="headingLg">{tenants.length}</Text>
                <Text variant="bodySm" color="subdued">
                  {tenants.filter(t => t.isActive).length} active
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Injected Pages</Text>
                <Text variant="headingLg">
                  {tenants.reduce((acc, tenant) => acc + tenant.loyaltyPages.length, 0)}
                </Text>
                <Text variant="bodySm" color="subdued">
                  {tenants.reduce((acc, tenant) => acc + tenant.loyaltyPages.filter(p => p.isActive).length, 0)} active
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Available Themes */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Available Themes</Text>
            {themes.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text']}
                headings={['Theme Name', 'Role', 'Created', 'Actions']}
                rows={themes.map(theme => [
                  theme.name,
                  theme.role === 'main' ? 'Published' : 'Unpublished',
                  theme.created_at ? new Date(theme.created_at).toLocaleDateString() : "N/A",
                  <Button 
                    size="slim" 
                    onClick={() => {
                      setSelectedTheme(theme.id.toString());
                      setShowInjectModal(true);
                    }}
                    disabled={tenants.length === 0}
                  >
                    Inject to Theme
                  </Button>
                ])}
              />
            ) : (
              <Box padding="400">
                <TextContainer>
                  <Text>No themes found. Please check your Shopify store.</Text>
                </TextContainer>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* Injected Pages */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Injected Loyalty Pages</Text>
            {tableRows.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text']}
                headings={['Tenant', 'Theme', 'Theme Status', 'Page Status', 'Injected', 'Actions']}
                rows={tableRows}
              />
            ) : (
              <Box padding="400">
                <TextContainer>
                  <Text>No loyalty pages injected yet. Use the "Inject Loyalty Page" button to get started.</Text>
                </TextContainer>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* Instructions */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">How to Use</Text>
            <BlockStack gap="200">
              <Text>1. <strong>Inject Loyalty Page:</strong> This adds the loyalty program template to your selected theme.</Text>
              <Text>2. <strong>Create Page:</strong> This creates a new page in Shopify that uses the loyalty template.</Text>
              <Text>3. <strong>Configure Tenant:</strong> Make sure you have configured at least one tenant in the Tenants section.</Text>
              <Text>4. <strong>Theme Customization:</strong> After injection, you can customize the loyalty page in your theme editor.</Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Inject Modal */}
      <Modal
        open={showInjectModal}
        onClose={() => {
          setShowInjectModal(false);
          setSelectedTenant(null);
          setSelectedTheme('');
        }}
        title="Inject Loyalty Page"
        primaryAction={{
          content: "Inject Page",
          onAction: handleSubmitInject,
          loading: fetcher.state !== "idle",
          disabled: !selectedTenant || !selectedTheme,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setShowInjectModal(false);
              setSelectedTenant(null);
              setSelectedTheme('');
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text>Select a tenant and theme to inject the loyalty page template:</Text>
            
            <BlockStack gap="200">
              <Text variant="headingMd">Tenant</Text>
              {tenants.length > 0 ? (
                <InlineStack gap="200">
                  {tenants.map(tenant => (
                    <Button
                      key={tenant.id}
                      pressed={selectedTenant?.id === tenant.id}
                      onClick={() => setSelectedTenant(tenant)}
                    >
                      {tenant.name}
                    </Button>
                  ))}
                </InlineStack>
              ) : (
                <Text color="critical">No tenants configured. Please add a tenant first.</Text>
              )}
            </BlockStack>

            <BlockStack gap="200">
              <Text variant="headingMd">Theme</Text>
              {themes.length > 0 ? (
                <InlineStack gap="200" wrap>
                  {themes.map(theme => (
                    <Button
                      key={theme.id}
                      pressed={selectedTheme === theme.id.toString()}
                      onClick={() => setSelectedTheme(theme.id.toString())}
                    >
                      {theme.name} {theme.role === 'main' && '(Published)'}
                    </Button>
                  ))}
                </InlineStack>
              ) : (
                <Text color="critical">No themes found.</Text>
              )}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
