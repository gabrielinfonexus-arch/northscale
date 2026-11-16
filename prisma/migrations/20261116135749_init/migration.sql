-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('META', 'GOOGLE', 'SHOPIFY', 'OTHER_REVENUE');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'ANALYST', 'CLIENT_VIEWER');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('OK', 'SYNCING', 'ERROR', 'TOKEN_EXPIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "EntityLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'ADSET', 'AD', 'KEYWORD', 'SEARCH_TERM');

-- CreateEnum
CREATE TYPE "BreakdownType" AS ENUM ('AGE', 'GENDER', 'PLACEMENT', 'COUNTRY', 'REGION', 'HOUR', 'DEVICE', 'AUDIENCE_TYPE');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncJobKind" AS ENUM ('BACKFILL', 'INCREMENTAL', 'RESYNC_RANGE', 'BREAKDOWNS', 'CREATIVES', 'WEBHOOK', 'RECONCILE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'RESOLVED', 'MUTED');

-- CreateEnum
CREATE TYPE "NoteCategory" AS ENUM ('OFFER_LAUNCH', 'NEW_CREATIVE', 'BUDGET_CHANGE', 'PROMOTION', 'TRACKING_ISSUE', 'SITE_CHANGE', 'SEASONALITY', 'OTHER');

-- CreateEnum
CREATE TYPE "CostType" AS ENUM ('FIXED_MONTHLY', 'VARIABLE_PER_ORDER', 'VARIABLE_PCT_REVENUE');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_settings" (
    "organizationId" TEXT NOT NULL,
    "demoData" BOOLEAN NOT NULL DEFAULT true,
    "comparisonThresholdPct" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "plan" TEXT NOT NULL DEFAULT 'internal',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_settings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "allowedPages" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "client_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "allowedPages" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "defaultMarginPct" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "paymentFeePct" DOUBLE PRECISION NOT NULL DEFAULT 2.9,
    "shippingCostPerOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "newAudienceMinPct" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "webhookKeyHash" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'OK',
    "encryptedToken" TEXT,
    "encryptedRefresh" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "loginCustomerId" TEXT,
    "meta" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "backfillFrom" DATE,
    "backfillProgress" DOUBLE PRECISION,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "date" DATE NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("date","base","quote")
);

-- CreateTable
CREATE TABLE "ad_entities" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "level" "EntityLevel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignExternalId" TEXT,
    "adsetExternalId" TEXT,
    "status" TEXT,
    "effectiveStatus" TEXT,
    "objective" TEXT,
    "campaignType" TEXT,
    "isProspecting" BOOLEAN,
    "reviewFeedback" TEXT,
    "landingUrl" TEXT,
    "creativeId" TEXT,
    "dailyBudget" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "adExternalId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "headline" TEXT,
    "body" TEXT,
    "landingUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_daily" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "date" DATE NOT NULL,
    "level" "EntityLevel" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "adsetId" TEXT,
    "adsetName" TEXT,
    "adId" TEXT,
    "attribution" TEXT NOT NULL DEFAULT 'default',
    "currency" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER,
    "purchases" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchaseValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "addToCart" DOUBLE PRECISION,
    "initiateCheckout" DOUBLE PRECISION,
    "leads" DOUBLE PRECISION,
    "completeRegistration" DOUBLE PRECISION,
    "viewContent" DOUBLE PRECISION,
    "results" DOUBLE PRECISION,
    "resultsValue" DOUBLE PRECISION,
    "allConversions" DOUBLE PRECISION,
    "viewThroughConv" DOUBLE PRECISION,
    "videoViews3s" DOUBLE PRECISION,
    "thruPlays" DOUBLE PRECISION,
    "searchImprShare" DOUBLE PRECISION,
    "extra" JSONB,

    CONSTRAINT "ad_insights_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_insights_breakdown" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "date" DATE NOT NULL,
    "level" "EntityLevel" NOT NULL DEFAULT 'CAMPAIGN',
    "entityId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "campaignId" TEXT,
    "breakdownType" "BreakdownType" NOT NULL,
    "breakdownValue" TEXT NOT NULL,
    "attribution" TEXT NOT NULL DEFAULT 'default',
    "currency" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER,
    "purchases" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "purchaseValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "addToCart" DOUBLE PRECISION,
    "initiateCheckout" DOUBLE PRECISION,
    "leads" DOUBLE PRECISION,
    "results" DOUBLE PRECISION,
    "resultsValue" DOUBLE PRECISION,

    CONSTRAINT "ad_insights_breakdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_orders" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "customerExternalId" TEXT,
    "isNewCustomer" BOOLEAN NOT NULL,
    "financialStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "grossSales" DOUBLE PRECISION NOT NULL,
    "discounts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shipping" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "refunded" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cogs" DOUBLE PRECISION,
    "paymentFees" DOUBLE PRECISION,
    "discountCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceName" TEXT,
    "landingSite" TEXT,
    "referringSite" TEXT,
    "firstUtmSource" TEXT,
    "firstUtmMedium" TEXT,
    "firstUtmCampaign" TEXT,
    "lastUtmSource" TEXT,
    "lastUtmMedium" TEXT,
    "lastUtmCampaign" TEXT,
    "channelFirstClick" TEXT,
    "channelLastClick" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopify_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION,

    CONSTRAINT "shopify_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_refunds" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "shopify_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_costs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "title" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "product_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_revenue" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT,
    "date" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "revenue" DOUBLE PRECISION NOT NULL,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "other_revenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "platform" "Platform",
    "connectionId" TEXT,
    "spend" DOUBLE PRECISION,
    "revenue" DOUBLE PRECISION,
    "mer" DOUBLE PRECISION,
    "roas" DOUBLE PRECISION,
    "cpa" DOUBLE PRECISION,
    "ncac" DOUBLE PRECISION,
    "orders" DOUBLE PRECISION,
    "newCustomers" DOUBLE PRECISION,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chart_notes" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "NoteCategory" NOT NULL DEFAULT 'OTHER',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_items" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CostType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "startDate" DATE,
    "endDate" DATE,

    CONSTRAINT "cost_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" "SyncJobKind" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "rangeFrom" DATE,
    "rangeTo" DATE,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "rateLimitPct" DOUBLE PRECISION,
    "progress" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "params" JSONB NOT NULL,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
    "notifySlack" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityId" TEXT,
    "dataLink" TEXT,
    "fingerprint" TEXT NOT NULL,
    "mutedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_insights" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "whatChanged" TEXT NOT NULL,
    "likelyCause" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "dataLink" TEXT,
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "userId" TEXT,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_organizationId_key" ON "memberships"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "client_access_userId_clientId_key" ON "client_access"("userId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_tokenHash_key" ON "share_links"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key_key" ON "user_preferences"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "clients_slug_key" ON "clients"("slug");

-- CreateIndex
CREATE INDEX "connections_platform_status_idx" ON "connections"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "connections_clientId_platform_externalId_key" ON "connections"("clientId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "ad_entities_clientId_platform_level_idx" ON "ad_entities"("clientId", "platform", "level");

-- CreateIndex
CREATE UNIQUE INDEX "ad_entities_connectionId_level_externalId_key" ON "ad_entities"("connectionId", "level", "externalId");

-- CreateIndex
CREATE INDEX "creatives_clientId_idx" ON "creatives"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "creatives_connectionId_adExternalId_key" ON "creatives"("connectionId", "adExternalId");

-- CreateIndex
CREATE INDEX "ad_insights_daily_clientId_date_level_idx" ON "ad_insights_daily"("clientId", "date", "level");

-- CreateIndex
CREATE INDEX "ad_insights_daily_clientId_platform_level_date_idx" ON "ad_insights_daily"("clientId", "platform", "level", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_daily_connectionId_date_level_entityId_attribut_key" ON "ad_insights_daily"("connectionId", "date", "level", "entityId", "attribution");

-- CreateIndex
CREATE INDEX "ad_insights_breakdown_clientId_breakdownType_date_idx" ON "ad_insights_breakdown"("clientId", "breakdownType", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_insights_breakdown_connectionId_date_level_entityId_brea_key" ON "ad_insights_breakdown"("connectionId", "date", "level", "entityId", "breakdownType", "breakdownValue", "attribution");

-- CreateIndex
CREATE INDEX "shopify_orders_clientId_date_idx" ON "shopify_orders"("clientId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_orders_connectionId_externalId_key" ON "shopify_orders"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "shopify_order_lines_orderId_idx" ON "shopify_order_lines"("orderId");

-- CreateIndex
CREATE INDEX "shopify_order_lines_productId_idx" ON "shopify_order_lines"("productId");

-- CreateIndex
CREATE INDEX "shopify_refunds_clientId_date_idx" ON "shopify_refunds"("clientId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_refunds_orderId_externalId_key" ON "shopify_refunds"("orderId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "product_costs_clientId_productId_variantId_key" ON "product_costs"("clientId", "productId", "variantId");

-- CreateIndex
CREATE INDEX "other_revenue_clientId_date_idx" ON "other_revenue"("clientId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "other_revenue_clientId_date_source_key" ON "other_revenue"("clientId", "date", "source");

-- CreateIndex
CREATE UNIQUE INDEX "targets_clientId_month_platform_connectionId_key" ON "targets"("clientId", "month", "platform", "connectionId");

-- CreateIndex
CREATE INDEX "chart_notes_clientId_date_idx" ON "chart_notes"("clientId", "date");

-- CreateIndex
CREATE INDEX "sync_jobs_connectionId_createdAt_idx" ON "sync_jobs"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "sync_jobs_status_createdAt_idx" ON "sync_jobs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_clientId_ruleKey_key" ON "alert_rules"("clientId", "ruleKey");

-- CreateIndex
CREATE INDEX "alerts_clientId_status_createdAt_idx" ON "alerts"("clientId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_clientId_fingerprint_key" ON "alerts"("clientId", "fingerprint");

-- CreateIndex
CREATE INDEX "ai_insights_clientId_createdAt_idx" ON "ai_insights"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");

-- AddForeignKey
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_access" ADD CONSTRAINT "client_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_access" ADD CONSTRAINT "client_access_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_order_lines" ADD CONSTRAINT "shopify_order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "shopify_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopify_refunds" ADD CONSTRAINT "shopify_refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "shopify_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_revenue" ADD CONSTRAINT "other_revenue_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_notes" ADD CONSTRAINT "chart_notes_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
