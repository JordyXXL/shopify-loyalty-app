# Hetzner Deployment Guide - Shopify Loyalty App

This guide will walk you through deploying your optimized Shopify Loyalty App to Hetzner Cloud hosting.

## 📋 Prerequisites

- Hetzner Cloud account
- Domain name (pointed to your server)
- Shopify Partner account with production app credentials
- LoyaltyEngage API credentials

## 🚀 Step-by-Step Deployment

### Step 1: Create Hetzner Cloud Server

1. **Log into Hetzner Cloud Console**
   - Go to https://console.hetzner.cloud/
   - Create a new project

2. **Create Server**
   - **Image**: Ubuntu 22.04
   - **Type**: CX41 (4 vCPU, 16GB RAM) - Recommended
   - **Location**: Choose closest to your users
   - **SSH Key**: Add your SSH public key
   - **Name**: shopify-loyalty-app

3. **Note the Server IP**
   - Copy the public IP address for DNS configuration

### Step 2: Configure DNS

Point your domain to the server:
```
A Record: your-domain.com → YOUR_SERVER_IP
A Record: www.your-domain.com → YOUR_SERVER_IP
```

### Step 3: Initial Server Setup

1. **SSH into your server**
   ```bash
   ssh root@YOUR_SERVER_IP
   ```

2. **Create a non-root user**
   ```bash
   adduser deploy
   usermod -aG sudo deploy
   su - deploy
   ```

3. **Run the server setup script**
   ```bash
   curl -sSL https://raw.githubusercontent.com/your-repo/shopify-loyalty-app/main/server-setup.sh | bash
   ```

   Or manually upload and run:
   ```bash
   # Upload server-setup.sh to the server
   chmod +x server-setup.sh
   ./server-setup.sh
   ```

### Step 4: Deploy Your Application

1. **Clone your repository**
   ```bash
   cd ~/shopify-loyalty-app
   git clone https://github.com/your-username/shopify-loyalty-app.git .
   ```

2. **Configure environment variables**
   ```bash
   cp .env.production.example .env.production
   nano .env.production
   ```

   Update the following values:
   ```env
   DATABASE_URL=postgresql://loyalty_user:YOUR_SECURE_PASSWORD@localhost:5432/loyalty_app_prod
   SHOPIFY_API_KEY=your_production_api_key
   SHOPIFY_API_SECRET=your_production_api_secret
   SHOPIFY_APP_URL=https://your-domain.com
   CRON_SECRET=your_secure_random_string
   SHOPIFY_APP_SESSION_SECRET=your_secure_session_secret
   ```

3. **Update database password**
   ```bash
   sudo -u postgres psql
   ALTER USER loyalty_user PASSWORD 'YOUR_SECURE_PASSWORD';
   \q
   ```

4. **Run deployment script**
   ```bash
   ./deploy.sh
   ```

### Step 5: Configure SSL Certificate

```bash
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### Step 6: Configure Nginx

1. **Create Nginx configuration**
   ```bash
   sudo cp nginx.conf.template /etc/nginx/sites-available/shopify-loyalty
   sudo sed -i 's/YOUR_DOMAIN/your-domain.com/g' /etc/nginx/sites-available/shopify-loyalty
   ```

2. **Enable the site**
   ```bash
   sudo ln -s /etc/nginx/sites-available/shopify-loyalty /etc/nginx/sites-enabled/
   sudo rm /etc/nginx/sites-enabled/default
   sudo nginx -t
   sudo systemctl reload nginx
   ```

### Step 7: Set Up Cron Jobs

1. **Configure cron jobs**
   ```bash
   # Edit crontab.txt with your actual domain and cron secret
   sed -i 's/YOUR_CRON_SECRET/your_actual_cron_secret/g' crontab.txt
   sed -i 's/your-domain.com/your-actual-domain.com/g' crontab.txt
   
   # Install cron jobs
   npm run cron:install
   ```

2. **Create backup directory**
   ```bash
   mkdir -p ~/backups
   ```

### Step 8: Test Your Deployment

1. **Check application status**
   ```bash
   npm run pm2:status
   npm run health:check
   ```

2. **View logs**
   ```bash
   npm run pm2:logs
   npm run logs:view
   ```

3. **Test in browser**
   - Visit https://your-domain.com
   - Install the app on a development store
   - Test all functionality

## 🔧 Post-Deployment Configuration

### Configure Shopify App Settings

1. **Update App URLs in Partner Dashboard**
   - App URL: `https://your-domain.com`
   - Allowed redirection URLs: `https://your-domain.com/auth/callback`

2. **Configure Webhooks**
   - Orders/Create: `https://your-domain.com/webhooks`
   - Customers/Create: `https://your-domain.com/webhooks`

### Set Up Multi-Tenant Configuration

1. **Access Admin Dashboard**
   - Go to `https://your-domain.com/app/tenants`
   - Add your first tenant with LoyaltyEngage credentials

2. **Inject Loyalty Page**
   - Go to `https://your-domain.com/app/loyalty-pages`
   - Select tenant and theme
   - Click "Inject Loyalty Page"

## 📊 Monitoring & Maintenance

### Available Commands

```bash
# Application Management
npm run pm2:status          # Check PM2 status
npm run pm2:restart         # Restart application
npm run pm2:logs           # View application logs

# Database Management
npm run db:backup          # Create database backup
npm run db:restore backup.sql.gz  # Restore from backup

# Log Management
npm run logs:view          # View combined logs
npm run logs:error         # View error logs

# Health Checks
npm run health:check       # Check application health

# Cron Management
npm run cron:list          # List installed cron jobs
```

### Monitoring Dashboard

Access your analytics dashboard at:
- `https://your-domain.com/app/analytics`

Monitor:
- API success rates
- Queue health
- Performance metrics
- Error tracking

### Log Locations

- Application logs: `~/shopify-loyalty-app/logs/`
- Nginx logs: `/var/log/nginx/`
- System logs: `/var/log/`
- Cron logs: `/var/log/loyalty-cron.log`

## 🔒 Security Checklist

- [ ] SSL certificate installed and auto-renewal configured
- [ ] Firewall configured (UFW enabled)
- [ ] Fail2ban configured for intrusion prevention
- [ ] Strong database passwords set
- [ ] Environment variables secured
- [ ] Regular security updates scheduled
- [ ] Backup strategy implemented

## 🚨 Troubleshooting

### Common Issues

1. **Application won't start**
   ```bash
   npm run pm2:logs
   # Check for missing environment variables or database connection issues
   ```

2. **Database connection errors**
   ```bash
   sudo systemctl status postgresql
   # Verify DATABASE_URL in .env.production
   ```

3. **Nginx configuration errors**
   ```bash
   sudo nginx -t
   sudo systemctl status nginx
   ```

4. **SSL certificate issues**
   ```bash
   sudo certbot certificates
   sudo certbot renew --dry-run
   ```

### Performance Optimization

1. **Monitor resource usage**
   ```bash
   htop
   df -h
   free -h
   ```

2. **Optimize PM2 settings**
   - Adjust `max_memory_restart` in `ecosystem.config.js`
   - Monitor memory usage and restart frequency

3. **Database optimization**
   ```bash
   # Monitor database performance
   sudo -u postgres psql loyalty_app_prod -c "SELECT * FROM pg_stat_activity;"
   ```

## 📞 Support

For deployment issues:

1. Check the analytics dashboard for system health
2. Review application and system logs
3. Verify all configuration files
4. Test individual components (database, nginx, PM2)

## 🔄 Updates & Maintenance

### Regular Maintenance Tasks

1. **Weekly**
   - Review analytics dashboard
   - Check log files for errors
   - Monitor disk space usage

2. **Monthly**
   - Update system packages: `sudo apt update && sudo apt upgrade`
   - Review and clean old backups
   - Check SSL certificate expiration

3. **Quarterly**
   - Update Node.js and npm packages
   - Review security configurations
   - Performance optimization review

### Updating Your Application

```bash
cd ~/shopify-loyalty-app
git pull origin main
./deploy.sh
```

---

**🎉 Congratulations!** Your Shopify Loyalty App is now deployed on Hetzner Cloud with enterprise-grade reliability, security, and monitoring.
