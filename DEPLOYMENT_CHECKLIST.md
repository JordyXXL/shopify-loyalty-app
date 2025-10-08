# Digital Ocean Deployment Checklist

Use this checklist to ensure a successful deployment of your Shopify Loyalty App to Digital Ocean.

## 📋 Pre-Deployment Checklist

### ✅ Repository Setup
- [ ] Code pushed to GitHub repository
- [ ] `main` branch created and up-to-date
- [ ] `production` branch created for production deployments
- [ ] All deployment files are present:
  - [ ] `.github/workflows/deploy.yml`
  - [ ] `.do/app.yaml`
  - [ ] `Dockerfile`
  - [ ] `scripts/migrate.js`
  - [ ] `app/routes/health.jsx`

### ✅ Digital Ocean Setup
- [ ] Digital Ocean account created with billing enabled
- [ ] Personal Access Token generated
- [ ] Container Registry created (`shopify-loyalty-app`)
- [ ] Domain name configured (if using custom domain)

### ✅ GitHub Configuration
- [ ] Repository secrets configured:
  - [ ] `DIGITALOCEAN_ACCESS_TOKEN`
  - [ ] `SHOPIFY_API_KEY`
  - [ ] `SHOPIFY_API_SECRET`
  - [ ] `CRON_SECRET`
  - [ ] `SESSION_SECRET`
  - [ ] `APP_URL`

### ✅ Shopify Configuration
- [ ] Production Shopify app created in Partner Dashboard
- [ ] App URLs configured:
  - [ ] App URL: `https://your-domain.com`
  - [ ] Allowed redirection URLs: `https://your-domain.com/auth/callback`
- [ ] Required scopes enabled
- [ ] Webhooks configured (optional)

## 🚀 Deployment Steps

### Step 1: Initial Deployment
- [ ] Push code to `main` branch
- [ ] Verify GitHub Actions workflow runs successfully
- [ ] Check Digital Ocean App Platform for app creation
- [ ] Verify database is created and accessible

### Step 2: Environment Configuration
- [ ] Configure environment variables in Digital Ocean:
  - [ ] `SHOPIFY_API_KEY`
  - [ ] `SHOPIFY_API_SECRET`
  - [ ] `SHOPIFY_APP_URL`
  - [ ] `CRON_SECRET`
  - [ ] `SESSION_SECRET`
- [ ] Verify database connection string is automatically set

### Step 3: Domain Setup (if using custom domain)
- [ ] Add custom domain in Digital Ocean App Platform
- [ ] Configure DNS records:
  - [ ] CNAME record: `@` → `your-app.ondigitalocean.app`
  - [ ] CNAME record: `www` → `your-app.ondigitalocean.app`
- [ ] Wait for SSL certificate provisioning
- [ ] Update `SHOPIFY_APP_URL` environment variable

### Step 4: Health Checks
- [ ] Access health endpoint: `https://your-domain.com/health`
- [ ] Verify response shows "healthy" status
- [ ] Check database connectivity in health response
- [ ] Verify all required environment variables are present

### Step 5: Application Testing
- [ ] Access admin dashboard: `https://your-domain.com/app`
- [ ] Install app on development store
- [ ] Test tenant creation: `/app/tenants`
- [ ] Test loyalty page injection: `/app/loyalty-pages`
- [ ] Verify analytics dashboard: `/app/analytics`

## 🔧 Post-Deployment Configuration

### Shopify App Configuration
- [ ] Update app URLs in Shopify Partner Dashboard
- [ ] Test app installation on development store
- [ ] Configure webhooks (if needed):
  - [ ] Orders/Create: `https://your-domain.com/webhooks`
  - [ ] Customers/Create: `https://your-domain.com/webhooks`

### Multi-Tenant Setup
- [ ] Create first tenant via `/app/tenants`
- [ ] Configure LoyaltyEngage credentials
- [ ] Test API endpoints with tenant configuration
- [ ] Inject loyalty page into theme

### Monitoring Setup
- [ ] Configure Digital Ocean alerts
- [ ] Set up log monitoring
- [ ] Test queue processing (check logs after 5 minutes)
- [ ] Verify backup schedule is working

## 🧪 Testing Checklist

### Functional Testing
- [ ] App installation works
- [ ] Customer profile sync works
- [ ] Discount redemption works
- [ ] Product redemption works
- [ ] Event tracking works
- [ ] Queue processing works
- [ ] Loyalty page displays correctly

### Performance Testing
- [ ] Health check responds within 3 seconds
- [ ] API endpoints respond within 1 second
- [ ] Database queries are optimized
- [ ] Memory usage is within limits
- [ ] CPU usage is reasonable

### Security Testing
- [ ] SSL certificate is valid
- [ ] Environment variables are secure
- [ ] API endpoints require proper authentication
- [ ] Database is not publicly accessible
- [ ] No sensitive data in logs

## 📊 Monitoring & Maintenance

### Daily Checks
- [ ] Check application health: `https://your-domain.com/health`
- [ ] Review error logs in Digital Ocean console
- [ ] Monitor resource usage (CPU, Memory, Database)
- [ ] Verify queue processing is working

### Weekly Checks
- [ ] Review analytics dashboard for trends
- [ ] Check database performance metrics
- [ ] Review and clean up old logs
- [ ] Monitor SSL certificate expiration
- [ ] Update dependencies if needed

### Monthly Checks
- [ ] Review and optimize database queries
- [ ] Check for security updates
- [ ] Review resource usage and scaling needs
- [ ] Backup verification
- [ ] Performance optimization review

## 🚨 Troubleshooting

### Common Issues and Solutions

#### Deployment Fails
- [ ] Check GitHub Actions logs
- [ ] Verify all secrets are set correctly
- [ ] Check Dockerfile syntax
- [ ] Verify package.json scripts

#### Health Check Fails
- [ ] Check database connection
- [ ] Verify environment variables
- [ ] Check application logs
- [ ] Test database queries manually

#### App Installation Fails
- [ ] Verify Shopify app URLs
- [ ] Check OAuth configuration
- [ ] Verify SSL certificate
- [ ] Check application logs

#### Queue Processing Not Working
- [ ] Check worker process logs
- [ ] Verify cron secret configuration
- [ ] Test queue endpoint manually
- [ ] Check database queue tables

## 📞 Support Resources

### Digital Ocean
- **Documentation**: https://docs.digitalocean.com/products/app-platform/
- **Community**: https://www.digitalocean.com/community/
- **Support**: Available via Digital Ocean console

### Application Support
- **Health Dashboard**: `/app/analytics`
- **Database Health**: `npm run db:health`
- **Migration Status**: `npm run db:migrate`

## ✅ Deployment Complete

Once all items are checked:

- [ ] Application is successfully deployed
- [ ] All tests are passing
- [ ] Monitoring is configured
- [ ] Documentation is updated
- [ ] Team is notified of deployment

**🎉 Congratulations! Your Shopify Loyalty App is now live on Digital Ocean!**

---

**Deployment Date**: ___________  
**Deployed By**: ___________  
**App URL**: ___________  
**Database**: ___________  
**Version**: ___________
