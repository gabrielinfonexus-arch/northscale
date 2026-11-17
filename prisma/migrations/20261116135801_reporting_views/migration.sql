-- Reporting layer. Every UI screen and the AI read these views.
-- All money columns ending in nothing special are already converted to the
-- client's reporting currency using the latest fx rate on/before the date.

-- FX factor helper: rate from `base` to `quote` effective on `d`.
CREATE OR REPLACE FUNCTION fx_factor(p_base text, p_quote text, p_d date)
RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_base = p_quote THEN 1.0 ELSE COALESCE(
    (SELECT r.rate FROM public.fx_rates r WHERE r.base = p_base AND r.quote = p_quote AND r.date <= p_d ORDER BY r.date DESC LIMIT 1),
    (SELECT 1.0 / r.rate FROM public.fx_rates r WHERE r.base = p_quote AND r.quote = p_base AND r.date <= p_d ORDER BY r.date DESC LIMIT 1),
    1.0) END
$$;

-- ── Ad platforms: account level per day (default attribution) ──
CREATE MATERIALIZED VIEW mv_ad_daily AS
SELECT
  a."clientId"      AS client_id,
  a."connectionId"  AS connection_id,
  a.platform::text  AS platform,
  a.date            AS date,
  c.currency        AS currency,
  SUM(a.spend * f.fx)          AS spend,
  SUM(a."purchaseValue" * f.fx) AS purchase_value,
  SUM(COALESCE(a."resultsValue", a."purchaseValue") * f.fx) AS results_value,
  SUM(a.impressions)::bigint   AS impressions,
  SUM(COALESCE(a.reach, 0))::bigint AS reach,
  SUM(a.clicks)::bigint        AS clicks,
  SUM(COALESCE(a."linkClicks", a.clicks))::bigint AS link_clicks,
  SUM(a.purchases)             AS purchases,
  SUM(COALESCE(a."addToCart", 0))        AS add_to_cart,
  SUM(COALESCE(a."initiateCheckout", 0)) AS initiate_checkout,
  SUM(COALESCE(a.leads, 0))    AS leads,
  SUM(COALESCE(a.results, a.purchases)) AS results,
  SUM(COALESCE(a."videoViews3s", 0)) AS video_views_3s,
  SUM(COALESCE(a."thruPlays", 0))    AS thru_plays
FROM ad_insights_daily a
JOIN clients c ON c.id = a."clientId"
CROSS JOIN LATERAL (SELECT fx_factor(a.currency, c.currency, a.date) AS fx) f
WHERE a.level = 'ACCOUNT' AND a.attribution = 'default'
GROUP BY 1, 2, 3, 4, 5;

CREATE UNIQUE INDEX mv_ad_daily_pk ON mv_ad_daily (connection_id, date);
CREATE INDEX mv_ad_daily_client ON mv_ad_daily (client_id, date);

-- ── Shopify: per store per day (orders on order date, refunds on refund date) ──
CREATE MATERIALIZED VIEW mv_shopify_daily AS
WITH o AS (
  SELECT
    so."clientId" AS client_id, so."connectionId" AS connection_id, so.date,
    fx_factor(so.currency, c.currency, so.date) AS fx, c.currency,
    so."grossSales", so.discounts, so.shipping, so.taxes, so.cogs, so."paymentFees", so."isNewCustomer"
  FROM shopify_orders so JOIN clients c ON c.id = so."clientId"
  WHERE so."cancelledAt" IS NULL
),
orders_agg AS (
  SELECT client_id, connection_id, date, currency,
    COUNT(*)                                        AS orders,
    SUM("grossSales" * fx)                          AS gross_sales,
    SUM(discounts * fx)                             AS discounts,
    SUM(shipping * fx)                              AS shipping,
    SUM(taxes * fx)                                 AS taxes,
    SUM(COALESCE(cogs, 0) * fx)                     AS cogs,
    COUNT(*) FILTER (WHERE cogs IS NULL)            AS orders_without_cogs,
    SUM(COALESCE("paymentFees", 0) * fx)            AS payment_fees,
    COUNT(*) FILTER (WHERE "isNewCustomer")         AS new_customers,
    COUNT(*) FILTER (WHERE NOT "isNewCustomer")     AS returning_orders,
    SUM(("grossSales" - discounts) * fx) FILTER (WHERE "isNewCustomer")     AS new_customer_revenue,
    SUM(("grossSales" - discounts) * fx) FILTER (WHERE NOT "isNewCustomer") AS returning_customer_revenue
  FROM o GROUP BY 1, 2, 3, 4
),
refunds_agg AS (
  SELECT r."clientId" AS client_id, so."connectionId" AS connection_id, r.date, c.currency,
    SUM(r.amount * fx_factor(r.currency, c.currency, r.date)) AS refunds
  FROM shopify_refunds r
  JOIN shopify_orders so ON so.id = r."orderId"
  JOIN clients c ON c.id = r."clientId"
  GROUP BY 1, 2, 3, 4
)
SELECT
  COALESCE(oa.client_id, ra.client_id)         AS client_id,
  COALESCE(oa.connection_id, ra.connection_id) AS connection_id,
  COALESCE(oa.date, ra.date)                   AS date,
  COALESCE(oa.currency, ra.currency)           AS currency,
  COALESCE(oa.orders, 0)::bigint               AS orders,
  COALESCE(oa.gross_sales, 0)                  AS gross_sales,
  COALESCE(oa.discounts, 0)                    AS discounts,
  COALESCE(ra.refunds, 0)                      AS refunds,
  COALESCE(oa.gross_sales, 0) - COALESCE(oa.discounts, 0) - COALESCE(ra.refunds, 0) AS net_sales,
  COALESCE(oa.shipping, 0)                     AS shipping,
  COALESCE(oa.taxes, 0)                        AS taxes,
  COALESCE(oa.cogs, 0)                         AS cogs,
  COALESCE(oa.orders_without_cogs, 0)::bigint  AS orders_without_cogs,
  COALESCE(oa.payment_fees, 0)                 AS payment_fees,
  COALESCE(oa.new_customers, 0)::bigint        AS new_customers,
  COALESCE(oa.returning_orders, 0)::bigint     AS returning_orders,
  COALESCE(oa.new_customer_revenue, 0)         AS new_customer_revenue,
  COALESCE(oa.returning_customer_revenue, 0)   AS returning_customer_revenue
FROM orders_agg oa
FULL OUTER JOIN refunds_agg ra
  ON ra.connection_id = oa.connection_id AND ra.date = oa.date;

CREATE UNIQUE INDEX mv_shopify_daily_pk ON mv_shopify_daily (connection_id, date);
CREATE INDEX mv_shopify_daily_client ON mv_shopify_daily (client_id, date);

-- ── Other revenue per source per day ──
CREATE MATERIALIZED VIEW mv_other_revenue_daily AS
SELECT o."clientId" AS client_id, o.source, o.date, c.currency,
  SUM(o.revenue * fx_factor(o.currency, c.currency, o.date)) AS revenue,
  SUM(o.orders)::bigint AS orders
FROM other_revenue o JOIN clients c ON c.id = o."clientId"
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX mv_other_revenue_daily_pk ON mv_other_revenue_daily (client_id, source, date);

-- ── Blended client-day view (the "source of truth" for MER, aMER, nCAC) ──
CREATE VIEW v_client_daily AS
WITH ads AS (
  SELECT client_id, date, SUM(spend) AS ad_spend, SUM(purchase_value) AS platform_revenue,
    SUM(spend) FILTER (WHERE platform = 'META')   AS meta_spend,
    SUM(spend) FILTER (WHERE platform = 'GOOGLE') AS google_spend,
    SUM(purchases) AS platform_purchases
  FROM mv_ad_daily GROUP BY 1, 2
),
shop AS (
  SELECT client_id, date, SUM(orders) AS orders, SUM(gross_sales) AS gross_sales, SUM(discounts) AS discounts,
    SUM(refunds) AS refunds, SUM(net_sales) AS net_sales, SUM(cogs) AS cogs, SUM(shipping) AS shipping,
    SUM(payment_fees) AS payment_fees, SUM(new_customers) AS new_customers,
    SUM(new_customer_revenue) AS new_customer_revenue, SUM(returning_customer_revenue) AS returning_customer_revenue,
    SUM(returning_orders) AS returning_orders
  FROM mv_shopify_daily GROUP BY 1, 2
),
other AS (
  SELECT client_id, date, SUM(revenue) AS other_revenue, SUM(orders) AS other_orders
  FROM mv_other_revenue_daily GROUP BY 1, 2
),
keys AS (
  SELECT client_id, date FROM ads UNION SELECT client_id, date FROM shop UNION SELECT client_id, date FROM other
)
SELECT k.client_id, k.date,
  COALESCE(ads.ad_spend, 0) AS ad_spend,
  COALESCE(ads.meta_spend, 0) AS meta_spend,
  COALESCE(ads.google_spend, 0) AS google_spend,
  COALESCE(ads.platform_revenue, 0) AS platform_revenue,
  COALESCE(ads.platform_purchases, 0) AS platform_purchases,
  COALESCE(shop.orders, 0) AS shopify_orders,
  COALESCE(shop.gross_sales, 0) AS gross_sales,
  COALESCE(shop.discounts, 0) AS discounts,
  COALESCE(shop.refunds, 0) AS refunds,
  COALESCE(shop.net_sales, 0) AS shopify_net_sales,
  COALESCE(shop.cogs, 0) AS cogs,
  COALESCE(shop.shipping, 0) AS shipping,
  COALESCE(shop.payment_fees, 0) AS payment_fees,
  COALESCE(shop.new_customers, 0) AS new_customers,
  COALESCE(shop.returning_orders, 0) AS returning_orders,
  COALESCE(shop.new_customer_revenue, 0) AS new_customer_revenue,
  COALESCE(shop.returning_customer_revenue, 0) AS returning_customer_revenue,
  COALESCE(other.other_revenue, 0) AS other_revenue,
  COALESCE(other.other_orders, 0) AS other_orders,
  COALESCE(shop.net_sales, 0) + COALESCE(other.other_revenue, 0) AS total_revenue
FROM keys k
LEFT JOIN ads   ON ads.client_id = k.client_id AND ads.date = k.date
LEFT JOIN shop  ON shop.client_id = k.client_id AND shop.date = k.date
LEFT JOIN other ON other.client_id = k.client_id AND other.date = k.date;

-- ── Week / month / year rollups (ISO weeks start on Monday) ──
CREATE VIEW v_client_weekly AS
SELECT client_id, date_trunc('week', date)::date AS period, SUM(ad_spend) AS ad_spend, SUM(platform_revenue) AS platform_revenue,
  SUM(shopify_orders) AS shopify_orders, SUM(shopify_net_sales) AS shopify_net_sales, SUM(other_revenue) AS other_revenue,
  SUM(total_revenue) AS total_revenue, SUM(new_customers) AS new_customers, SUM(new_customer_revenue) AS new_customer_revenue
FROM v_client_daily GROUP BY 1, 2;

CREATE VIEW v_client_monthly AS
SELECT client_id, date_trunc('month', date)::date AS period, SUM(ad_spend) AS ad_spend, SUM(platform_revenue) AS platform_revenue,
  SUM(shopify_orders) AS shopify_orders, SUM(shopify_net_sales) AS shopify_net_sales, SUM(other_revenue) AS other_revenue,
  SUM(total_revenue) AS total_revenue, SUM(new_customers) AS new_customers, SUM(new_customer_revenue) AS new_customer_revenue
FROM v_client_daily GROUP BY 1, 2;

CREATE VIEW v_client_yearly AS
SELECT client_id, date_trunc('year', date)::date AS period, SUM(ad_spend) AS ad_spend, SUM(platform_revenue) AS platform_revenue,
  SUM(shopify_orders) AS shopify_orders, SUM(shopify_net_sales) AS shopify_net_sales, SUM(other_revenue) AS other_revenue,
  SUM(total_revenue) AS total_revenue, SUM(new_customers) AS new_customers, SUM(new_customer_revenue) AS new_customer_revenue
FROM v_client_daily GROUP BY 1, 2;

-- Refresh everything (called after each sync and after seeding).
CREATE OR REPLACE FUNCTION refresh_reporting_views() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ad_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_shopify_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_other_revenue_daily;
END $$;
