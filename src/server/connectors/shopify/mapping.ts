/**
 * Pure mapping from Shopify Admin GraphQL Order nodes to NorthScale rows.
 * Money always in the shop currency (shopMoney). Dates are calendar days in the shop's timezone.
 */
import { classifyChannel, type Channel } from "./attribution";

type Money = { shopMoney?: { amount?: string; currencyCode?: string } } | null | undefined;
const amt = (m: Money): number => {
  const n = Number(m?.shopMoney?.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface ShopifyVisit {
  landingPage?: string | null;
  referrerUrl?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null } | null;
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  currencyCode?: string;
  sourceName?: string | null;
  discountCodes?: string[];
  subtotalPriceSet?: Money;
  totalDiscountsSet?: Money;
  totalShippingPriceSet?: Money;
  totalTaxSet?: Money;
  totalPriceSet?: Money;
  totalRefundedSet?: Money;
  customer?: { id: string } | null;
  customerJourneySummary?: { customerOrderIndex?: number | null; firstVisit?: ShopifyVisit | null; lastVisit?: ShopifyVisit | null } | null;
  lineItems?: {
    nodes: {
      title: string;
      variantTitle?: string | null;
      sku?: string | null;
      quantity: number;
      originalUnitPriceSet?: Money;
      totalDiscountSet?: Money;
      product?: { id: string } | null;
      variant?: { id: string; inventoryItem?: { unitCost?: { amount?: string } | null } | null } | null;
    }[];
  };
  refunds?: { id: string; createdAt: string; totalRefundedSet?: Money }[];
  transactions?: { kind?: string; status?: string; fees?: { amount?: { amount?: string } }[] | null }[];
}

/** Calendar day of an instant in an IANA timezone. */
export function dayInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

const gidNum = (gid: string | null | undefined) => (gid ? gid.split("/").pop()! : null);

export interface MapOptions {
  timezone: string;
  /** used when the API gives no transaction fees */
  feePct: number;
  /** used for lines with no unit cost (0..100) */
  defaultMarginPct: number;
  /** fallback when customerOrderIndex is unavailable: was there an earlier order for this customer? */
  isReturning?: (customerId: string | null, processedAt: string) => boolean;
}

export interface MappedOrder {
  order: {
    externalId: string;
    name: string;
    processedAt: Date;
    date: string;
    currency: string;
    customerExternalId: string | null;
    isNewCustomer: boolean;
    financialStatus: string | null;
    cancelledAt: Date | null;
    grossSales: number;
    discounts: number;
    shipping: number;
    taxes: number;
    totalPrice: number;
    refunded: number;
    cogs: number | null;
    paymentFees: number;
    discountCodes: string[];
    sourceName: string | null;
    landingSite: string | null;
    referringSite: string | null;
    firstUtmSource: string | null;
    firstUtmMedium: string | null;
    firstUtmCampaign: string | null;
    lastUtmSource: string | null;
    lastUtmMedium: string | null;
    lastUtmCampaign: string | null;
    channelFirstClick: Channel;
    channelLastClick: Channel;
  };
  lines: {
    productId: string | null;
    variantId: string | null;
    sku: string | null;
    title: string;
    variantTitle: string | null;
    quantity: number;
    price: number;
    discount: number;
    unitCost: number | null;
  }[];
  refunds: { externalId: string; date: string; amount: number }[];
  /** COGS uses Shopify's *current* unit cost (Shopify keeps no cost history); missing costs fall back to the default margin */
  missingCost: boolean;
}

export function mapOrder(o: ShopifyOrderNode, opt: MapOptions): MappedOrder {
  const processed = o.processedAt ?? o.createdAt;
  const currency = o.totalPriceSet?.shopMoney?.currencyCode ?? o.currencyCode ?? "USD";
  const lines = (o.lineItems?.nodes ?? []).map((l) => {
    const cost = l.variant?.inventoryItem?.unitCost?.amount;
    return {
      productId: gidNum(l.product?.id),
      variantId: gidNum(l.variant?.id),
      sku: l.sku ?? null,
      title: l.title,
      variantTitle: l.variantTitle ?? null,
      quantity: l.quantity,
      price: amt(l.originalUnitPriceSet),
      discount: amt(l.totalDiscountSet),
      unitCost: cost !== undefined && cost !== null && cost !== "" ? Number(cost) : null,
    };
  });
  const grossFromLines = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const grossSales = r2(grossFromLines || amt(o.subtotalPriceSet) + amt(o.totalDiscountsSet));
  const discounts = r2(amt(o.totalDiscountsSet));
  const missingCost = lines.some((l) => l.unitCost === null);
  const cogs = lines.length
    ? r2(lines.reduce((s, l) => s + (l.unitCost ?? l.price * (1 - opt.defaultMarginPct / 100)) * l.quantity, 0))
    : null;
  const totalPrice = r2(amt(o.totalPriceSet));
  const feesFromApi = o.transactions?.some((t) => Array.isArray(t.fees))
    ? o.transactions
        .filter((t) => t.status === "SUCCESS")
        .reduce((s, t) => s + (t.fees ?? []).reduce((a, f) => a + Number(f.amount?.amount ?? 0), 0), 0)
    : null;
  const paymentFees = r2(feesFromApi ?? (totalPrice * opt.feePct) / 100);

  const customerId = gidNum(o.customer?.id);
  const idx = o.customerJourneySummary?.customerOrderIndex;
  const isNewCustomer = typeof idx === "number" ? idx <= 1 : !(opt.isReturning?.(customerId, processed) ?? false);

  const first = o.customerJourneySummary?.firstVisit ?? null;
  const last = o.customerJourneySummary?.lastVisit ?? first;
  const visit = (v: ShopifyVisit | null) => ({
    utmSource: v?.utmParameters?.source ?? null,
    utmMedium: v?.utmParameters?.medium ?? null,
    utmCampaign: v?.utmParameters?.campaign ?? null,
    landingPage: v?.landingPage ?? null,
    referrer: v?.referrerUrl ?? null,
  });
  const f = visit(first),
    l = visit(last);

  return {
    order: {
      externalId: o.id,
      name: o.name,
      processedAt: new Date(processed),
      date: dayInTz(processed, opt.timezone),
      currency,
      customerExternalId: customerId,
      isNewCustomer,
      financialStatus: o.displayFinancialStatus ?? null,
      cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
      grossSales,
      discounts,
      shipping: r2(amt(o.totalShippingPriceSet)),
      taxes: r2(amt(o.totalTaxSet)),
      totalPrice,
      refunded: r2(amt(o.totalRefundedSet)),
      cogs,
      paymentFees,
      discountCodes: o.discountCodes ?? [],
      sourceName: o.sourceName ?? null,
      landingSite: l.landingPage,
      referringSite: l.referrer,
      firstUtmSource: f.utmSource,
      firstUtmMedium: f.utmMedium,
      firstUtmCampaign: f.utmCampaign,
      lastUtmSource: l.utmSource,
      lastUtmMedium: l.utmMedium,
      lastUtmCampaign: l.utmCampaign,
      channelFirstClick: classifyChannel(f),
      channelLastClick: classifyChannel(l),
    },
    lines,
    refunds: (o.refunds ?? [])
      .map((r) => ({ externalId: r.id, date: dayInTz(r.createdAt, opt.timezone), amount: r2(amt(r.totalRefundedSet)) }))
      .filter((r) => r.amount > 0),
    missingCost,
  };
}

/** GraphQL selection; optional parts can be dropped if the API version rejects them. */
export const OPTIONAL_PARTS = {
  journey: `customerJourneySummary { customerOrderIndex firstVisit { landingPage referrerUrl utmParameters { source medium campaign } } lastVisit { landingPage referrerUrl utmParameters { source medium campaign } } }`,
  fees: `transactions(first: 20) { kind status fees { amount { amount } } }`,
  unitCost: `inventoryItem { unitCost { amount } }`,
} as const;
export type OptionalPart = keyof typeof OPTIONAL_PARTS;

/** Field names Shopify mentions in "Field 'x' doesn't exist" errors → the optional part to drop. */
export const FIELD_TO_PART: Record<string, OptionalPart> = {
  customerJourneySummary: "journey",
  customerOrderIndex: "journey",
  utmParameters: "journey",
  fees: "fees",
  transactions: "fees",
  inventoryItem: "unitCost",
  unitCost: "unitCost",
};

function orderFields(parts: Set<OptionalPart>): string {
  return `id name createdAt processedAt cancelledAt displayFinancialStatus currencyCode sourceName discountCodes
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount } }
      customer { id }
      ${parts.has("journey") ? OPTIONAL_PARTS.journey : ""}
      lineItems(first: 100) { nodes { title variantTitle sku quantity originalUnitPriceSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } } product { id } variant { id ${parts.has("unitCost") ? OPTIONAL_PARTS.unitCost : ""} } } }
      refunds { id createdAt totalRefundedSet { shopMoney { amount } } }
      ${parts.has("fees") ? OPTIONAL_PARTS.fees : ""}`;
}

export function ordersQuery(parts: Set<OptionalPart>): string {
  return `query Orders($q: String!, $after: String) {
  orders(first: 50, after: $after, query: $q, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${orderFields(parts)} }
  }
}`;
}

export function orderByIdQuery(parts: Set<OptionalPart>): string {
  return `query One($id: ID!) { order(id: $id) { ${orderFields(parts)} } }`;
}
