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
  Checkbox,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { afterTenantChange, LOYALTY_CONNECT_INTENTS, loyaltyConnectAction, loyaltyConnectView } from "../loyalty-connect/admin.server";
import { loyaltyConnectQueue } from "../loyalty-connect/index.server";

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

  const loyaltyConnect = await loyaltyConnectView(prisma, tenants.map((t) => t.id));

  return json({
    loyaltyConfig,
    tenants,
    queueStats,
    purchaseStats,
    shop: session.shop,
    loyaltyConnect,
  });
};

// === ACTION ===
export const action = async ({ request }) => {
  try {
    const { session, scopes } = await authenticate.admin(request);
    const formData = await request.formData();
    const action = formData.get("action");

    if (LOYALTY_CONNECT_INTENTS.has(action)) {
      try {
        const result = await loyaltyConnectAction({ db: prisma, intent: action, formData, session, scopes, queue: loyaltyConnectQueue });
        return json({ ...result, tenantId: Number(formData.get("tenantId")) }, { status: result.status === "success" ? 200 : 400 });
      } catch (error) {
        if (error instanceof Response) return error; // Shopify's permission screen for the pixel scopes
        throw error;
      }
    }

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
      await afterTenantChange({ db: prisma, tenantId, session, scopes });

      return json({ status: "success", message: "Tenant updated successfully" });
    }

    if (action === "delete_tenant") {
      const tenantId = parseInt(formData.get("tenantId"));
      await afterTenantChange({ db: prisma, tenantId, session, scopes, deleting: true });
      
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
  const { loyaltyConfig, tenants, queueStats, purchaseStats, shop, loyaltyConnect } = useLoaderData();
  const fetcher = useFetcher();
  const connectFetcher = useFetcher();
  const [connectTenant, setConnectTenant] = useState(null);
  const [connectForm, setConnectForm] = useState({ enabled: false, publicKey: "", secretKey: "" });
  const connectView = connectTenant ? loyaltyConnect?.byTenant?.[connectTenant.id] : null;

  useEffect(() => {
    if (connectFetcher.data?.status === "success") {
      setConnectForm((f) => ({ ...f, secretKey: "" }));
    }
  }, [connectFetcher.data]);

  const openConnect = (tenant) => {
    const view = loyaltyConnect?.byTenant?.[tenant.id];
    setConnectTenant(tenant);
    setConnectForm({ enabled: Boolean(view?.enabled), publicKey: view?.publicKey || "", secretKey: "" });
  };

  const submitConnect = (intent) => {
    const data = new FormData();
    data.append("action", intent);
    data.append("tenantId", connectTenant.id);
    if (intent === "loyalty_connect_save") {
      data.append("enabled", String(connectForm.enabled));
      data.append("publicKey", connectForm.publicKey);
      data.append("secretKey", connectForm.secretKey);
    }
    connectFetcher.submit(data, { method: "post" });
  };

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
    loyaltyConnect?.byTenant?.[tenant.id]?.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>,
    tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString() : "N/A",
    <ButtonGroup>
      <Button size="slim" onClick={() => handleEdit(tenant)}>Edit</Button>
      <Button size="slim" onClick={() => openConnect(tenant)}>Loyalty Connect</Button>
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
                columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text']}
                headings={['Name', 'Shop Domain', 'Status', 'Profile Queue', 'Purchase Queue', 'Loyalty Connect', 'Created', 'Actions']}
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

      {/* Loyalty Connect Modal */}
      <Modal
        open={Boolean(connectTenant)}
        onClose={() => setConnectTenant(null)}
        title={`Loyalty Connect: ${connectTenant?.name ?? ""}`}
        primaryAction={{
          content: "Save",
          onAction: () => submitConnect("loyalty_connect_save"),
          loading: connectFetcher.state !== "idle",
        }}
        secondaryActions={[
          {
            content: "Test connection",
            onAction: () => submitConnect("loyalty_connect_test"),
            disabled: !connectView?.hasSecretKey || connectFetcher.state !== "idle",
          },
          {
            content: "Close",
            onAction: () => setConnectTenant(null),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {connectFetcher.data?.message && connectFetcher.data?.tenantId === connectTenant?.id && (
              <Banner tone={connectFetcher.data.status === "success" ? "success" : "critical"}>
                <p>{connectFetcher.data.message}</p>
              </Banner>
            )}
            {loyaltyConnect && !loyaltyConnect.available && (
              <Banner tone="warning">
                <p>The Loyalty Connect tables are missing in the database: apply the migration (npx prisma db push or npx prisma migrate deploy).</p>
              </Banner>
            )}
            {loyaltyConnect && !loyaltyConnect.encryptionReady && (
              <Banner tone="warning">
                <p>LOYALTY_CONNECT_ENCRYPTION_KEY is not set on the server: keys cannot be stored or read.</p>
              </Banner>
            )}
            {connectView && !connectView.keysReadable && (
              <Banner tone="warning">
                <p>The stored keys cannot be read (the encryption key changed?). Enter both keys again.</p>
              </Banner>
            )}
            <Text as="p">
              Sends this shop&apos;s orders, cancellations and refunds, and (only after the visitor&apos;s consent) its storefront and checkout
              events to Loyalty Connect at {loyaltyConnect?.connectUrl}. Off: nothing is sent.
            </Text>
            <FormLayout>
              <Checkbox
                label="Send data to Loyalty Connect"
                checked={connectForm.enabled}
                onChange={(value) => setConnectForm({ ...connectForm, enabled: value })}
              />
              <TextField
                label="Public key"
                value={connectForm.publicKey}
                onChange={(value) => setConnectForm({ ...connectForm, publicKey: value })}
                placeholder="cs_pub_…"
                helpText="From the shop's source in Loyalty Connect. Used by the browser pixel. Stored encrypted."
                autoComplete="off"
              />
              <TextField
                label="Secret source key"
                value={connectForm.secretKey}
                onChange={(value) => setConnectForm({ ...connectForm, secretKey: value })}
                type="password"
                placeholder={connectView?.secretKeyHint ? `Stored: ${connectView.secretKeyHint}` : "cs_sec_…"}
                helpText="From the same source. Stored encrypted and never shown again. Leave empty to keep the stored key."
                autoComplete="off"
              />
            </FormLayout>
            <Divider />
            <BlockStack gap="200">
              <Text variant="headingSm" as="h3">Status</Text>
              <Text as="p">
                Connection test:{" "}
                {connectView?.lastTestAt
                  ? `${connectView.lastTestOk ? "OK" : "failed"} (${new Date(connectView.lastTestAt).toLocaleString()}): ${connectView.lastTestMessage ?? ""}`
                  : "not tested yet"}
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="span">Browser pixel:</Text>
                {connectView?.pixelStatus === "installed" ? (
                  <Badge tone="success">Installed</Badge>
                ) : connectView?.pixelStatus === "needs_permission" ? (
                  <Badge tone="attention">Needs permission</Badge>
                ) : connectView?.pixelStatus === "error" ? (
                  <Badge tone="critical">Error</Badge>
                ) : connectView?.pixelStatus === "uninstalled" ? (
                  <Badge>App uninstalled</Badge>
                ) : (
                  <Badge>Not installed</Badge>
                )}
                {connectView?.pixelStatus === "needs_permission" && (
                  <Button size="slim" onClick={() => submitConnect("loyalty_connect_scopes")}>Grant pixel permissions</Button>
                )}
                {connectView?.enabled && connectView?.pixelStatus !== "needs_permission" && (
                  <Button size="slim" onClick={() => submitConnect("loyalty_connect_pixel")}>Re-install pixel</Button>
                )}
              </InlineStack>
              {connectView?.pixelError && <Text as="p" tone="critical">Pixel: {connectView.pixelError}</Text>}
              <Text as="p">
                Deliveries (last 7 days; failed: 30 days): {connectView?.counts?.PENDING ?? 0} waiting, {connectView?.counts?.PROCESSING ?? 0} sending,{" "}
                {connectView?.counts?.DONE ?? 0} delivered, {connectView?.counts?.FAILED ?? 0} failed, {connectView?.counts?.SKIPPED ?? 0} skipped
              </Text>
              <Text as="p">
                Last delivery:{" "}
                {connectView?.lastDeliveryAt
                  ? `${new Date(connectView.lastDeliveryAt).toLocaleString()}: ${connectView.lastDeliveryStatus ?? ""}`
                  : "none yet"}
              </Text>
              {connectView?.lastError && (
                <Text as="p" tone="critical">
                  Last error{connectView.lastErrorAt ? ` (${new Date(connectView.lastErrorAt).toLocaleString()})` : ""}: {connectView.lastError}
                </Text>
              )}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
