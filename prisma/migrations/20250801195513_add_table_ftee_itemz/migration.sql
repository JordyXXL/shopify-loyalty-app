/*
  Warnings:

  - You are about to drop the column `E_Mail_Address` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `loyaltyEngageID` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `loyaltyEngageSecret` on the `session` table. All the data in the column will be lost.
  - You are about to drop the column `loyalty_Password` on the `session` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `session` DROP COLUMN `E_Mail_Address`,
    DROP COLUMN `loyaltyEngageID`,
    DROP COLUMN `loyaltyEngageSecret`,
    DROP COLUMN `loyalty_Password`;

-- CreateTable
CREATE TABLE `loyalty` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `loyaltyEngageID` VARCHAR(191) NULL,
    `loyaltyEngageSecret` VARCHAR(191) NULL,
    `E_Mail_Address` VARCHAR(191) NULL,
    `loyalty_Password` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
