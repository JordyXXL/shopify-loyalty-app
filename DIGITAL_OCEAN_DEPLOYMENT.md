# Digital Ocean Deployment Guide - Shopify Loyalty App

This guide will walk you through deploying your Shopify Loyalty App to Digital Ocean using GitHub Actions for automated CI/CD.

## 🚀 Quick Overview

- **Platform**: Digital Ocean App Platform
- **CI/CD**: GitHub Actions
- **Database**: Digital Ocean Managed PostgreSQL
- **Container Registry**: Digital Ocean Container Registry
- **SSL**: Automatic Let's Encrypt certificates
- **Monitoring**: Built-in Digital Ocean monitoring + custom health checks

## 📋 Prerequisites

1. **Digital Ocean Account** with billing enabled
2. **GitHub Repository** with your code
3. **Domain Name** (optional, can use DO subdomain)
4. **Shopify Partner Account** with production app credentials

## 🛠 Step-by-Step Setup

### Step 1: Prepare Your GitHub Repository

1. **Push your code to GitHub**:
   ```bash
   git add .
   git commit -m "Add Digital Ocean deployment configuration"
   git push origin main
   ```

2. **Create a production branch**:
   ```bash
   git checkout -b production
   git push origin production
   ```

### Step 2: Set Up Digital Ocean

1. **Create Digital Ocean Account**
   - Go to https://cloud.digitalocean.com/
   - Sign up and add a payment method

2. **Generate Personal Access Token**
   - Go to API → Tokens/Keys
   - Generate New Token
   - Name: `GitHub Actions`
   - Scopes: Read & Write
   - Copy the token (you'll need it for GitHub)

3. **Create Container Registry**
   - Go to Container Registry
   - Create Registry
   - Name: `shopify-loyalty-app`
   - Region: Choose closest to your users

### Step 3: Configure GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add these secrets:

```
DIGITALOCEAN_ACCESS_TOKEN: your_do_personal_access_token
SHOPIFY_API_KEY: your_production_shopify_api_key
SHOPIFY_API_SECRET: your_production_shopify_api_secret
CRON_SECRET: generate_random_32_char_string
SESSION_SECRET: generate_random_32_char_string
APP_URL: https://your-domain.com (or will be provided by DO)
```

### Step 4: Create Digital Ocean App

1. **Using App Platform Console**:
   - Go to Apps → Create App
   - Choose "GitHub" as source
   - Select your repository
   - Choose `main` branch
   - Digital Ocean will detect the `.do/app.yaml` file

2. **Or using doctl CLI**:
   ```bash
   # Install doctl
   brew install doctl  # macOS
   # or download from https://github.com/digitalocean/doctl

   # Authenticate
   doctl auth init

   # Create app
   doctl apps create --spec .do/app.yaml
   ```

### Step 5: Configure Environment Variables

In Digital Ocean App Platform:

1. Go to your app → Settings → Environment Variables
2. Add the following variables:

```env
# Required
SHOPIFY_API_KEY=your_production_api_key
SHOPIFY_API_SECRET=your_production_api_secret
SHOPIFY_APP_URL=https://your-app-url.ondigitalocean.app
CRON_SECRET=your_secure_random_string
SESSION_SECRET=your_secure_session_secret

# Optional
LOG_LEVEL=info
NODE_ENV=production
```

### Step 6: Set Up Custom Domain (Optional)

1. **In Digital Ocean**:
   - Go to your app → Settings → Domains
   - Add your custom domain
   - Follow DNS configuration instructions

2. **Update DNS Records**:
   ```
   Type: CNAME
   Name: @
   Value: your-app.ondigitalocean.app
   ```

### Step 7: Deploy Your Application

1. **Automatic Deployment**:
   - Push to `main` branch → deploys to staging
   - Push to `production` branch → deploys to production

2. **Manual Deployment**:
   ```bash
   # Trigger deployment via GitHub Actions
   git push origin main
   
   # Or redeploy in Digital Ocean console
   # Go to your app → Deployments → Create Deployment
   ```

## 🔧 Configuration Details

### Database Configuration

Your app automatically gets a managed PostgreSQL database:
- **Version**: PostgreSQL 15
- **Size**: Basic plan (1GB RAM, 10GB storage)
- **Backups**: Automatic daily backups
- **Connection**: Automatically injected as `DATABASE_URL`

### Scaling Configuration

```yaml
# In .do/app.yaml
instance_count: 1        # Start with 1 instance
instance_size_slug: basic-xxs  # $5/month per instance

# Scale up for production:
instance_count: 2        # For high availability
instance_size_slug: basic-xs   # $12/month per instance
```

### Queue Processing

The app includes a worker process that handles:
- Queue processing every 5 minutes
- Background job execution
- Automatic retries and error handling

## 📊 Monitoring & Maintenance

### Built-in Monitoring

Digital Ocean provides:
- **Application Metrics**: CPU, Memory, Request count
- **Database Metrics**: Connections, Query performance
- **Alerts**: Automatic alerts for high resource usage
- **Logs**: Centralized application and system logs

### Health Checks

The app includes comprehensive health checks:
- **Endpoint**: `/health`
- **Checks**: Database connectivity, environment variables, memory usage
- **Frequency**: Every 30 seconds
- **Auto-restart**: If health checks fail

### Accessing Logs

```bash
# Using doctl
doctl apps logs your-app-id --type=run

# Or in Digital Ocean console
# Go to your app → Runtime Logs
```

## 💰 Cost Breakdown

### Staging Environment
- **App Platform**: $5/month (Basic)
- **Database**: $15/month (Basic)
- **Total**: ~$20/month

### Production Environment
- **App Platform**: $12/month (Pro) × 2 instances = $24/month
- **Database**: $25/month (1GB RAM)
- **Container Registry**: $5/month
- **Total**: ~$54/month

## 🔒 Security Features

### Automatic Security
- **SSL Certificates**: Automatic Let's Encrypt
- **DDoS Protection**: Built-in protection
- **Private Networking**: Database accessible only from app
- **Container Security**: Regular security updates

### Environment Security
- **Secrets Management**: Encrypted environment variables
- **Network Isolation**: Private container networking
- **Access Control**: Role-based access to resources

## 🚨 Troubleshooting

### Common Issues

1. **Build Failures**:
   ```bash
   # Check GitHub Actions logs
   # Go to your repo → Actions → Failed workflow
   
   # Common fixes:
   # - Ensure all secrets are set
   # - Check Dockerfile syntax
   # - Verify package.json scripts
   ```

2. **Database Connection Issues**:
   ```bash
   # Check if DATABASE_URL is properly set
   # Verify database is running in DO console
   # Check app logs for connection errors
   ```

3. **Health Check Failures**:
   ```bash
   # Check /health endpoint manually
   curl https://your-app.ondigitalocean.app/health
   
   # Review health check logs in DO console
   ```

### Performance Optimization

1. **Scale Up**:
   ```yaml
   # Update .do/app.yaml
   instance_count: 2
   instance_size_slug: basic-xs
   ```

2. **Database Optimization**:
   - Monitor query performance in DO console
   - Add database indexes for slow queries
   - Consider upgrading database plan

3. **Caching**:
   - Add Redis for session storage
   - Implement application-level caching
   - Use CDN for static assets

## 🔄 Updates & Maintenance

### Automatic Updates

- **Application**: Automatic deployment on git push
- **Dependencies**: Update via package.json and push
- **Database**: Automatic minor version updates
- **Security**: Automatic container security updates

### Manual Maintenance

```bash
# Update dependencies
npm update
git add package-lock.json
git commit -m "Update dependencies"
git push origin main

# Database maintenance
# Handled automatically by Digital Ocean

# Monitor resource usage
doctl apps list
doctl databases list
```

## 📞 Support & Resources

### Digital Ocean Resources
- **Documentation**: https://docs.digitalocean.com/products/app-platform/
- **Community**: https://www.digitalocean.com/community/
- **Support**: Available via DO console

### Application Support
- **Health Dashboard**: `/app/analytics`
- **Application Logs**: Available in DO console
- **Database Monitoring**: Built into DO dashboard

## 🎉 Go
