-- AlterTable
ALTER TABLE "ai_conversations" ADD COLUMN     "heavy" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ai_insights" ADD COLUMN     "model" TEXT,
ADD COLUMN     "noteId" TEXT,
ADD COLUMN     "periodFrom" DATE,
ADD COLUMN     "periodTo" DATE,
ADD COLUMN     "runId" TEXT;

-- AlterTable
ALTER TABLE "ai_messages" ADD COLUMN     "model" TEXT,
ADD COLUMN     "usage" JSONB;

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN     "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_clientId_createdAt_idx" ON "ai_usage"("clientId", "createdAt");

-- Read-only role for the AI's run_readonly_sql tool. No login, no table privileges:
-- the app creates per-request temporary views (already filtered to the clients the user may see),
-- grants SELECT on them to this role, switches to it inside a read-only transaction, and rolls back.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'northscale_ai_ro') THEN
    CREATE ROLE northscale_ai_ro NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT northscale_ai_ro TO CURRENT_USER;
