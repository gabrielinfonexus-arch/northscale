import "server-only";
import { prisma } from "@/lib/db";

/**
 * run_readonly_sql: last-resort SQL for the AI, read-only and limited to the clients the user may see.
 *
 * Each call runs in its own transaction that is always rolled back:
 *  1. as the app user, create TEMPORARY views (ai_*) that already filter to the allowed client ids;
 *  2. grant SELECT on them to `northscale_ai_ro` (no login, no table privileges) and switch to it;
 *  3. READ ONLY + statement_timeout, run ONE statement wrapped in a LIMIT;
 *  4. roll back (the temp views disappear).
 * Base tables are unreachable (permission denied). Only one SELECT/WITH statement is accepted, so the
 * role cannot be switched back between statements; a deny-list blocks role/config changes as a second layer.
 */

export const SAFE_VIEWS: { name: string; description: string; sql: (ids: string) => string }[] = [
  {
    name: "ai_clients",
    description: "id, slug, name, currency (reporting), timezone",
    sql: (ids) => `SELECT id, slug, name, currency, timezone FROM clients WHERE id IN (${ids})`,
  },
  {
    name: "ai_connections",
    description: "id, client_id, platform (META|GOOGLE|SHOPIFY|OTHER), name, currency, timezone, status",
    sql: (ids) =>
      `SELECT id, "clientId" AS client_id, platform::text, name, currency, timezone, status::text FROM connections WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_client_daily",
    description:
      "one row per client per day, reporting currency: ad_spend, meta_spend, google_spend, platform_revenue, platform_purchases, shopify_orders, gross_sales, discounts, refunds, shopify_net_sales, cogs, shipping, payment_fees, new_customers, returning_orders, new_customer_revenue, returning_customer_revenue, other_revenue, other_orders, total_revenue",
    sql: (ids) => `SELECT * FROM v_client_daily WHERE client_id IN (${ids})`,
  },
  {
    name: "ai_ad_daily",
    description:
      "account-level ads per connection per day, in the account currency (column currency): spend, purchase_value, results_value, impressions, reach, clicks, link_clicks, purchases, add_to_cart, initiate_checkout, leads, results, video_views_3s, thru_plays",
    sql: (ids) => `SELECT * FROM mv_ad_daily WHERE client_id IN (${ids})`,
  },
  {
    name: "ai_ad_insights",
    description:
      'per entity per day, account currency: client_id, connection_id, platform, date, level (ACCOUNT|CAMPAIGN|ADSET|AD|KEYWORD|SEARCH_TERM), entity_id, entity_name, campaign_id, campaign_name, adset_id, adset_name, attribution ("default" = the account setting), currency, spend, impressions, reach, clicks, link_clicks, purchases, purchase_value, add_to_cart, initiate_checkout, leads, results, results_value, video_views_3s, thru_plays, search_impr_share',
    sql: (
      ids,
    ) => `SELECT "clientId" AS client_id, "connectionId" AS connection_id, platform::text, date, level::text, "entityId" AS entity_id, "entityName" AS entity_name,
      "campaignId" AS campaign_id, "campaignName" AS campaign_name, "adsetId" AS adset_id, "adsetName" AS adset_name, attribution, currency, spend, impressions, reach, clicks,
      "linkClicks" AS link_clicks, purchases, "purchaseValue" AS purchase_value, "addToCart" AS add_to_cart, "initiateCheckout" AS initiate_checkout, leads, results,
      "resultsValue" AS results_value, "videoViews3s" AS video_views_3s, "thruPlays" AS thru_plays, "searchImprShare" AS search_impr_share
      FROM ad_insights_daily WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_ad_breakdowns",
    description:
      "breakdown_type (AGE|GENDER|PLACEMENT|COUNTRY|REGION|HOUR|DEVICE|AUDIENCE_TYPE), breakdown_value, plus the ai_ad_insights metric columns",
    sql: (
      ids,
    ) => `SELECT "clientId" AS client_id, "connectionId" AS connection_id, platform::text, date, level::text, "entityId" AS entity_id, "entityName" AS entity_name,
      "campaignId" AS campaign_id, "breakdownType"::text AS breakdown_type, "breakdownValue" AS breakdown_value, attribution, currency, spend, impressions, reach, clicks,
      "linkClicks" AS link_clicks, purchases, "purchaseValue" AS purchase_value, "addToCart" AS add_to_cart, "initiateCheckout" AS initiate_checkout, leads, results, "resultsValue" AS results_value
      FROM ad_insights_breakdown WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_ad_entities",
    description:
      "campaigns/ad sets/ads/keywords: connection_id, platform, level, external_id, name, campaign_external_id, adset_external_id, status, effective_status, objective, campaign_type, is_prospecting, review_feedback, landing_url, daily_budget",
    sql: (
      ids,
    ) => `SELECT "clientId" AS client_id, "connectionId" AS connection_id, platform::text, level::text, "externalId" AS external_id, name, "campaignExternalId" AS campaign_external_id,
      "adsetExternalId" AS adset_external_id, status, "effectiveStatus" AS effective_status, objective, "campaignType" AS campaign_type, "isProspecting" AS is_prospecting,
      "reviewFeedback" AS review_feedback, "landingUrl" AS landing_url, "dailyBudget" AS daily_budget FROM ad_entities WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_creatives",
    description: "ad_external_id, name, type, headline, body, landing_url",
    sql: (ids) =>
      `SELECT "clientId" AS client_id, "connectionId" AS connection_id, platform::text, "adExternalId" AS ad_external_id, name, type, headline, body, "landingUrl" AS landing_url FROM creatives WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_shopify_daily",
    description:
      "per store per day (reporting currency): orders, gross_sales, discounts, refunds, net_sales, shipping, taxes, cogs, payment_fees, new_customers, returning_orders, new_customer_revenue, returning_customer_revenue",
    sql: (ids) => `SELECT * FROM mv_shopify_daily WHERE client_id IN (${ids})`,
  },
  {
    name: "ai_shopify_orders",
    description:
      "orders (store currency): id, client_id, connection_id, name, date, currency, is_new_customer, financial_status, cancelled_at, gross_sales, discounts, shipping, taxes, total_price, refunded, cogs, payment_fees, discount_codes, first/last utm source/medium/campaign, channel_first_click, channel_last_click (META|GOOGLE|EMAIL|ORGANIC|DIRECT|OTHER). No customer personal data.",
    sql: (
      ids,
    ) => `SELECT id, "clientId" AS client_id, "connectionId" AS connection_id, name, date, currency, "isNewCustomer" AS is_new_customer, "financialStatus" AS financial_status,
      "cancelledAt" AS cancelled_at, "grossSales" AS gross_sales, discounts, shipping, taxes, "totalPrice" AS total_price, refunded, cogs, "paymentFees" AS payment_fees,
      "discountCodes" AS discount_codes, "firstUtmSource" AS first_utm_source, "firstUtmMedium" AS first_utm_medium, "firstUtmCampaign" AS first_utm_campaign,
      "lastUtmSource" AS last_utm_source, "lastUtmMedium" AS last_utm_medium, "lastUtmCampaign" AS last_utm_campaign, "channelFirstClick"::text AS channel_first_click,
      "channelLastClick"::text AS channel_last_click FROM shopify_orders WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_shopify_order_lines",
    description: "order_id, product_id, variant_id, sku, title, variant_title, quantity, price, discount, unit_cost",
    sql: (
      ids,
    ) => `SELECT l."orderId" AS order_id, l."productId" AS product_id, l."variantId" AS variant_id, l.sku, l.title, l."variantTitle" AS variant_title, l.quantity, l.price, l.discount, l."unitCost" AS unit_cost
      FROM shopify_order_lines l JOIN shopify_orders o ON o.id = l."orderId" WHERE o."clientId" IN (${ids})`,
  },
  {
    name: "ai_other_revenue",
    description: "client_id, date, source, revenue, orders, currency",
    sql: (ids) => `SELECT "clientId" AS client_id, date, source, revenue, orders, currency FROM other_revenue WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_targets",
    description:
      "monthly targets: client_id, month, platform (NULL = whole client), spend, revenue, mer, roas, cpa, ncac, orders, new_customers",
    sql: (ids) =>
      `SELECT "clientId" AS client_id, month, platform::text, spend, revenue, mer, roas, cpa, ncac, orders, "newCustomers" AS new_customers FROM targets WHERE "clientId" IN (${ids}) AND "connectionId" IS NULL`,
  },
  {
    name: "ai_chart_notes",
    description: "client_id, date, title, description, category",
    sql: (ids) => `SELECT "clientId" AS client_id, date, title, description, category::text FROM chart_notes WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_alerts",
    description: "Watchdog alerts: client_id, rule_key, severity, status, title, message, created_at, resolved_at",
    sql: (ids) =>
      `SELECT "clientId" AS client_id, "ruleKey" AS rule_key, severity::text, status::text, title, message, "createdAt" AS created_at, "resolvedAt" AS resolved_at FROM alerts WHERE "clientId" IN (${ids})`,
  },
  {
    name: "ai_fx_rates",
    description: "daily FX: date, base, quote, rate (1 base = rate quote)",
    sql: () => `SELECT date, base, quote, rate FROM fx_rates`,
  },
];

const DENY =
  /(\bset_config\b|\bpg_[a-z_]*\s*\(|\bdblink|\blo_[a-z]+\s*\(|\bcopy\b|\bu&|\bset\s+role\b|\breset\b|\bnotify\b|\blisten\b|\bcurrent_setting\b|\bpg_sleep\b|\bquery_to_xml|\bxpath)/i;

export function checkSql(query: string): { ok: true; sql: string } | { ok: false; error: string } {
  const sql = query.trim().replace(/;\s*$/, "");
  if (!sql) return { ok: false, error: "Empty query." };
  if (sql.length > 8000) return { ok: false, error: "Query too long (max 8000 characters)." };
  if (sql.includes(";")) return { ok: false, error: "Only one statement is allowed (no ';')." };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, error: "Only SELECT (or WITH … SELECT) queries are allowed." };
  if (/--|\/\*/.test(sql)) return { ok: false, error: "Comments are not allowed." };
  const bad = sql.match(DENY);
  if (bad) return { ok: false, error: `Not allowed in read-only analysis: ${bad[0].trim()}` };
  return { ok: true, sql };
}

class Rollback extends Error {
  constructor(public rows: Record<string, unknown>[]) {
    super("rollback");
  }
}

/** Run one read-only query over the ai_* views of the allowed clients. Returns at most `limit` rows. */
export async function runReadonlySql(
  clientIds: string[],
  query: string,
  limit = 200,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  const checked = checkSql(query);
  if (!checked.ok) throw new Error(checked.error);
  if (!clientIds.length) throw new Error("No clients in scope.");
  const ids = clientIds.map((id) => `'${id.replace(/[^a-z0-9_-]/gi, "")}'`).join(",");
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const v of SAFE_VIEWS) {
          await tx.$executeRawUnsafe(`CREATE TEMP VIEW ${v.name} AS ${v.sql(ids)}`);
          await tx.$executeRawUnsafe(`GRANT SELECT ON ${v.name} TO northscale_ai_ro`);
        }
        await tx.$executeRawUnsafe(`SET LOCAL ROLE northscale_ai_ro`);
        await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`);
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM (${checked.sql}) AS q LIMIT ${limit + 1}`);
        throw new Rollback(rows);
      },
      { timeout: 15_000 },
    );
  } catch (e) {
    if (e instanceof Rollback) {
      const truncated = e.rows.length > limit;
      const rows = e.rows.slice(0, limit);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { columns, rows: rows.map((r) => columns.map((c) => jsonSafe(r[c]))), truncated };
    }
    const msg = (e as Error).message ?? String(e);
    const pg = msg.match(/Message: `([^`]+)`/);
    throw new Error((pg ? pg[1] : msg.split("\n").filter(Boolean).pop() || "Query failed.").slice(0, 400));
  }
  throw new Error("unreachable");
}

function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 19 : 10);
  if (v && typeof v === "object" && "toNumber" in (v as object)) return (v as { toNumber(): number }).toNumber();
  return v;
}
