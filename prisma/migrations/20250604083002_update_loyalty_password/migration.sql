/*
  Warnings:

  - A unique constraint covering the columns `[loyalty_Password]` on the table `Session` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `session` ADD COLUMN `loyalty_Password` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Session_loyalty_Password_key` ON `Session`(`loyalty_Password`);
