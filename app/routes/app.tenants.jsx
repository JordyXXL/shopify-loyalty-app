import { useEffect, useState } from "react";
import { json, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  FormLayout,
  TextField,
  Banner,
  DataTable,
  Badge,
  Modal,
  TextContainer,
  ButtonGroup,
  Divider,
  InlineStack,
  Text,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// === LOADER ===
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Get current shop's loyalty config
  const loyaltyConfig = await prisma.loyalty.findFirst({
    where: { shop: session.shop },
  });

  // Get all tenants for this shop (if configured as multi-tenant)
  const tenants = await prisma.tenant.findMany({
    where: { shopDomain: session.shop },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: {
          profileQueue: true,
          purchaseQueue: true,
          loyaltyPages: true,
        }
      }
    }
  });

  // Get queue statistics
  const queueStats = await prisma.profileQueue.groupBy({
    by: ['status'],
    _count: {
      status: true,
    },
  });

  const purchaseStats = await prisma.purchaseQueue.groupBy({
    by: ['status'],
    _count: {
      status: true,
    },
  });

  return json({
    loyaltyConfig,
    tenants,
    queueStats,
    purchaseStats,
    shop: session.shop,
  });
};

// === ACTION ===
export const action = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const formData = await request.formData();
    const action = formData.get("action");

    if (action === "create_tenant") {
      const tenantData = {
        name: formData.get("name"),
        shopDomain: session.shop,
        accessToken: session.accessToken,
        loyaltyLogin: formData.get("loyaltyLogin"),
        loyaltyToken: formData.get("loyaltyToken"),
        basicAuthUser: formData.get("basicAuthUser"),
        basicAuthPass: formData.get("basicAuthPass"),
        allowedIps: formData.get("allowedIps") || null,
      };

      await prisma.tenant.create({
        data: tenantData,
      });

      return json({ status: "success", message: "Tenant created successfully" });
    }

    if (action === "update_tenant") {
      const tenantId = parseInt(formData.get("tenantId"));
      const updateData = {
        loyaltyLogin: formData.get("loyaltyLogin"),
        loyaltyToken: formData.get("loyaltyToken"),
        basicAuthUser: formData.get("basicAuthUser"),
        basicAuthPass: formData.get("basicAuthPass"),
        allowedIps: formData.get("allowedIps") || null,
        isActive: formData.get("isActive") === "true",
      };

      await prisma.tenant.update({
        where: { id: tenantId },
        data: updateData,
      });

      return json({ status: "success", message: "Tenant updated successfully" });
    }

    if (action === "delete_tenant") {
      const tenantId = parseInt(formData.get("tenantId"));
      
      await prisma.tenant.delete({
        where: { id: tenantId },
      });

      return json({ status: "success", message: "Tenant deleted successfully" });
    }

    if (action === "clear_queue") {
      const queueType = formData.get("queueType");
      
      if (queueType === "profile") {
        await prisma.profileQueue.deleteMany({
          where: { status: "DONE" },
        });
      } else if (queueType === "purchase") {
        await prisma.purchaseQueue.deleteMany({
          where: { status: "DONE" },
        });
      }

      return json({ status: "success", message: "Queue cleared successfully" });
    }

    return json({ status: "error", message: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Tenant management error:", error);
    return json(
      { status: "error", message: error.message || "Failed to process request" },
      { status: 500 }
    );
  }
};

// === COMPONENT ===
export default function TenantsPage() {
  const { loyaltyConfig, tenants, queueStats, purchaseStats, shop } = useLoaderData();
  const fetcher = useFetcher();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [successBanner, setSuccessBanner] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");

  // Form states
  const [formData, setFormData] = useState({
    name: "",
    loyaltyLogin: "",
    loyaltyToken: "",
    basicAuthUser: "",
    basicAuthPass: "",
    allowedIps: "",
  });

  useEffect(() => {
    if (fetcher.data?.status === "success") {
      setSuccessBanner(true);
      setErrorBanner("");
      setShowCreateModal(false);
      setShowEditModal(false);
      resetForm();
    } else if (fetcher.data?.status === "error") {
      setErrorBanner(fetcher.data?.message || "Something went wrong.");
      setSuccessBanner(false);
    }
  }, [fetcher.data]);

  const resetForm = () => {
    setFormData({
      name: "",
      loyaltyLogin: "",
      loyaltyToken: "",
      basicAuthUser: "",
      basicAuthPass: "",
      allowedIps: "",
    });
    setSelectedTenant(null);
  };

  const handleEdit = (tenant) => {
    setSelectedTenant(tenant);
    setFormData({
      name: tenant.name,
      loyaltyLogin: tenant.loyaltyLogin || "",
      loyaltyToken: tenant.loyaltyToken || "",
      basicAuthUser: tenant.basicAuthUser || "",
      basicAuthPass: tenant.basicAuthPass || "",
      allowedIps: tenant.allowedIps || "",
    });
    setShowEditModal(true);
  };

  const handleSubmit = (action) => {
    const submitData = new FormData();
    submitData.append("action", action);
    
    if (action === "update_tenant" && selectedTenant) {
      submitData.append("tenantId", selectedTenant.id);
    }
    
    Object.entries(formData).forEach(([key, value]) => {
      submitData.append(key, value);
    });

    fetcher.submit(submitData, { method: "post" });
  };

  // Prepare table data
  const tableRows = tenants.map((tenant) => [
    tenant.name,
    tenant.shopDomain,
    tenant.isActive ? <Badge status="success">Active</Badge> : <Badge status="critical">Inactive</Badge>,
    `${tenant._count.profileQueue} profiles`,
    `${tenant._count.purchaseQueue} purchases`,
    tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString() : "N/A",
    <ButtonGroup>
      <Button size="slim" onClick={() => handleEdit(tenant)}>Edit</Button>
      <Button 
        size="slim" 
        destructive 
        onClick={() => {
          if (confirm("Are you sure you want to delete this tenant?")) {
            const deleteData = new FormData();
            deleteData.append("action", "delete_tenant");
            deleteData.append("tenantId", tenant.id);
            fetcher.submit(deleteData, { method: "post" });
          }
        }}
      >
        Delete
      </Button>
    </ButtonGroup>
  ]);

  // Calculate queue statistics
  const profileQueueStats = queueStats.reduce((acc, stat) => {
    acc[stat.status] = stat._count.status;
    return acc;
  }, {});

  const purchaseQueueStats = purchaseStats.reduce((acc, stat) => {
    acc[stat.status] = stat._count.status;
    return acc;
  }, {});

  return (
    <Page
      title="Multi-Tenant Management"
      primaryAction={{
        content: "Add Tenant",
        onAction: () => setShowCreateModal(true),
      }}
    >
      <TitleBar title="Loyalty App - Tenants" />

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
        {/* Queue Statistics */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Profile Queue</Text>
                <Text>Pending: {profileQueueStats.PENDING || 0}</Text>
                <Text>Processing: {profileQueueStats.PROCESSING || 0}</Text>
                <Text>Done: {profileQueueStats.DONE || 0}</Text>
                <Text>Failed: {profileQueueStats.FAILED || 0}</Text>
                <Button 
                  size="slim" 
                  onClick={() => {
                    const clearData = new FormData();
                    clearData.append("action", "clear_queue");
                    clearData.append("queueType", "profile");
                    fetcher.submit(clearData, { method: "post" });
                  }}
                >
                  Clear Completed
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Purchase Queue</Text>
                <Text>Pending: {purchaseQueueStats.PENDING || 0}</Text>
                <Text>Processing: {purchaseQueueStats.PROCESSING || 0}</Text>
                <Text>Done: {purchaseQueueStats.DONE || 0}</Text>
                <Text>Failed: {purchaseQueueStats.FAILED || 0}</Text>
                <Button 
                  size="slim" 
                  onClick={() => {
                    const clearData = new FormData();
                    clearData.append("action", "clear_queue");
                    clearData.append("queueType", "purchase");
                    fetcher.submit(clearData, { method: "post" });
                  }}
                >
                  Clear Completed
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Current Shop</Text>
                <Text>Domain: {shop}</Text>
                <Text>Tenants: {tenants.length}</Text>
                <Text>Loyalty Config: {loyaltyConfig ? "✓ Configured" : "⚠ Missing"}</Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Tenants Table */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Configured Tenants</Text>
            {tenants.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text', 'text']}
                headings={['Name', 'Shop Domain', 'Status', 'Profile Queue', 'Purchase Queue', 'Created', 'Actions']}
                rows={tableRows}
              />
            ) : (
              <Box padding="400">
                <TextContainer>
                  <Text>No tenants configured yet. Add your first tenant to get started with multi-tenant loyalty management.</Text>
                </TextContainer>
              </Box>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Create Tenant Modal */}
      <Modal
        open={showCreateModal}
        onClose={() => {
          setShowCreateModal(false);
          resetForm();
        }}
        title="Add New Tenant"
        primaryAction={{
          content: "Create Tenant",
          onAction: () => handleSubmit("create_tenant"),
          loading: fetcher.state !== "idle",
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setShowCreateModal(false);
              resetForm();
            },
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Tenant Name"
              value={formData.name}
              onChange={(value) => setFormData({ ...formData, name: value })}
              placeholder="e.g., main-store"
              helpText="Unique identifier for this tenant"
            />
            <TextField
              label="Loyalty Engage Login"
              value={formData.loyaltyLogin}
              onChange={(value) => setFormData({ ...formData, loyaltyLogin: value })}
              placeholder="Your LoyaltyEngage username"
            />
            <TextField
              label="Loyalty Engage Token"
              value={formData.loyaltyToken}
              onChange={(value) => setFormData({ ...formData, loyaltyToken: value })}
              type="password"
              placeholder="Your LoyaltyEngage API token"
            />
            <Divider />
            <TextField
              label="Basic Auth Username (Optional)"
              value={formData.basicAuthUser}
              onChange={(value) => setFormData({ ...formData, basicAuthUser: value })}
              placeholder="API authentication username"
            />
            <TextField
              label="Basic Auth Password (Optional)"
              value={formData.basicAuthPass}
              onChange={(value) => setFormData({ ...formData, basicAuthPass: value })}
              type="password"
              placeholder="API authentication password"
            />
            <TextField
              label="Allowed IPs (Optional)"
              value={formData.allowedIps}
              onChange={(value) => setFormData({ ...formData, allowedIps: value })}
              placeholder="192.168.1.1,10.0.0.1"
              helpText="Comma-separated list of allowed IP addresses"
              multiline={2}
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* Edit Tenant Modal */}
      <Modal
        open={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          resetForm();
        }}
        title="Edit Tenant"
        primaryAction={{
          content: "Update Tenant",
          onAction: () => handleSubmit("update_tenant"),
          loading: fetcher.state !== "idle",
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setShowEditModal(false);
              resetForm();
            },
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Tenant Name"
              value={formData.name}
              disabled
              helpText="Tenant name cannot be changed"
            />
            <TextField
              label="Loyalty Engage Login"
              value={formData.loyaltyLogin}
              onChange={(value) => setFormData({ ...formData, loyaltyLogin: value })}
            />
            <TextField
              label="Loyalty Engage Token"
              value={formData.loyaltyToken}
              onChange={(value) => setFormData({ ...formData, loyaltyToken: value })}
              type="password"
            />
            <Divider />
            <TextField
              label="Basic Auth Username"
              value={formData.basicAuthUser}
              onChange={(value) => setFormData({ ...formData, basicAuthUser: value })}
            />
            <TextField
              label="Basic Auth Password"
              value={formData.basicAuthPass}
              onChange={(value) => setFormData({ ...formData, basicAuthPass: value })}
              type="password"
            />
            <TextField
              label="Allowed IPs"
              value={formData.allowedIps}
              onChange={(value) => setFormData({ ...formData, allowedIps: value })}
              multiline={2}
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
