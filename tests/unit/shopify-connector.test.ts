import { describe, expect, it, vi } from "vitest";
import { classifyChannel } from "@/server/connectors/shopify/attribution";
import { ShopifyClient, classifyShopifyError, normalizeShop } from "@/server/connectors/shopify/client";
import { dayInTz, mapOrder, ordersQuery, type ShopifyOrderNode } from "@/server/connectors/shopify/mapping";

const money = (amount: number | string, currencyCode = "USD") => ({ shopMoney: { amount: String(amount), currencyCode } });

const ORDER: ShopifyOrderNode = {
  id: "gid://shopify/Order/5550001",
  name: "#1042",
  createdAt: "2026-11-10T02:30:00Z",
  processedAt: "2026-11-10T02:30:00Z", // still Nov 9 in New York
  displayFinancialStatus: "PARTIALLY_REFUNDED",
  discountCodes: ["WELCOME10"],
  subtotalPriceSet: money(104.4),
  totalDiscountsSet: money(11.6),
  totalShippingPriceSet: money(0),
  totalTaxSet: money(7.31),
  totalPriceSet: money(111.71),
  totalRefundedSet: money(58),
  customer: { id: "gid://shopify/Customer/77" },
  customerJourneySummary: {
    customerOrderIndex: 1,
    firstVisit: { landingPage: "https://shop.example/products/serum?fbclid=abc", referrerUrl: "https://l.instagram.com/" },
    lastVisit: {
      landingPage: "/products/serum",
      referrerUrl: null,
      utmParameters: { source: "klaviyo", medium: "email", campaign: "winback" },
    },
  },
  lineItems: {
    nodes: [
      {
        title: "Vitamin C Serum",
        quantity: 1,
        originalUnitPriceSet: money(58),
        product: { id: "gid://shopify/Product/8001" },
        variant: { id: "gid://shopify/ProductVariant/1", inventoryItem: { unitCost: { amount: "9.5" } } },
      },
      {
        title: "Eye Cream",
        quantity: 1,
        originalUnitPriceSet: money(58),
        product: { id: "gid://shopify/Product/8008" },
        variant: { id: "gid://shopify/ProductVariant/2", inventoryItem: { unitCost: null } },
      },
    ],
  },
  refunds: [{ id: "gid://shopify/Refund/9", createdAt: "2026-11-15T15:00:00Z", totalRefundedSet: money(58) }],
  transactions: [
    { kind: "SALE", status: "SUCCESS", fees: [{ amount: { amount: "3.54" } }] },
    { kind: "REFUND", status: "SUCCESS", fees: [] },
  ],
};

describe("Shopify order mapping", () => {
  it("maps money, dates in the shop timezone, new customer, refunds on refund date", () => {
    const m = mapOrder(ORDER, { timezone: "America/New_York", feePct: 2.9, defaultMarginPct: 60 });
    expect(m.order).toMatchObject({
      name: "#1042",
      date: "2026-11-09",
      grossSales: 116,
      discounts: 11.6,
      taxes: 7.31,
      totalPrice: 111.71,
      refunded: 58,
      isNewCustomer: true,
      customerExternalId: "77",
      paymentFees: 3.54,
      discountCodes: ["WELCOME10"],
      channelFirstClick: "META",
      channelLastClick: "EMAIL",
      lastUtmCampaign: "winback",
    });
    expect(m.refunds).toEqual([{ externalId: "gid://shopify/Refund/9", date: "2026-11-15", amount: 58 }]);
    // missing unit cost → default margin (60%) → cost = 40% of price
    expect(m.order.cogs).toBeCloseTo(9.5 + 58 * 0.4);
    expect(m.missingCost).toBe(true);
    expect(m.lines[0]).toMatchObject({ productId: "8001", variantId: "1", unitCost: 9.5 });
  });

  it("falls back to % fees and local history when optional fields are missing", () => {
    const o = { ...ORDER, transactions: undefined, customerJourneySummary: undefined };
    const m = mapOrder(o, { timezone: "UTC", feePct: 3, defaultMarginPct: 60, isReturning: () => true });
    expect(m.order.paymentFees).toBeCloseTo(111.71 * 0.03, 2);
    expect(m.order.isNewCustomer).toBe(false);
    expect(m.order.channelLastClick).toBe("DIRECT");
  });

  it("timezone day helper", () => {
    expect(dayInTz("2026-11-10T02:30:00Z", "America/Sao_Paulo")).toBe("2026-11-09");
    expect(dayInTz("2026-11-10T02:30:00Z", "Europe/Lisbon")).toBe("2026-11-10");
  });

  it("query drops optional parts", () => {
    expect(ordersQuery(new Set(["journey", "fees", "unitCost"]))).toContain("customerOrderIndex");
    const q = ordersQuery(new Set());
    expect(q).not.toContain("customerJourneySummary");
    expect(q).not.toContain("fees");
    expect(q).not.toContain("unitCost");
  });
});

describe("UTM / click-id attribution", () => {
  const cases: [Parameters<typeof classifyChannel>[0], string][] = [
    [{ utmSource: "facebook", utmMedium: "paid_social" }, "META"],
    [{ utmSource: "ig", utmMedium: "cpc" }, "META"],
    [{ landingPage: "/p?fbclid=xyz" }, "META"],
    [{ utmSource: "google", utmMedium: "cpc" }, "GOOGLE"],
    [{ landingPage: "https://shop/p?gclid=abc" }, "GOOGLE"],
    [{ landingPage: "/?gbraid=1" }, "GOOGLE"],
    [{ utmSource: "klaviyo", utmMedium: "flow" }, "EMAIL"],
    [{ utmMedium: "email" }, "EMAIL"],
    [{ utmSource: "google", utmMedium: "organic" }, "ORGANIC"],
    [{ referrer: "https://www.google.com/" }, "ORGANIC"],
    [{ referrer: "https://l.instagram.com/" }, "ORGANIC"],
    [{ utmSource: "tiktok", utmMedium: "paid_social" }, "OTHER"],
    [{ referrer: "https://some-blog.com/post" }, "OTHER"],
    [{}, "DIRECT"],
  ];
  for (const [visit, expected] of cases) it(`${JSON.stringify(visit)} → ${expected}`, () => expect(classifyChannel(visit)).toBe(expected));
});

describe("Shopify client", () => {
  const ok = (data: unknown, available = 1000) =>
    new Response(
      JSON.stringify({
        data,
        extensions: {
          cost: {
            requestedQueryCost: 200,
            actualQueryCost: 120,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 },
          },
        },
      }),
      { status: 200 },
    );

  it("normalizes shop domains", () => {
    expect(normalizeShop("https://Brand.myshopify.com/admin")).toBe("brand.myshopify.com");
    expect(normalizeShop("brand")).toBe("brand.myshopify.com");
    expect(() => normalizeShop("not a shop!")).toThrow();
  });

  it("sends the token header and waits when the cost bucket is low", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok({ shop: { name: "x" } }, 100));
    const c = new ShopifyClient({ shop: "brand.myshopify.com", token: "shpat_x", fetchImpl, sleep });
    await c.query("{ shop { name } }");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://brand.myshopify.com/admin/api/2026-10/graphql.json");
    expect((init?.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_x");
    expect(sleep).toHaveBeenCalledWith(2000); // needs 300, has 100, restores 100/s
    expect(c.maxUsage).toBe(95);
  });

  it("retries THROTTLED errors", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: {
              cost: { requestedQueryCost: 300, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 50, restoreRate: 100 } },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(ok({ shop: { name: "x" } }));
    await new ShopifyClient({ shop: "brand", token: "t", fetchImpl, sleep }).query("{ shop { name } }");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("classifies errors", () => {
    expect(classifyShopifyError(401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }).kind).toBe(
      "auth",
    );
    expect(
      classifyShopifyError(200, { errors: [{ message: "Access denied for orders field.", extensions: { code: "ACCESS_DENIED" } }] }).kind,
    ).toBe("permission");
    expect(classifyShopifyError(200, { errors: [{ message: "Field 'fees' doesn't exist on type 'OrderTransaction'" }] }).kind).toBe(
      "invalid_request",
    );
    expect(classifyShopifyError(503, undefined).kind).toBe("transient");
  });
});
