# Shopify Loyalty App - Enhanced Multi-Tenant Version

A comprehensive Shopify loyalty program application that integrates with LoyaltyEngage to provide advanced customer loyalty features, discount management, and product redemption capabilities.

## 🚀 Features

### Core Functionality
- **Multi-Tenant Support**: Manage multiple loyalty configurations per shop
- **Profile Synchronization**: Automatic customer profile sync with LoyaltyEngage
- **Discount Redemption**: Dynamic discount code generation and redemption
- **Product Redemption**: Loyalty points-based product purchasing
- **Event Tracking**: Customer behavior tracking and point attribution
- **Queue-Based Processing**: Reliable background processing for all operations

### Advanced Features
- **Theme Integration**: Automatic loyalty page injection into Shopify themes
- **Analytics Dashboard**: Comprehensive monitoring and performance metrics
- **Webhook Processing**: Real-time order and customer event handling
- **API Security**: Multi-layered authentication and IP restrictions
- **Background Jobs**: Automated queue processing and cleanup

## 📋 Requirements

- Node.js 18+ 
- PostgreSQL database
- Shopify Partner account
- LoyaltyEngage API credentials
- Shopify CLI

## 🛠 Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd shopify-private-app-loyalty-discounted-product-main\ 3
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Configure the following variables:
   ```env
   DATABASE_URL="postgresql://username:password@localhost:5432/loyalty_app"
   SHOPIFY_API_KEY="your_shopify_api_key"
   SHOPIFY_API_SECRET="your_shopify_api_secret"
   SCOPES="read_products,write_products,read_customers,write_customers,read_orders,write_orders,read_discounts,write_discounts,read_themes,write_themes"
   CRON_SECRET="your_secure_cron_secret"
   ```

4. **Set up the database**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```

## 🏗 Architecture

### Database Schema

The app uses a comprehensive database schema with the following key models:

- **Tenant**: Multi-tenant configuration management
- **ProfileQueue**: Asynchronous profile synchronization
- **PurchaseQueue**: Background purchase processing
- **LoyaltyPage**: Theme integration tracking
- **ApiLog**: Request logging and monitoring

### API Endpoints

#### Enhanced API Routes
- `POST /api/shopify/v1/update-profile` - Profile synchronization
- `POST /api/shopify/v1/redeem-discount` - Discount code redemption
- `POST /api/shopify/v1/redeem-product` - Product redemption
- `POST /api/shopify/v1/push-event` - Event tracking
- `POST /api/cron/process-queues` - Background processing

#### Admin Dashboard Routes
- `/app/tenants` - Multi-tenant management
- `/app/loyalty-pages` - Theme integration management
- `/app/analytics` - Performance monitoring

### Theme Integration

The app includes a comprehensive loyalty page theme extension:

- **Sections**: `loyalty-program.liquid`
- **Features**: 
  - Customer loyalty status display
  - Discount redemption interface
  - Product redemption system
  - Refer-a-friend functionality
  - FAQ system
  - Event tracking

## 🔧 Configuration

### Multi-Tenant Setup

1. **Access the Tenants Dashboard**
   - Navigate to `/app/tenants` in your app
   - Click "Add Tenant"

2. **Configure Tenant Settings**
   ```
   Tenant Name: main-store
   LoyaltyEngage Login: your_username
   LoyaltyEngage Token: your_api_token
   Basic Auth User: api_user (optional)
   Basic Auth Pass: api_password (optional)
   Allowed IPs: 192.168.1.1,10.0.0.1 (optional)
   ```

### Theme Integration

1. **Inject Loyalty Page**
   - Go to `/app/loyalty-pages`
   - Select tenant and theme
   - Click "Inject Loyalty Page"

2. **Create Loyalty Page**
   - Click "Create Page" to add a Shopify page
   - The page will use the loyalty template

3. **Customize in Theme Editor**
   - Access your Shopify theme editor
   - Find the "Loyalty Program" section
   - Configure blocks and settings

## 🔄 Background Processing

### Queue System

The app uses a robust queue system for reliable processing:

```bash
# Set up cron job to process queues every 5 minutes
*/5 * * * * curl -H "Authorization: Bearer your_cron_secret" -X POST https://your-app.com/api/cron/process-queues
```

### Queue Types

1. **Profile Queue**: Customer profile synchronization
2. **Purchase Queue**: Order and event processing
3. **Cleanup**: Automatic old data removal

## 📊 Monitoring

### Analytics Dashboard

Access comprehensive analytics at `/app/analytics`:

- **API Success Rate**: Real-time success metrics
- **Queue Health**: Processing status monitoring
- **Performance Metrics**: Response time analysis
- **Error Tracking**: Recent error logs
- **Tenant Overview**: Multi-tenant statistics

### Health Checks

- API Success Rate Target: ≥95%
- Queue Health Target: ≥95%
- Response Time Target: <500ms

## 🔐 Security

### Authentication Layers

1. **Shopify OAuth**: Standard app authentication
2. **Basic Auth**: API endpoint protection
3. **IP Restrictions**: Tenant-level IP filtering
4. **Cron Secret**: Background job protection

### Best Practices

- All API requests are logged
- Sensitive data is encrypted
- Rate limiting on public endpoints
- Input validation and sanitization

## 🔗 Loyalty Connect

For shops that use Attribute or Perform through Loyalty Engage, this app can also send the shop's data to **Loyalty Connect**, so the
merchant needs only this one app. It is **per tenant and off by default**: off, or without keys, nothing is sent to Loyalty Connect
and the Loyalty Engage forwarding is exactly as before. The code is in `app/loyalty-connect/` and `extensions/loyalty-connect-pixel/`.

### What is sent, and when

| Shopify | to Loyalty Connect | when |
|---|---|---|
| `orders/create`, `orders/updated`, `orders/cancelled` | `POST /api/v1/orders`: the order in Loyalty Connect's order contract, mapped exactly as Loyalty Connect's own Shopify app maps it (`app/loyalty-connect/orders.js`): id, versions (`updatedAt`), currency, totals and subtotal, discount codes, line items, refunds, cancellation, landing page and referrer, the survey answer, country and province of the shipping address, and the customer's e-mail address (Loyalty Connect replaces it with a keyed hash at its door; this app never logs it) | about a second after the webhook, from the queue |
| `refunds/create` | the order is read again through the Admin API and sent as a new version | idem |
| `customers/redact` | `POST /api/v1/erase` with the e-mail address as SHA-256 (`emailSha256`) and the order ids Shopify names; the address itself is not stored | idem |
| `customers/data_request` | nothing: this app keeps no customer data for Loyalty Connect. What Loyalty Connect holds is retrieved with Loyalty Connect's own privacy request flow: an admin of the shop's organisation makes an access request by the customer's e-mail address on the privacy page in Loyalty Connect, which returns one document with what Loyalty Connect and every connected product hold | — |
| `shop/redact` | nothing; the shop's Loyalty Connect settings and queued messages are deleted here | — |
| storefront and checkout events | the web pixel posts page views, product and cart events, checkout steps and `purchase` (with the order id, so event and order link) to `/collect?k=<public key>` | in the visitor's browser, only after consent |

Never sent: names, street, postcode, city, phone numbers, IP address, user agent, order notes. Orders and refunds are only sent while the
tenant has Loyalty Connect on and is active; an erasure is also sent for a tenant that was switched off after it had sent data.

**Delivery.** The webhook only stores the work in the `LoyaltyConnectQueue` table (encrypted; emptied once delivered), so Shopify and
the Loyalty Engage forwarding never wait for Loyalty Connect. Orders go in batches (at most 100, under 1.5 MB). Per order Loyalty Connect
answers `accepted`, `duplicate`, `not_forwarded` (done) or `refused` (failed, with the reason). Network errors, `401`/`403`, `408`,
`429` (after `Retry-After`) and `5xx` are retried after 1, 2, 4 … minutes, at most 6 hours apart, 15 times (about two days). The cron
call to `/api/cron/process-queues` also delivers what is due, after the Loyalty Engage queues and without changing their result.

**Consent.** The web pixel is the same as the one of Loyalty Connect's own Shopify app: Shopify loads it only for visitors who granted
**analytics and marketing** through Shopify's Customer Privacy API (the shop's cookie banner), so it never runs without that consent,
and it sends both Consent Mode types as granted. It reads no contact or address data of the checkout. Orders carry no browser data.

### Switching it on (per tenant)

1. In Loyalty Connect, the shop's source: copy the **public key** (`cs_pub_…`) and the **secret source key** (`cs_sec_…`). Make sure the
   source's allowed origins include the shop's domains (the pixel posts from the storefront and checkout).
2. In this app: **Tenants › Loyalty Connect** for the tenant: tick *Send data to Loyalty Connect*, paste both keys, **Save**.
   Saving installs the web pixel. The first time Shopify asks the merchant to grant the pixel permissions (*Grant pixel permissions*).
3. **Test connection** sends a made-up test order to `/api/v1/orders/validate` (Loyalty Connect stores and forwards nothing) and says
   whether the key works and whether a product is connected to the source.
4. The block shows the pixel status, the last delivery and the counts of waiting, delivered, failed and skipped messages.

Switching off removes the pixel and skips what still waits. Only one tenant per shop can have it on.

### What the owner must deploy

- **Environment variables** (new):
  - `LOYALTY_CONNECT_ENCRYPTION_KEY` (required to store keys): 32 random bytes as base64 or 64 hex characters, e.g.
    `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keys and queued messages are encrypted with
    AES-256-GCM under it; if it changes, the keys must be entered again.
  - `LOYALTY_CONNECT_URL` (optional): Loyalty Connect's origin, default `https://connect.valtracs.com`. A future domain change is only this
    setting (the API calls and the pixel's collector URL; press *Re-install pixel* per tenant after a change).
- **Database**: the models `LoyaltyConnectSettings` and `LoyaltyConnectQueue` (migration `prisma/migrations/20261027120000_loyalty_connect`;
  `npx prisma db push`, as `deploy.sh` does, creates them too).
- **Shopify app configuration** (`shopify app deploy` with `shopify.app.loyalty-engage.toml`): the webhook topics `orders/updated`,
  `orders/cancelled` and `refunds/create` (orders/create and the compliance topics are already subscribed), the optional scopes
  `write_pixels` and `read_customer_events`, and the extension `extensions/loyalty-connect-pixel`. The CLI writes a `uid` into the
  extension's toml on the first deploy: commit it. Orders and e-mail addresses on orders need the protected customer data access the app
  already uses for `orders/create`.
- Nothing else: the existing cron job delivers the queue.

### Tests

`npm test` (vitest) covers the order mapping against Loyalty Connect's own golden fixtures, refunds and cancellation, "off means no call",
per-item answers, retries on 5xx/429, erasure and shop redaction, the pixel payload, and that the Loyalty Engage webhook handling makes the
same calls with Loyalty Connect off or on.

## 🚀 Deployment

### Production Setup

1. **Environment Configuration**
   ```env
   NODE_ENV=production
   DATABASE_URL="your_production_db_url"
   CRON_SECRET="secure_random_string"
   ```

2. **Database Migration**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

3. **Build and Deploy**
   ```bash
   npm run build
   npm start
   ```

### Cron Job Setup

Set up the following cron jobs:

```bash
# Process queues every 5 minutes
*/5 * * * * curl -H "Authorization: Bearer $CRON_SECRET" -X POST https://your-app.com/api/cron/process-queues

# Health check every hour
0 * * * * curl https://your-app.com/api/cron/process-queues
```

## 🧪 Testing

### API Testing

Test the enhanced API endpoints:

```bash
# Profile update
curl -X POST https://your-app.com/api/shopify/v1/update-profile \
  -H "Authorization: Basic $(echo -n 'user:pass' | base64)" \
  -H "Content-Type: application/json" \
  -d '{"tenant":"main","email":"test@example.com","profiles":[...]}'

# Discount redemption
curl -X POST https://your-app.com/api/shopify/v1/redeem-discount \
  -H "Content-Type: application/json" \
  -d '{"tenant":"main","email":"test@example.com","sku":"DISCOUNT_5"}'
```

### Theme Testing

1. Install the app on a development store
2. Inject the loyalty page into your theme
3. Create a test customer with loyalty data
4. Test all loyalty page functionality

## 📝 Migration from WordPress Plugin

If migrating from the WordPress plugin:

1. **Export Data**: Extract customer profiles and settings
2. **Configure Tenants**: Set up equivalent tenant configurations
3. **API Mapping**: Update API endpoints to new format
4. **Theme Integration**: Replace WordPress shortcodes with Shopify sections
5. **Testing**: Verify all functionality works correctly

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:

1. Check the analytics dashboard for system health
2. Review API logs for error details
3. Verify tenant configuration
4. Check queue processing status

## 🔄 Changelog

### v2.0.0 - Enhanced Multi-Tenant Version
- ✅ Multi-tenant architecture
- ✅ Enhanced API endpoints
- ✅ Queue-based processing
- ✅ Theme integration system
- ✅ Analytics dashboard
- ✅ Comprehensive security
- ✅ Background job processing
- ✅ WordPress plugin feature parity

### v1.0.0 - Original Version
- Basic loyalty functionality
- Single tenant support
- Simple API endpoints

---

**Built with ❤️ for Shopify merchants who want to reward customer loyalty**
