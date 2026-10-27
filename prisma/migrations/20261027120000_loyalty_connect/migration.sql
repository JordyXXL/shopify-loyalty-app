-- Loyalty Connect: per-tenant settings (keys encrypted at rest) and the delivery queue.
-- Generated with: prisma migrate diff --from-schema-datamodel <schema before> --to-schema-datamodel prisma/schema.prisma --script

-- CreateTable
CREATE TABLE `LoyaltyConnectSettings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tenantId` INTEGER NOT NULL,
    `shopDomain` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `publicKeyEnc` TEXT NULL,
    `secretKeyEnc` TEXT NULL,
    `secretKeyHint` VARCHAR(191) NULL,
    `storefrontDomain` VARCHAR(191) NULL,
    `pixelStatus` VARCHAR(191) NULL,
    `pixelError` TEXT NULL,
    `pixelUpdatedAt` DATETIME(3) NULL,
    `lastTestAt` DATETIME(3) NULL,
    `lastTestOk` BOOLEAN NULL,
    `lastTestMessage` TEXT NULL,
    `lastDeliveryAt` DATETIME(3) NULL,
    `lastDeliveryStatus` TEXT NULL,
    `lastErrorAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LoyaltyConnectSettings_tenantId_key`(`tenantId`),
    INDEX `LoyaltyConnectSettings_shopDomain_idx`(`shopDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoyaltyConnectQueue` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tenantId` INTEGER NOT NULL,
    `kind` ENUM('ORDER', 'REFUND', 'ERASE') NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `payload` LONGTEXT NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedAt` DATETIME(3) NULL,
    `claimToken` VARCHAR(64) NULL,
    `result` VARCHAR(191) NULL,
    `lastHttpStatus` INTEGER NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LoyaltyConnectQueue_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `LoyaltyConnectQueue_tenantId_status_idx`(`tenantId`, `status`),
    INDEX `LoyaltyConnectQueue_claimToken_idx`(`claimToken`),
    UNIQUE INDEX `LoyaltyConnectQueue_tenantId_dedupeKey_key`(`tenantId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LoyaltyConnectSettings` ADD CONSTRAINT `LoyaltyConnectSettings_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoyaltyConnectQueue` ADD CONSTRAINT `LoyaltyConnectQueue_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `Tenant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

