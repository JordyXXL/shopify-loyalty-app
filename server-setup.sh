#!/bin/bash

# Hetzner Server Setup Script for Shopify Loyalty App
# Run this script on a fresh Ubuntu 22.04 server
# Usage: curl -sSL https://your-repo.com/server-setup.sh | bash

set -e

echo "🚀 Setting up Hetzner server for Shopify Loyalty App..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root. Please run as a regular user with sudo privileges."
   exit 1
fi

# Update system
print_header "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install essential packages
print_header "Installing essential packages..."
sudo apt install -y curl wget git unzip software-properties-common apt-transport-https ca-certificates gnupg lsb-release ufw fail2ban

# Configure firewall
print_header "Configuring UFW firewall..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# Install Node.js 18.x
print_header "Installing Node.js 18.x..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js installation
node_version=$(node --version)
npm_version=$(npm --version)
print_status "Node.js version: $node_version"
print_status "npm version: $npm_version"

# Install PM2 globally
print_header "Installing PM2 process manager..."
sudo npm install -g pm2

# Install PostgreSQL 15
print_header "Installing PostgreSQL 15..."
sudo apt install -y postgresql postgresql-contrib

# Start and enable PostgreSQL
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Install Nginx
print_header "Installing Nginx..."
sudo apt install -y nginx

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Install Certbot for SSL certificates
print_header "Installing Certbot for SSL certificates..."
sudo apt install -y certbot python3-certbot-nginx

# Configure PostgreSQL
print_header "Configuring PostgreSQL..."
sudo -u postgres psql -c "CREATE USER loyalty_user WITH PASSWORD 'CHANGE_THIS_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE loyalty_app_prod OWNER loyalty_user;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE loyalty_app_prod TO loyalty_user;"

print_status "PostgreSQL configured with database 'loyalty_app_prod' and user 'loyalty_user'"

# Create application directory
print_header "Creating application directory..."
mkdir -p ~/shopify-loyalty-app
cd ~/shopify-loyalty-app

# Create logs directory
mkdir -p logs

# Set up log rotation
print_header "Setting up log rotation..."
sudo tee /etc/logrotate.d/shopify-loyalty > /dev/null <<EOF
/home/$USER/shopify-loyalty-app/logs/*.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 644 $USER $USER
    postrotate
        pm2 reloadLogs
    endscript
}
EOF

# Configure fail2ban
print_header "Configuring fail2ban..."
sudo tee /etc/fail2ban/jail.local > /dev/null <<EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
logpath = /var/log/auth.log
maxretry = 3

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10
EOF

sudo systemctl restart fail2ban

# Create swap file (if not exists)
print_header "Setting up swap file..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    print_status "2GB swap file created"
else
    print_status "Swap file already exists"
fi

# Optimize system settings
print_header "Optimizing system settings..."
sudo tee -a /etc/sysctl.conf > /dev/null <<EOF

# Shopify Loyalty App optimizations
vm.swappiness=10
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 12582912 16777216
net.ipv4.tcp_wmem = 4096 12582912 16777216
net.core.netdev_max_backlog = 5000
EOF

sudo sysctl -p

# Set up basic Nginx configuration
print_header "Setting up basic Nginx configuration..."
sudo tee /etc/nginx/sites-available/default > /dev/null <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    
    root /var/www/html;
    index index.html index.htm index.nginx-debian.html;
    
    server_name _;
    
    location / {
        return 200 'Server is ready for Shopify Loyalty App deployment!';
        add_header Content-Type text/plain;
    }
}
EOF

sudo nginx -t && sudo systemctl reload nginx

# Create deployment user and SSH setup
print_header "Setting up deployment configuration..."

# Generate SSH key for GitHub (optional)
if [ ! -f ~/.ssh/id_rsa ]; then
    print_status "Generating SSH key for Git repositories..."
    ssh-keygen -t rsa -b 4096 -C "deployment@$(hostname)" -f ~/.ssh/id_rsa -N ""
    print_warning "Add this public key to your Git repository:"
    cat ~/.ssh/id_rsa.pub
fi

# Set up PM2 startup
print_header "Configuring PM2 startup..."
pm2 startup | grep -E '^sudo' | bash || print_warning "PM2 startup configuration may need manual setup"

# Create environment file template
print_header "Creating environment configuration..."
tee ~/shopify-loyalty-app/.env.production.example > /dev/null <<EOF
# Production Environment Configuration
NODE_ENV=production

# Database Configuration
DATABASE_URL=postgresql://loyalty_user:CHANGE_THIS_PASSWORD@localhost:5432/loyalty_app_prod

# Shopify App Configuration
SHOPIFY_API_KEY=your_production_api_key_here
SHOPIFY_API_SECRET=your_production_api_secret_here
SHOPIFY_APP_URL=https://your-domain.com
SHOPIFY_SCOPES=read_products,write_products,read_customers,write_customers,read_orders,write_orders,read_discounts,write_discounts,read_themes,write_themes

# Security
CRON_SECRET=$(openssl rand -base64 32)

# Application Settings
PORT=3000

# Session Configuration
SHOPIFY_APP_SESSION_SECRET=$(openssl rand -base64 32)

# Logging
LOG_LEVEL=info
EOF

print_status "Environment template created at ~/shopify-loyalty-app/.env.production.example"

# Final instructions
print_header "Server setup completed! 🎉"
echo ""
echo "📋 Next steps:"
echo "1. Point your domain DNS to this server's IP address"
echo "2. Clone your application repository to ~/shopify-loyalty-app/"
echo "3. Copy .env.production.example to .env.production and configure it"
echo "4. Run your deployment script: ./deploy.sh"
echo "5. Set up SSL certificate: sudo certbot --nginx -d your-domain.com"
echo "6. Configure Nginx with your domain using the nginx.conf.template"
echo ""
echo "🔧 Server Information:"
echo "- Node.js: $(node --version)"
echo "- npm: $(npm --version)"
echo "- PostgreSQL: $(sudo -u postgres psql -c 'SELECT version();' | head -3 | tail -1)"
echo "- Nginx: $(nginx -v 2>&1)"
echo "- PM2: $(pm2 --version)"
echo ""
echo "📊 System Status:"
echo "- UFW Firewall: $(sudo ufw status | head -1)"
echo "- PostgreSQL: $(sudo systemctl is-active postgresql)"
echo "- Nginx: $(sudo systemctl is-active nginx)"
echo "- Fail2ban: $(sudo systemctl is-active fail2ban)"
echo ""
echo "🔑 Database Credentials:"
echo "- Database: loyalty_app_prod"
echo "- User: loyalty_user"
echo "- Password: CHANGE_THIS_PASSWORD (update in .env.production)"
echo ""
print_warning "Remember to:"
print_warning "1. Change the default PostgreSQL password"
print_warning "2. Configure your .env.production file"
print_warning "3. Set up SSL certificates"
print_warning "4. Configure domain-specific Nginx settings"
