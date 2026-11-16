/**
 * Deterministic fake of the Google Ads REST API (GOOGLE_ADS_MOCK=1, refused in production).
 * Parses the GAQL FROM clause and date range and answers with REST-shaped (camelCase) rows.
 */
const MCC = "1112223333";
const CUSTOMERS: Record<
  string,
  { name: string; currency: string; tz: string; status: string; manager?: boolean; funnel?: boolean; geo: [string, number][] }
> = {
  [MCC]: { name: "Mock Agency MCC", currency: "USD", tz: "America/New_York", status: "ENABLED", manager: true, geo: [] },
  "4445556666": {
    name: "Mock Brand – Google Ads",
    currency: "USD",
    tz: "America/New_York",
    status: "ENABLED",
    funnel: true,
    geo: [
      ["2840", 0.85],
      ["2124", 0.15],
    ],
  },
  "7778889999": {
    name: "Mock Marca – Google Ads",
    currency: "BRL",
    tz: "America/Sao_Paulo",
    status: "ENABLED",
    geo: [
      ["2076", 0.9],
      ["2218", 0.1],
    ],
  },
  "1231231234": { name: "Old Client (cancelled)", currency: "USD", tz: "America/New_York", status: "CANCELED", geo: [] },
  "9990001111": { name: "Mock Solo Account", currency: "USD", tz: "America/Chicago", status: "ENABLED", funnel: true, geo: [["2840", 1]] },
};
const CHILDREN = ["4445556666", "7778889999", "1231231234"];
const DIRECT = [MCC, "9990001111"];

function structure(cid: string) {
  const p = cid.slice(-3);
  const campaigns = [
    { id: `${p}1`, name: "Search | Brand", type: "SEARCH", w: 0.25 },
    { id: `${p}2`, name: "PMax | All products", type: "PERFORMANCE_MAX", w: 0.55 },
    { id: `${p}3`, name: "YouTube | Awareness", type: "VIDEO", w: 0.2 },
  ];
  const adGroups = campaigns.flatMap((c) =>
    [1, 2].map((j) => ({ id: `${c.id}0${j}`, name: `${c.name.split("|")[1].trim()} – group ${j}`, campaign: c })),
  );
  const ads = adGroups.map((g, i) => ({ id: `${g.id}9`, group: g, disapproved: i === 2 }));
  return { campaigns, adGroups, ads };
}

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (h % 10_000) / 10_000;
}

interface M {
  cost: number;
  impr: number;
  clicks: number;
  conv: number;
  value: number;
  all: number;
  vtc: number;
}
const ZERO: M = { cost: 0, impr: 0, clicks: 0, conv: 0, value: 0, all: 0, vtc: 0 };
const add = (a: M, b: M): M => ({
  cost: a.cost + b.cost,
  impr: a.impr + b.impr,
  clicks: a.clicks + b.clicks,
  conv: a.conv + b.conv,
  value: a.value + b.value,
  all: a.all + b.all,
  vtc: a.vtc + b.vtc,
});
const scale = (a: M, f: number): M => ({
  cost: Math.round(a.cost * f),
  impr: Math.round(a.impr * f),
  clicks: Math.round(a.clicks * f),
  conv: a.conv * f,
  value: a.value * f,
  all: a.all * f,
  vtc: Math.round(a.vtc * f),
});

function adDay(cid: string, adId: string, w: number, day: string): M {
  const r = hash(cid + adId + day);
  const cost = Math.round((60 + 120 * r) * w * 2 * 1_000_000);
  const impr = Math.round((cost / 1_000_000) * (25 + 10 * r));
  const clicks = Math.round(impr * (0.03 + 0.02 * hash(day + adId)));
  const conv = Math.round(clicks * (0.03 + 0.02 * r) * 100) / 100;
  return {
    cost,
    impr,
    clicks,
    conv,
    value: Math.round(conv * (70 + 20 * r) * 100) / 100,
    all: Math.round(conv * 1.3 * 100) / 100,
    vtc: Math.round(conv * 0.1),
  };
}

const metricsJson = (m: M, sis?: number) => ({
  costMicros: String(m.cost),
  impressions: String(m.impr),
  clicks: String(m.clicks),
  conversions: Math.round(m.conv * 100) / 100,
  conversionsValue: Math.round(m.value * 100) / 100,
  allConversions: Math.round(m.all * 100) / 100,
  viewThroughConversions: String(m.vtc),
  ...(sis !== undefined ? { searchImpressionShare: sis } : {}),
});

function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

const SEG = {
  hour: Array.from({ length: 24 }, (_, h) => [h, h < 6 ? 0.01 : h > 18 ? 0.06 : 0.05] as [number, number]),
  device: [
    ["MOBILE", 0.62],
    ["DESKTOP", 0.33],
    ["TABLET", 0.05],
  ] as [string, number][],
  age: [
    ["AGE_RANGE_18_24", 0.1],
    ["AGE_RANGE_25_34", 0.3],
    ["AGE_RANGE_35_44", 0.25],
    ["AGE_RANGE_45_54", 0.17],
    ["AGE_RANGE_55_64", 0.1],
    ["AGE_RANGE_65_UP", 0.05],
    ["AGE_RANGE_UNDETERMINED", 0.03],
  ] as [string, number][],
  gender: [
    ["FEMALE", 0.6],
    ["MALE", 0.33],
    ["UNDETERMINED", 0.07],
  ] as [string, number][],
};
const norm = <T>(xs: [T, number][]) => {
  const s = xs.reduce((a, [, w]) => a + w, 0);
  return xs.map(([k, w]) => [k, w / s] as [T, number]);
};

function search(cid: string, gaql: string): unknown[] {
  const from = /FROM\s+(\w+)/i.exec(gaql)?.[1] ?? "";
  const range = /segments\.date BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(gaql);
  const cu = CUSTOMERS[cid];
  if (!cu) throw Object.assign(new Error("not found"), { status: 403 });
  const { campaigns, adGroups, ads } = structure(cid);
  const customer = {
    id: cid,
    descriptiveName: cu.name,
    currencyCode: cu.currency,
    timeZone: cu.tz,
    manager: !!cu.manager,
    status: cu.status,
    testAccount: false,
  };

  if (from === "customer" && !range) return [{ customer }];
  if (from === "customer_client")
    return CHILDREN.map((id) => ({
      customerClient: {
        id,
        descriptiveName: CUSTOMERS[id].name,
        currencyCode: CUSTOMERS[id].currency,
        timeZone: CUSTOMERS[id].tz,
        manager: false,
        status: CUSTOMERS[id].status,
        level: "1",
      },
    }));
  if (from === "geo_target_constant") return [{ geoTargetConstant: { id: "2218", countryCode: "EC" } }];
  if (from === "conversion_action")
    return [
      { conversionAction: { id: "1", category: "PURCHASE", status: "ENABLED" } },
      ...(cu.funnel
        ? [
            { conversionAction: { id: "2", category: "ADD_TO_CART", status: "ENABLED" } },
            { conversionAction: { id: "3", category: "BEGIN_CHECKOUT", status: "ENABLED" } },
          ]
        : []),
    ];
  if (!range) {
    if (from === "campaign")
      return campaigns.map((c) => ({
        campaign: { id: c.id, name: c.name, status: "ENABLED", advertisingChannelType: c.type },
        campaignBudget: { amountMicros: String(Math.round(c.w * 200e6)) },
      }));
    if (from === "ad_group")
      return adGroups.map((g) => ({
        adGroup: { id: g.id, name: g.name, status: "ENABLED" },
        campaign: { id: g.campaign.id, name: g.campaign.name },
      }));
    if (from === "ad_group_ad")
      return ads.map((a) => ({
        adGroupAd: {
          status: "ENABLED",
          ad: {
            id: a.id,
            type: a.group.campaign.type === "SEARCH" ? "RESPONSIVE_SEARCH_AD" : "RESPONSIVE_DISPLAY_AD",
            finalUrls: [`https://mockbrand.example/${a.group.campaign.type === "SEARCH" ? "" : "collections/all"}`],
            responsiveSearchAd:
              a.group.campaign.type === "SEARCH" ? { headlines: [{ text: `Official store ${a.id.slice(-3)}` }] } : undefined,
          },
          policySummary: a.disapproved
            ? { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "DESTINATION_NOT_WORKING", type: "PROHIBITED" }] }
            : { approvalStatus: "APPROVED" },
        },
        adGroup: { id: a.group.id },
        campaign: { id: a.group.campaign.id },
      }));
    return [];
  }

  const rows: unknown[] = [];
  const sel = gaql.slice(0, gaql.search(/FROM/i));
  for (const day of eachDay(range[1], range[2])) {
    const perAd = new Map(ads.map((a) => [a.id, adDay(cid, a.id, a.group.campaign.w, day)]));
    const sumAds = (pred: (a: (typeof ads)[number]) => boolean) => ads.filter(pred).reduce((acc, a) => add(acc, perAd.get(a.id)!), ZERO);
    const seg = { date: day };
    const camp = (c: (typeof campaigns)[number]) => ({ id: c.id, name: c.name });
    const sis = (c: (typeof campaigns)[number]) => (c.type === "SEARCH" ? 0.55 + 0.3 * hash(day + c.id) : undefined);
    switch (from) {
      case "customer":
        rows.push({
          segments: seg,
          metrics: metricsJson(
            sumAds(() => true),
            sel.includes("search_impression_share") ? 0.6 : undefined,
          ),
        });
        break;
      case "campaign":
        for (const c of campaigns) {
          const m = sumAds((a) => a.group.campaign.id === c.id);
          if (sel.includes("conversion_action_category")) {
            const cats: [string, number, number][] = [["PURCHASE", m.conv * 1.05, m.value * 1.05]];
            if (cu.funnel) cats.push(["ADD_TO_CART", m.clicks * 0.1, 0], ["BEGIN_CHECKOUT", m.clicks * 0.035, 0]);
            for (const [cat, n, v] of cats)
              rows.push({
                segments: { ...seg, conversionActionCategory: cat },
                campaign: { id: c.id },
                metrics: { allConversions: Math.round(n * 100) / 100, allConversionsValue: Math.round(v * 100) / 100 },
              });
          } else if (sel.includes("segments.hour")) {
            for (const [h, w] of norm(SEG.hour))
              rows.push({ segments: { ...seg, hour: h }, campaign: camp(c), metrics: metricsJson(scale(m, w)) });
          } else if (sel.includes("segments.device")) {
            for (const [d, w] of SEG.device)
              rows.push({ segments: { ...seg, device: d }, campaign: camp(c), metrics: metricsJson(scale(m, w)) });
          } else
            rows.push({
              segments: seg,
              campaign: camp(c),
              metrics: metricsJson(m, sel.includes("search_impression_share") ? sis(c) : undefined),
            });
        }
        break;
      case "ad_group":
        if (sel.includes("conversion_action_category")) {
          for (const g of adGroups) {
            const m = sumAds((a) => a.group.id === g.id);
            const cats: [string, number, number][] = [["PURCHASE", m.conv * 1.05, m.value * 1.05]];
            if (cu.funnel) cats.push(["ADD_TO_CART", m.clicks * 0.1, 0], ["BEGIN_CHECKOUT", m.clicks * 0.035, 0]);
            for (const [cat, n, v] of cats)
              rows.push({
                segments: { ...seg, conversionActionCategory: cat },
                adGroup: { id: g.id },
                metrics: { allConversions: Math.round(n * 100) / 100, allConversionsValue: Math.round(v * 100) / 100 },
              });
          }
          break;
        }
        for (const g of adGroups)
          rows.push({
            segments: seg,
            campaign: camp(g.campaign),
            adGroup: { id: g.id, name: g.name },
            metrics: metricsJson(sumAds((a) => a.group.id === g.id)),
          });
        break;
      case "ad_group_ad":
        for (const a of ads)
          rows.push({
            segments: seg,
            campaign: camp(a.group.campaign),
            adGroup: { id: a.group.id, name: a.group.name },
            adGroupAd: { ad: { id: a.id } },
            metrics: metricsJson(perAd.get(a.id)!),
          });
        break;
      case "keyword_view":
        for (const g of adGroups.filter((x) => x.campaign.type === "SEARCH"))
          [
            ["mock brand", "EXACT", 0.6],
            ["mock brand store", "PHRASE", 0.4],
          ].forEach(([text, mt, w], i) =>
            rows.push({
              segments: seg,
              campaign: camp(g.campaign),
              adGroup: { id: g.id, name: g.name },
              adGroupCriterion: { criterionId: `${g.id}${i}`, keyword: { text, matchType: mt } },
              metrics: metricsJson(
                scale(
                  sumAds((a) => a.group.id === g.id),
                  w as number,
                ),
                0.7,
              ),
            }),
          );
        break;
      case "search_term_view":
        for (const c of campaigns.filter((x) => x.type === "SEARCH"))
          for (const g of adGroups.filter((x) => x.campaign.id === c.id))
            [
              ["mock brand", 0.5],
              ["mock brand discount", 0.3],
              ["mockbrand reviews", 0.2],
            ].forEach(([term, w]) =>
              rows.push({
                segments: seg,
                campaign: camp(c),
                adGroup: { id: g.id },
                searchTermView: { searchTerm: term },
                metrics: metricsJson(
                  scale(
                    sumAds((a) => a.group.id === g.id),
                    w as number,
                  ),
                ),
              }),
            );
        break;
      case "age_range_view":
        for (const g of adGroups.filter((x) => x.campaign.type !== "PERFORMANCE_MAX"))
          for (const [t, w] of norm(SEG.age))
            rows.push({
              segments: seg,
              campaign: camp(g.campaign),
              adGroup: { id: g.id },
              adGroupCriterion: { ageRange: { type: t } },
              metrics: metricsJson(
                scale(
                  sumAds((a) => a.group.id === g.id),
                  w,
                ),
              ),
            });
        break;
      case "gender_view":
        for (const g of adGroups.filter((x) => x.campaign.type !== "PERFORMANCE_MAX"))
          for (const [t, w] of SEG.gender)
            rows.push({
              segments: seg,
              campaign: camp(g.campaign),
              adGroup: { id: g.id },
              adGroupCriterion: { gender: { type: t } },
              metrics: metricsJson(
                scale(
                  sumAds((a) => a.group.id === g.id),
                  w,
                ),
              ),
            });
        break;
      case "geographic_view":
        for (const c of campaigns)
          for (const [geo, w] of cu.geo)
            rows.push({
              segments: seg,
              campaign: camp(c),
              geographicView: { countryCriterionId: geo, locationType: "LOCATION_OF_PRESENCE" },
              metrics: metricsJson(
                scale(
                  sumAds((a) => a.group.campaign.id === c.id),
                  w,
                ),
              ),
            });
        break;
    }
  }
  return rows;
}

export const mockGoogleFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "mock-access", expires_in: 3600 });
  if (url.pathname.endsWith("customers:listAccessibleCustomers")) return json({ resourceNames: DIRECT.map((id) => `customers/${id}`) });
  const m = /customers\/(\d+)\/googleAds:searchStream/.exec(url.pathname);
  if (m) {
    const { query } = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    try {
      const results = search(m[1], query);
      // searchStream returns batches; split to exercise batch handling
      const batches = [];
      for (let i = 0; i < results.length; i += 1000) batches.push({ results: results.slice(i, i + 1000) });
      return json(batches.length ? batches : [{ results: [] }]);
    } catch {
      return json(
        [
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "The caller does not have permission",
              details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }],
            },
          },
        ],
        403,
      );
    }
  }
  return json({ error: { code: 404, status: "NOT_FOUND" } }, 404);
};

export function googleMockEnabled(): boolean {
  if (process.env.GOOGLE_ADS_MOCK !== "1") return false;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_GOOGLE_ADS_MOCK_IN_PROD !== "1")
    throw new Error("GOOGLE_ADS_MOCK is not allowed in production");
  return true;
}
