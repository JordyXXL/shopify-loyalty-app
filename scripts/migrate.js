#!/usr/bin/env node

/**
 * Database Migration Script for Digital Ocean Deployment
 * This script handles database migrations and setup for production
 */

import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const prisma = new PrismaClient();

async function runMigrations() {
  console.log('🚀 Starting database migration...');
  
  try {
    // Test database connection
    console.log('📡 Testing database connection...');
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful');

    // Run Prisma migrations
    console.log('🔄 Running Prisma migrations...');
    execSync('npx prisma db push', { stdio: 'inherit' });
    console.log('✅ Database migrations completed');

    // Seed initial data if needed
    console.log('🌱 Checking for initial data...');
    
    // Check if we have any tenants
    const tenantCount = await prisma.tenant.count();
    console.log(`📊 Found ${tenantCount} existing tenants`);

    if (tenantCount === 0) {
      console.log('🌱 No tenants found, database is ready for first-time setup');
    }

    // Verify critical tables exist
    const tables = [
      'Session',
      'Tenant', 
      'ProfileQueue',
      'PurchaseQueue',
      'LoyaltyPage',
      'ApiLog',
      'FreeItem'
    ];

    for (const table of tables) {
      try {
        await prisma.$queryRawUnsafe(`SELECT COUNT(*) FROM "${table}" LIMIT 1`);
        console.log(`✅ Table ${table} exists and is accessible`);
      } catch (error) {
        console.error(`❌ Table ${table} is not accessible:`, error.message);
        throw error;
      }
    }

    console.log('🎉 Database migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Database migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

async function healthCheck() {
  console.log('🏥 Running database health check...');
  
  try {
    // Basic connection test
    await prisma.$queryRaw`SELECT NOW() as current_time`;
    
    // Check database version
    const result = await prisma.$queryRaw`SELECT version()`;
    console.log('📊 Database version:', result[0].version);
    
    // Check table counts
    const stats = {
      sessions: await prisma.session.count(),
      tenants: await prisma.tenant.count(),
      profileQueue: await prisma.profileQueue.count(),
      purchaseQueue: await prisma.purchaseQueue.count(),
      loyaltyPages: await prisma.loyaltyPage.count(),
      apiLogs: await prisma.apiLog.count(),
      freeItems: await prisma.freeItem.count(),
    };
    
    console.log('📈 Database statistics:', stats);
    console.log('✅ Database health check passed');
    
    return stats;
    
  } catch (error) {
    console.error('❌ Database health check failed:', error);
    throw error;
  }
}

async function cleanup() {
  console.log('🧹 Running database cleanup...');
  
  try {
    // Clean up old API logs (older than 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const deletedLogs = await prisma.apiLog.deleteMany({
      where: {
        createdAt: {
          lt: thirtyDaysAgo
        }
      }
    });
    
    console.log(`🗑️ Deleted ${deletedLogs.count} old API logs`);
    
    // Clean up completed queue items (older than 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const deletedProfileQueue = await prisma.profileQueue.deleteMany({
      where: {
        status: 'DONE',
        updatedAt: {
          lt: sevenDaysAgo
        }
      }
    });
    
    const deletedPurchaseQueue = await prisma.purchaseQueue.deleteMany({
      where: {
        status: 'DONE',
        updatedAt: {
          lt: sevenDaysAgo
        }
      }
    });
    
    console.log(`🗑️ Deleted ${deletedProfileQueue.count} completed profile queue items`);
    console.log(`🗑️ Deleted ${deletedPurchaseQueue.count} completed purchase queue items`);
    
    console.log('✅ Database cleanup completed');
    
  } catch (error) {
    console.error('❌ Database cleanup failed:', error);
    throw error;
  }
}

// Main execution
const command = process.argv[2];

switch (command) {
  case 'migrate':
    runMigrations();
    break;
  case 'health':
    healthCheck();
    break;
  case 'cleanup':
    cleanup();
    break;
  default:
    console.log('Usage: node migrate.js [migrate|health|cleanup]');
    console.log('');
    console.log('Commands:');
    console.log('  migrate  - Run database migrations');
    console.log('  health   - Check database health');
    console.log('  cleanup  - Clean up old data');
    process.exit(1);
}
