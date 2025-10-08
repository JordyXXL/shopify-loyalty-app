import { useEffect, useState } from "react";
import { json, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  Badge,
  ProgressBar,
  Box,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// === LOADER ===
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Get analytics data
  const analytics = await getAnalyticsData(session.shop);

  return json({
    analytics,
    shop: session.shop,
  });
};

async function getAnalyticsData(shop) {
  const now = new Date();
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Get tenant statistics
  const tenants = await prisma.tenant.findMany({
    where: { shopDomain: shop },
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

  // Queue statistics
  const queueStats = {
    profile: await prisma.profileQueue.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    purchase: await prisma.purchaseQueue.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
  };

  // API usage statistics
  const apiStats = {
    total: await prisma.apiLog.count(),
    last24h: await prisma.apiLog.count({
      where: { createdAt: { gte: last24Hours } }
    }),
    last7d: await prisma.apiLog.count({
      where: { createdAt: { gte: last7Days } }
    }),
    last30d: await prisma.apiLog.count({
      where: { createdAt: { gte: last30Days } }
    }),
  };

  // Error rate analysis
  const errorStats = await prisma.apiLog.groupBy({
    by: ['statusCode'],
    _count: { statusCode: true },
    where: { createdAt: { gte: last24Hours } }
  });

  // Most used endpoints
  const endpointStats = await prisma.apiLog.groupBy({
    by: ['endpoint'],
    _count: { endpoint: true },
    where: { createdAt: { gte: last7Days } },
    orderBy: { _count: { endpoint: 'desc' } },
    take: 10,
  });

  // Performance metrics
  const performanceStats = await prisma.apiLog.aggregate({
    _avg: { duration: true },
    _max: { duration: true },
    _min: { duration: true },
    where: { 
      createdAt: { gte: last24Hours },
      duration: { not: null }
    }
  });

  // Recent errors
  const recentErrors = await prisma.apiLog.findMany({
    where: {
      error: { not: null },
      createdAt: { gte: last7Days }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      endpoint: true,
      method: true,
      statusCode: true,
      error: true,
      createdAt: true,
    }
  });

  // Queue processing trends (last 7 days)
  const queueTrends = await prisma.profileQueue.groupBy({
    by: ['status'],
    _count: { status: true },
    where: { createdAt: { gte: last7Days } }
  });

  return {
    tenants: {
      total: tenants.length,
      active: tenants.filter(t => t.isActive).length,
      details: tenants,
    },
    queues: {
      profile: queueStats.profile.reduce((acc, stat) => {
        acc[stat.status] = stat._count.status;
        return acc;
      }, {}),
      purchase: queueStats.purchase.reduce((acc, stat) => {
        acc[stat.status] = stat._count.status;
        return acc;
      }, {}),
      trends: queueTrends,
    },
    api: {
      usage: apiStats,
      errors: errorStats,
      endpoints: endpointStats,
      performance: performanceStats,
      recentErrors,
    },
  };
}

// === COMPONENT ===
export default function AnalyticsPage() {
  const { analytics, shop } = useLoaderData();

  // Calculate success rate
  const totalRequests = analytics.api.usage.last24h;
  const errorRequests = analytics.api.errors
    .filter(stat => stat.statusCode >= 400)
    .reduce((sum, stat) => sum + stat._count.statusCode, 0);
  const successRate = totalRequests > 0 ? ((totalRequests - errorRequests) / totalRequests) * 100 : 100;

  // Calculate queue health
  const profileTotal = Object.values(analytics.queues.profile).reduce((sum, count) => sum + count, 0);
  const profilePending = analytics.queues.profile.PENDING || 0;
  const profileFailed = analytics.queues.profile.FAILED || 0;
  const profileHealth = profileTotal > 0 ? ((profileTotal - profileFailed) / profileTotal) * 100 : 100;

  const purchaseTotal = Object.values(analytics.queues.purchase).reduce((sum, count) => sum + count, 0);
  const purchasePending = analytics.queues.purchase.PENDING || 0;
  const purchaseFailed = analytics.queues.purchase.FAILED || 0;
  const purchaseHealth = purchaseTotal > 0 ? ((purchaseTotal - purchaseFailed) / purchaseTotal) * 100 : 100;

  return (
    <Page title="Analytics & Monitoring">
      <TitleBar title="Loyalty App - Analytics" />

      <BlockStack gap="500">
        {/* Overview Cards */}
        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">API Success Rate (24h)</Text>
                <Text variant="headingLg" color={successRate >= 95 ? "success" : successRate >= 90 ? "warning" : "critical"}>
                  {successRate.toFixed(1)}%
                </Text>
                <ProgressBar 
                  progress={successRate} 
                  color={successRate >= 95 ? "success" : successRate >= 90 ? "warning" : "critical"}
                />
                <Text variant="bodySm" color="subdued">
                  {totalRequests} total requests
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Queue Health</Text>
                <InlineStack gap="300">
                  <BlockStack gap="100">
                    <Text variant="bodySm">Profiles</Text>
                    <Text variant="headingMd" color={profileHealth >= 95 ? "success" : "warning"}>
                      {profileHealth.toFixed(1)}%
                    </Text>
                    <Text variant="bodySm" color="subdued">
                      {profilePending} pending
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text variant="bodySm">Purchases</Text>
                    <Text variant="headingMd" color={purchaseHealth >= 95 ? "success" : "warning"}>
                      {purchaseHealth.toFixed(1)}%
                    </Text>
                    <Text variant="bodySm" color="subdued">
                      {purchasePending} pending
                    </Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd">Performance</Text>
                <Text variant="headingLg">
                  {analytics.api.performance._avg?.duration 
                    ? `${Math.round(analytics.api.performance._avg.duration)}ms`
                    : 'N/A'
                  }
                </Text>
                <Text variant="bodySm" color="subdued">
                  Average response time (24h)
                </Text>
                {analytics.api.performance._max?.duration && (
                  <Text variant="bodySm" color="subdued">
                    Max: {Math.round(analytics.api.performance._max.duration)}ms
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* API Usage Statistics */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd">API Usage</Text>
                <DataTable
                  columnContentTypes={['text', 'numeric']}
                  headings={['Period', 'Requests']}
                  rows={[
                    ['Last 24 hours', analytics.api.usage.last24h],
                    ['Last 7 days', analytics.api.usage.last7d],
                    ['Last 30 days', analytics.api.usage.last30d],
                    ['Total', analytics.api.usage.total],
                  ]}
                />
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd">Queue Status</Text>
                <DataTable
                  columnContentTypes={['text', 'numeric', 'numeric']}
                  headings={['Status', 'Profiles', 'Purchases']}
                  rows={[
                    ['Pending', analytics.queues.profile.PENDING || 0, analytics.queues.purchase.PENDING || 0],
                    ['Processing', analytics.queues.profile.PROCESSING || 0, analytics.queues.purchase.PROCESSING || 0],
                    ['Done', analytics.queues.profile.DONE || 0, analytics.queues.purchase.DONE || 0],
                    ['Failed', analytics.queues.profile.FAILED || 0, analytics.queues.purchase.FAILED || 0],
                  ]}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Top Endpoints */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Most Used Endpoints (7 days)</Text>
            {analytics.api.endpoints.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'numeric']}
                headings={['Endpoint', 'Requests']}
                rows={analytics.api.endpoints.map(stat => [
                  stat.endpoint,
                  stat._count.endpoint
                ])}
              />
            ) : (
              <Box padding="400">
                <Text>No API usage data available for the last 7 days.</Text>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* Recent Errors */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Recent Errors (7 days)</Text>
            {analytics.api.recentErrors.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'text', 'numeric', 'text', 'text']}
                headings={['Endpoint', 'Method', 'Status', 'Error', 'Time']}
                rows={analytics.api.recentErrors.map(error => [
                  error.endpoint,
                  error.method,
                  error.statusCode || 'N/A',
                  error.error ? (error.error.length > 50 ? error.error.substring(0, 50) + '...' : error.error) : 'N/A',
                  new Date(error.createdAt).toLocaleString(),
                ])}
              />
            ) : (
              <Box padding="400">
                <Text color="success">No errors in the last 7 days! 🎉</Text>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* Tenant Overview */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Tenant Overview</Text>
            {analytics.tenants.details.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'text', 'numeric', 'numeric', 'numeric']}
                headings={['Tenant', 'Status', 'Profile Queue', 'Purchase Queue', 'Loyalty Pages']}
                rows={analytics.tenants.details.map(tenant => [
                  tenant.name,
                  tenant.isActive ? <Badge status="success">Active</Badge> : <Badge status="critical">Inactive</Badge>,
                  tenant._count.profileQueue,
                  tenant._count.purchaseQueue,
                  tenant._count.loyaltyPages,
                ])}
              />
            ) : (
              <Box padding="400">
                <Text>No tenants configured yet.</Text>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* System Health Summary */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">System Health Summary</Text>
            <BlockStack gap="200">
              <InlineStack gap="400">
                <Text>
                  <strong>Overall Status:</strong> {' '}
                  <Badge status={successRate >= 95 && profileHealth >= 95 && purchaseHealth >= 95 ? "success" : "warning"}>
                    {successRate >= 95 && profileHealth >= 95 && purchaseHealth >= 95 ? "Healthy" : "Needs Attention"}
                  </Badge>
                </Text>
              </InlineStack>
              
              <Text variant="bodySm" color="subdued">
                • API Success Rate: {successRate.toFixed(1)}% (Target: ≥95%)
              </Text>
              <Text variant="bodySm" color="subdued">
                • Profile Queue Health: {profileHealth.toFixed(1)}% (Target: ≥95%)
              </Text>
              <Text variant="bodySm" color="subdued">
                • Purchase Queue Health: {purchaseHealth.toFixed(1)}% (Target: ≥95%)
              </Text>
              <Text variant="bodySm" color="subdued">
                • Average Response Time: {analytics.api.performance._avg?.duration 
                  ? `${Math.round(analytics.api.performance._avg.duration)}ms`
                  : 'N/A'
                } (Target: &lt;500ms)
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
