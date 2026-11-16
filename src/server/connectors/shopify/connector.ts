import "server-only";
import { prisma } from "@/lib/db";
import { addDays, isIsoDate, todayInTz } from "@/lib/periods";
import { ConnectorError, type Connector, type ConnectorContext, type SyncResult } from "../types";
import { upsertOrders, type OrderWrite } from "../../sync/writer";
import { DEFAULT_SHOPIFY_API_VERSION, ShopifyClient, normalizeShop } from "./client";
import { FIELD_TO_PART, mapOrder, orderByIdQuery, ordersQuery, type OptionalPart, type ShopifyOrderNode } from "./mapping";
import { mockShopifyFetch, shopifyMockEnabled } from "./mock";

/**
 * Shopify credentials are stored (encrypted) as JSON, supporting the three ways stores grant access:
 *  - { shop, accessToken }            legacy custom app (shpat_…) or OAuth token
 *  - { shop, clientId, clientSecret } Dev Dashboard app on your own store → client-credentials token (~24h), renewed each run
 */
export interface ShopifyCredential {
  shop: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export function parseCredential(raw: string): ShopifyCredential {
  try {
    const c = JSON.parse(raw) as ShopifyCredential;
    if (!c.shop || (!c.accessToken && !(c.clientId && c.clientSecret))) throw new Error();
    return { ...c, shop: normalizeShop(c.shop) };
  } catch {
    throw new ConnectorError("Invalid Shopify credential", "auth");
  }
}

const version = () => process.env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
const fetchFn = (): typeof fetch => (shopifyMockEnabled() ? mockShopifyFetch : fetch);

/** Access token for a credential (client-credentials grant when needed). */
export async function accessTokenFor(c: ShopifyCredential): Promise<string> {
  if (c.accessToken) return c.accessToken;
  const res = await fetchFn()(`https://${c.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId!, client_secret: c.clientSecret! }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !j.access_token)
    throw new ConnectorError(
      `Shopify rejected the app credentials: ${j.error_description ?? j.error ?? res.status}. Check the app is installed on ${c.shop}.`,
      "auth",
    );
  return j.access_token;
}

async function clientFor(raw: string, onUsage?: (p: number) => void) {
  const cred = parseCredential(raw);
  return new ShopifyClient({
    shop: cred.shop,
    token: await accessTokenFor(cred),
    version: version(),
    fetchImpl: fetchFn(),
    sleep: shopifyMockEnabled() ? async () => {} : undefined,
    onUsage,
  });
}

interface ShopInfo {
  shop: { name: string; myshopifyDomain: string; currencyCode: string; ianaTimezone: string; plan?: { displayName?: string } | null };
}
const SHOP_QUERY = `{ shop { name myshopifyDomain currencyCode ianaTimezone plan { displayName } } }`;

/** Fetch all orders matching a search query, dropping optional fields the API version rejects. */
async function fetchOrders(c: ShopifyClient, q: string, warnings: string[], onPage: (nodes: ShopifyOrderNode[]) => Promise<void>) {
  const parts = new Set<OptionalPart>(["journey", "fees", "unitCost"]);
  let after: string | null = null;
  for (;;) {
    let data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrderNode[] } };
    try {
      data = await c.query(ordersQuery(parts), { q, after });
    } catch (e) {
      const err = e as ConnectorError;
      const field = /Field '(\w+)' doesn't exist/.exec(err.message ?? "")?.[1];
      const part = field ? FIELD_TO_PART[field] : undefined;
      if (err.kind === "invalid_request" && part && parts.has(part)) {
        parts.delete(part);
        warnings.push(
          part === "journey"
            ? "Customer journey (UTMs / order index) is not available — channel attribution limited and new vs returning computed from history."
            : part === "fees"
              ? "Transaction fees are not available — using the client's payment fee %."
              : "Unit costs are not readable (missing read_inventory scope?) — COGS uses the default margin.",
        );
        continue;
      }
      throw e;
    }
    await onPage(data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
}

/** New vs returning fallback: does this customer have an earlier order in our store history? */
async function returningLookup(clientId: string, nodes: ShopifyOrderNode[]) {
  const ids = [...new Set(nodes.map((n) => n.customer?.id?.split("/").pop()).filter((x): x is string => !!x))];
  if (!ids.length) return () => false;
  const firsts = await prisma.shopifyOrder.groupBy({
    by: ["customerExternalId"],
    where: { clientId, customerExternalId: { in: ids } },
    _min: { processedAt: true },
  });
  const first = new Map(firsts.map((f) => [f.customerExternalId!, f._min.processedAt!]));
  const seenInBatch = new Map<string, number>();
  for (const n of [...nodes].sort((a, b) => (a.processedAt ?? a.createdAt).localeCompare(b.processedAt ?? b.createdAt))) {
    const id = n.customer?.id?.split("/").pop();
    if (id && !seenInBatch.has(id)) seenInBatch.set(id, Date.parse(n.processedAt ?? n.createdAt));
  }
  return (customerId: string | null, processedAt: string) => {
    if (!customerId) return false;
    const t = Date.parse(processedAt);
    const dbFirst = first.get(customerId)?.getTime() ?? Infinity;
    const batchFirst = seenInBatch.get(customerId) ?? Infinity;
    return Math.min(dbFirst, batchFirst) < t;
  };
}

async function clientSettings(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { paymentFeePct: true, defaultMarginPct: true } });
  return { feePct: c?.paymentFeePct ?? 2.9, defaultMarginPct: c?.defaultMarginPct ?? 60 };
}

export async function syncSingleOrder(ctx: ConnectorContext, orderGid: string): Promise<number> {
  const c = await clientFor(ctx.token);
  const parts = new Set<OptionalPart>(["journey", "fees", "unitCost"]);
  let data: { order: ShopifyOrderNode | null } | null = null;
  for (let i = 0; i < 4 && !data; i++) {
    try {
      data = await c.query<{ order: ShopifyOrderNode | null }>(orderByIdQuery(parts), { id: orderGid });
    } catch (e) {
      const field = /Field '(\w+)' doesn't exist/.exec((e as Error).message)?.[1];
      const part = field ? FIELD_TO_PART[field] : undefined;
      if (!part || !parts.delete(part)) throw e;
    }
  }
  if (!data?.order) return 0;
  const settings = await clientSettings(ctx.clientId);
  const isReturning = await returningLookup(ctx.clientId, [data.order]);
  const m = mapOrder(data.order, { timezone: ctx.timezone, ...settings, isReturning });
  return upsertOrders(ctx.connectionId, ctx.clientId, ctx.currency, [m]);
}

export const shopifyConnector: Connector = {
  platform: "SHOPIFY",

  oauth: {
    authorizeUrl(state, redirectUri, extra) {
      const shop = normalizeShop(extra?.shop ?? "");
      if (shopifyMockEnabled()) return `${redirectUri}?code=mock-code&shop=${shop}&state=${encodeURIComponent(state)}`;
      const u = new URL(`https://${shop}/admin/oauth/authorize`);
      u.searchParams.set("client_id", process.env.SHOPIFY_API_KEY ?? "");
      u.searchParams.set("scope", "read_orders,read_all_orders,read_products,read_inventory,read_customers");
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchangeCode(code, _redirectUri, extra) {
      const shop = normalizeShop(extra?.shop ?? "");
      if (shopifyMockEnabled())
        return { token: JSON.stringify({ shop, accessToken: "mock-oauth-token" }), expiresAt: null, userId: shop, userName: shop };
      const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: process.env.SHOPIFY_API_KEY, client_secret: process.env.SHOPIFY_API_SECRET, code }),
      });
      const j = (await res.json()) as { access_token?: string };
      if (!j.access_token) throw new ConnectorError("Shopify did not return an access token", "auth");
      return { token: JSON.stringify({ shop, accessToken: j.access_token }), expiresAt: null, userId: shop, userName: shop };
    },
  },

  async inspectToken(raw) {
    const c = await clientFor(raw);
    const { shop } = await c.query<ShopInfo>(SHOP_QUERY);
    return { id: shop.myshopifyDomain, name: shop.name, expiresAt: null, scopes: [] };
  },

  /** A Shopify credential is for exactly one store. */
  async listAccounts(raw) {
    const c = await clientFor(raw);
    const { shop } = await c.query<ShopInfo>(SHOP_QUERY);
    return [
      {
        externalId: shop.myshopifyDomain,
        name: shop.name,
        currency: shop.currencyCode,
        timezone: shop.ianaTimezone,
        status: "Active",
        parent: shop.plan?.displayName ? `Plan: ${shop.plan.displayName}` : null,
      },
    ];
  },

  async syncRange(ctx, range): Promise<SyncResult> {
    if (!isIsoDate(range.from) || !isIsoDate(range.to)) throw new Error("Invalid range");
    const c = await clientFor(ctx.token, ctx.onUsage);
    const settings = await clientSettings(ctx.clientId);
    const warnings: string[] = [];
    let rows = 0;
    // Orders processed in the range; for recent windows also anything *updated* since (refunds, edits, cancellations).
    const recent = range.to >= addDays(todayInTz(ctx.timezone), -8);
    const q = `processed_at:>=${range.from} processed_at:<=${range.to}${recent ? ` OR updated_at:>=${range.from}` : ""}`;
    await fetchOrders(c, q, warnings, async (nodes) => {
      const isReturning = await returningLookup(ctx.clientId, nodes);
      const mapped: OrderWrite[] = nodes.map((n) => mapOrder(n, { timezone: ctx.timezone, ...settings, isReturning }));
      rows += await upsertOrders(ctx.connectionId, ctx.clientId, ctx.currency, mapped);
    });
    return { rows, warnings: [...new Set(warnings)], usagePct: c.maxUsage };
  },

  /** Shopify has no ad-style breakdowns: products, channels, codes and refunds are derived from orders. */
  async syncBreakdowns(): Promise<SyncResult> {
    return { rows: 0, warnings: [] };
  },

  async healthCheck(ctx: ConnectorContext) {
    try {
      const c = await clientFor(ctx.token);
      const { shop } = await c.query<ShopInfo>(SHOP_QUERY);
      return {
        status: "OK",
        account: {
          accountName: shop.name,
          accountStatus: "Active",
          currency: shop.currencyCode,
          timezone: shop.ianaTimezone,
          plan: shop.plan?.displayName ?? null,
        },
      };
    } catch (e) {
      const err = e as ConnectorError;
      return { status: err.kind === "auth" ? "TOKEN_EXPIRED" : "ERROR", message: err.message };
    }
  },

  async registerWebhooks(ctx, callbackUrl) {
    const c = await clientFor(ctx.token);
    const registered: string[] = [];
    const warnings: string[] = [];
    for (const topic of ["ORDERS_CREATE", "ORDERS_UPDATED", "REFUNDS_CREATE"]) {
      const r = await c.query<{
        webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: { message: string }[] };
      }>(
        `mutation Sub($topic: WebhookSubscriptionTopic!, $url: URL!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) { webhookSubscription { id } userErrors { message } } }`,
        { topic, url: callbackUrl },
      );
      const errs = r.webhookSubscriptionCreate.userErrors;
      if (errs.length && !errs.some((e) => /already been taken|already exists/i.test(e.message)))
        warnings.push(`${topic}: ${errs.map((e) => e.message).join(", ")}`);
      else registered.push(topic);
    }
    return { registered, warnings };
  },
};
