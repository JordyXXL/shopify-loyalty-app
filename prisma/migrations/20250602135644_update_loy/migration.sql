/*
  Warnings:

  - A unique constraint covering the columns `[E_Mail_Address]` on the table `Session` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `session` ADD COLUMN `E_Mail_Address` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Session_E_Mail_Address_key` ON `Session`(`E_Mail_Address`);
