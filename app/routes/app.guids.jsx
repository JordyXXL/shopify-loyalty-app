import { BlockStack, Card, Layout, List, Page } from "@shopify/polaris";


const Guids = () => {
  return (
   <Page title="Loyalty App Integration Guide">
  <Layout>
    <Layout.Section>
      <Card>
        <BlockStack gap="200">

          <Card title="Step 1: Add API Credentials">
            <List type="number">
              <List.Item>Go to the Settings page.</List.Item>
              <List.Item>Enter your <strong>Loyalty Engage ID</strong> and <strong>Loyalty Engage Secret</strong>.</List.Item>
              <List.Item>Also enter your <strong>Loyalty Email</strong> and <strong>Password</strong>.</List.Item>
              <List.Item>Click <strong>Save</strong>.</List.Item>
            </List>
          </Card>

          <Card title="Step 2: Sync Loyalty Products">
            <List type="number">
              <List.Item>Go to the <strong>Product Settings</strong> tab.</List.Item>
              <List.Item>Click the <strong>Sync Products</strong> button.</List.Item>
              <List.Item>This will create loyalty reward products in your Shopify store.</List.Item>
            </List>
          </Card>

          <Card title="Step 3: Add Loyalty Products to Sales Channels">
            <List type="number">
              <List.Item>Go to your Shopify admin → <strong>Products</strong>.</List.Item>
              <List.Item>Search for products with the tag <code>loyalty</code>.</List.Item>
              <List.Item>Click into each and assign them to the <strong>Online Store</strong> sales channel.</List.Item>
            </List>
          </Card>

          <Card title="Step 4: Organize into a Collection">
            <List type="number">
              <List.Item>In Shopify admin, go to <strong>Collections</strong>.</List.Item>
              <List.Item>Create or open the <strong>Loyalty Products</strong> collection.</List.Item>
              <List.Item>Add all loyalty products to this collection for easier management.</List.Item>
            </List>
          </Card>

          <Card title="Step 5: Add Loyalty Collection to Store Navigation">
            <List type="number">
              <List.Item>Go to <strong>Online Store → Navigation</strong>.</List.Item>
              <List.Item>Open your <strong>Main Menu</strong>.</List.Item>
              <List.Item>Add a new menu item linking to the <strong>Loyalty Products</strong> collection.</List.Item>
            </List>
          </Card>

          <Card title="Step 6: Enable App Embed in Theme">
            <List type="number">
              <List.Item>Go to <strong>Online Store → Themes → Customize</strong>.</List.Item>
              <List.Item>Click on <strong>App Embeds</strong> in the left sidebar.</List.Item>
              <List.Item>Enable both toggle switches related to the Loyalty app.</List.Item>
            </List>
          </Card>

          <Card title="Step 7: Add Loyalty App Block to Product Page">
            <List type="number">
              <List.Item>While in the Theme Editor, go to the <strong>Product Page</strong>.</List.Item>
              <List.Item>Click <strong>Add Block</strong> in the App section.</List.Item>
              <List.Item>Select the <strong>Loyalty App Block</strong> and customize it as needed.</List.Item>
            </List>
          </Card>

          <Card title="Step 8: Create Loyalty Pages and Templates">
            <List type="number">
              <List.Item>In the Theme Editor, click the dropdown at the top and select <strong>Home Page → Create Template</strong>.</List.Item>
              <List.Item>Create two new templates:
                <ul>
                  <li><code>loyalty</code></li>
                  <li><code>new-loyalty_information</code></li>
                </ul>
              </List.Item>
              <List.Item>Then go to <strong>Online Store → Pages</strong>.</List.Item>
              <List.Item>Create two new pages and assign the respective templates:
                <ul>
                  <li><strong>Loyalty</strong> → use the <code>loyalty</code> template</li>
                  <li><strong>Loyalty Information</strong> → use the <code>new-loyalty_information</code> template</li>
                </ul>
              </List.Item>
            </List>
          </Card>

        </BlockStack>
      </Card>
    </Layout.Section>
  </Layout>
</Page>

  )
}

export default Guids
