/*
  Warnings:

  - You are about to drop the `loyalty` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[loyaltyEngageID]` on the table `Session` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[loyaltyEngageSecret]` on the table `Session` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `session` ADD COLUMN `loyaltyEngageID` VARCHAR(191) NULL,
    ADD COLUMN `loyaltyEngageSecret` VARCHAR(191) NULL;

-- DropTable
DROP TABLE `loyalty`;

-- CreateIndex
CREATE UNIQUE INDEX `Session_loyaltyEngageID_key` ON `Session`(`loyaltyEngageID`);

-- CreateIndex
CREATE UNIQUE INDEX `Session_loyaltyEngageSecret_key` ON `Session`(`loyaltyEngageSecret`);
