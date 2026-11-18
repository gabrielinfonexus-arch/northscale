-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "demoAutoHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metaAppId" TEXT,
ADD COLUMN     "metaAppSecretEncrypted" TEXT,
ADD COLUMN     "metaLoginConfigId" TEXT;
