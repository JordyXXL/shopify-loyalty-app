#!/bin/bash

# Shopify Loyalty App Deployment Script
# Usage: ./deploy.sh

set -e  # Exit on any error

echo "🚀 Starting Shopify Loyalty App deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_error "package.json not found. Please run this script from the project root directory."
    exit 1
fi

# Check if .env.production exists
if [ ! -f ".env.production" ]; then
    print_error ".env.production file not found. Please create it with your production settings."
    exit 1
fi

# Create logs directory if it doesn't exist
print_status "Creating logs directory..."
mkdir -p logs

# Pull latest code (if using git)
if [ -d ".git" ]; then
    print_status "Pulling latest code from git..."
    git pull origin main || print_warning "Git pull failed or not configured"
fi

# Install/update dependencies
print_status "Installing dependencies..."
npm ci --production

# Generate Prisma client
print_status "Generating Prisma client..."
npx prisma generate

# Run database migrations
print_status "Running database migrations..."
npx prisma db push

# Build the application
print_status "Building application..."
npm run build

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    print_warning "PM2 not found. Installing PM2 globally..."
    npm install -g pm2
fi

# Start or restart the application with PM2
print_status "Starting/restarting application with PM2..."
if pm2 list | grep -q "shopify-loyalty-app"; then
    print_status "Restarting existing PM2 process..."
    pm2 restart ecosystem.config.js
else
    print_status "Starting new PM2 process..."
    pm2 start ecosystem.config.js
fi

# Save PM2 configuration
pm2 save

# Setup PM2 startup script (run once)
print_status "Setting up PM2 startup script..."
pm2 startup || print_warning "PM2 startup setup failed - you may need to run this manually with sudo"

print_status "Deployment completed successfully! 🎉"
print_status "Application is running on port 3000"
print_status "Check status with: pm2 status"
print_status "View logs with: pm2 logs shopify-loyalty-app"

echo ""
echo "📋 Next steps:"
echo "1. Configure your domain DNS to point to this server"
echo "2. Set up SSL certificate with: sudo certbot --nginx -d your-domain.com"
echo "3. Configure Nginx reverse proxy"
echo "4. Set up cron jobs for queue processing"
echo "5. Test your application at https://your-domain.com"
