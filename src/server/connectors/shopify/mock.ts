/**
 * Deterministic fake of the Shopify Admin GraphQL API (SHOPIFY_MOCK=1, refused in production).
 * One store per domain; orders are generated per day from the processed_at range in the search query.
 */
const PRODUCTS = [
  { id: 101, title: "Classic Tee", price: 29, cost: "8.50" },
  { id: 102, title: "Hoodie", price: 69, cost: "21.00" },
  { id: 103, title: "Cap", price: 24, cost: "6.00" },
  { id: 104, title: "Gift Card", price: 50, cost: null },
];
const VISITS: [string, { source?: string; medium?: string; landing: string; referrer?: string }][] = [
  ["META", { source: "facebook", medium: "paid_social", landing: "/products/hoodie?utm_source=facebook&fbclid=x" }],
  ["GOOGLE", { source: "google", medium: "cpc", landing: "/products/classic-tee?gclid=abc" }],
  ["EMAIL", { source: "klaviyo", medium: "email", landing: "/collections/new" }],
  ["ORGANIC", { landing: "/", referrer: "https://www.google.com/" }],
  ["DIRECT", { landing: "/" }],
  ["OTHER", { source: "tiktok", medium: "paid_social", landing: "/products/cap" }],
];

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (h % 100_000) / 100_000;
}
const money = (n: number, currencyCode = "USD") => ({ shopMoney: { amount: n.toFixed(2), currencyCode } });
const eachDay = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000))
    out.push(d.toISOString().slice(0, 10));
  return out;
};

function makeOrder(shop: string, day: string, i: number) {
  const key = `${shop}${day}${i}`;
  const r = hash(key);
  const dayNum = Math.round(Date.parse(day) / 86_400_000);
  const id = dayNum * 1000 + i;
  const isNew = r < 0.62;
  const customer = isNew ? `${id}` : `${Math.floor(hash(key + "c") * 400)}`;
  const nLines = r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
  const lines = Array.from({ length: nLines }, (_, k) => {
    const p = PRODUCTS[Math.floor(hash(key + k) * PRODUCTS.length)];
    const qty = hash(key + "q" + k) < 0.15 ? 2 : 1;
    return { p, qty };
  });
  const gross = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  const code = hash(key + "d") < 0.25 ? "WELCOME10" : null;
  const disc = code ? Math.round(gross * 10) / 100 : 0;
  const ship = gross - disc >= 75 ? 0 : 6.95;
  const tax = Math.round((gross - disc) * 7) / 100;
  const total = gross - disc + ship + tax;
  const [, v] = VISITS[Math.floor(hash(key + "v") * VISITS.length)];
  const hour = 9 + Math.floor(hash(key + "h") * 12);
  const processedAt = new Date(Date.parse(day + "T00:00:00Z") + (hour + 5) * 3_600_000).toISOString(); // shop in New York
  const refunded = hash(key + "r") < 0.04;
  const refundAt = new Date(Date.parse(processedAt) + 3 * 86_400_000).toISOString();
  const visit = {
    landingPage: v.landing,
    referrerUrl: v.referrer ?? null,
    utmParameters: v.source ? { source: v.source, medium: v.medium, campaign: "always-on" } : null,
  };
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: processedAt,
    processedAt,
    cancelledAt: hash(key + "x") < 0.01 ? processedAt : null,
    displayFinancialStatus: refunded ? "REFUNDED" : "PAID",
    currencyCode: "USD",
    sourceName: "web",
    discountCodes: code ? [code] : [],
    subtotalPriceSet: money(gross - disc),
    totalDiscountsSet: money(disc),
    totalShippingPriceSet: money(ship),
    totalTaxSet: money(tax),
    totalPriceSet: money(total),
    totalRefundedSet: money(refunded ? gross - disc : 0),
    customer: { id: `gid://shopify/Customer/${customer}` },
    customerJourneySummary: { customerOrderIndex: isNew ? 1 : 2 + Math.floor(hash(key + "n") * 4), firstVisit: visit, lastVisit: visit },
    lineItems: {
      nodes: lines.map((l, k) => ({
        title: l.p.title,
        variantTitle: "Default",
        sku: `SKU-${l.p.id}`,
        quantity: l.qty,
        originalUnitPriceSet: money(l.p.price),
        totalDiscountSet: money(k === 0 ? disc : 0),
        product: { id: `gid://shopify/Product/${l.p.id}` },
        variant: { id: `gid://shopify/ProductVariant/${l.p.id}01`, inventoryItem: { unitCost: l.p.cost ? { amount: l.p.cost } : null } },
      })),
    },
    refunds: refunded ? [{ id: `gid://shopify/Refund/${id}`, createdAt: refundAt, totalRefundedSet: money(gross - disc) }] : [],
    transactions: [{ kind: "SALE", status: "SUCCESS", fees: [{ amount: { amount: (total * 0.029 + 0.3).toFixed(2) } }] }],
  };
}

function ordersFor(shop: string, from: string, to: string) {
  const out = [];
  for (const day of eachDay(from, to)) {
    const n = 18 + Math.floor(hash(shop + day) * 18);
    for (let i = 0; i < n; i++) out.push(makeOrder(shop, day, i));
  }
  return out;
}

export const mockShopifyFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const shop = url.hostname;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const cost = {
    requestedQueryCost: 120,
    actualQueryCost: 80,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1700, restoreRate: 100 },
  };
  if (url.pathname === "/admin/oauth/access_token") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("client_secret") === "wrong")
      return json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
    return json({ access_token: "mock-cc-token", scope: "read_orders,read_products", expires_in: 86399 });
  }
  if (!url.pathname.endsWith("/graphql.json")) return json({ errors: "Not Found" }, 404);
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers?.["X-Shopify-Access-Token"] === "shpat_invalid")
    return json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }, 401);
  const { query, variables } = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, string | null> };
  if (query.includes("shop {"))
    return json({
      data: {
        shop: {
          name: shop.startsWith("mock-boutique") ? "Mock Boutique" : "Mock Store",
          myshopifyDomain: shop,
          currencyCode: "USD",
          ianaTimezone: "America/New_York",
          plan: { displayName: "Basic" },
        },
      },
      extensions: { cost },
    });
  if (query.includes("webhookSubscriptionCreate"))
    return json({
      data: { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://shopify/WebhookSubscription/1" }, userErrors: [] } },
      extensions: { cost },
    });
  if (query.includes("order(id:")) {
    const id = Number(String(variables.id).split("/").pop());
    const dayNum = Math.floor(id / 1000);
    const day = new Date(dayNum * 86_400_000).toISOString().slice(0, 10);
    return json({ data: { order: makeOrder(shop, day, id % 1000) }, extensions: { cost } });
  }
  if (query.includes("orders(")) {
    const q = String(variables.q);
    const from = /processed_at:>=(\d{4}-\d{2}-\d{2})/.exec(q)?.[1] ?? "2026-01-01";
    const to = /processed_at:<=(\d{4}-\d{2}-\d{2})/.exec(q)?.[1] ?? from;
    const all = ordersFor(shop, from, to);
    const offset = Number(variables.after ?? 0);
    const page = all.slice(offset, offset + 50);
    return json({
      data: { orders: { pageInfo: { hasNextPage: offset + 50 < all.length, endCursor: String(offset + 50) }, nodes: page } },
      extensions: { cost },
    });
  }
  return json({ errors: [{ message: "Unsupported mock query" }] });
};

export function shopifyMockEnabled(): boolean {
  if (process.env.SHOPIFY_MOCK !== "1") return false;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SHOPIFY_MOCK_IN_PROD !== "1")
    throw new Error("SHOPIFY_MOCK is not allowed in production");
  return true;
}
