-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "credentialId" TEXT;

-- CreateTable
CREATE TABLE "connector_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "externalUserId" TEXT,
    "encryptedToken" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_credentials_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "connector_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
