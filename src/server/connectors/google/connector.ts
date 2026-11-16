import "server-only";
import { isIsoDate, type DateRange } from "@/lib/periods";
import { ConnectorError, type Connector, type ConnectorContext, type ExternalAccount, type SyncResult } from "../types";
import { replaceBreakdowns, replaceDaily, upsertEntities, type BreakdownRow, type DailyRow, type EntityRow } from "../../sync/writer";
import { GoogleAdsClient, DEFAULT_GOOGLE_ADS_API_VERSION, formatCustomerId } from "./client";
import {
  COUNTRY_BY_CRITERION,
  CATEGORY_TO_FIELD,
  CUSTOMER_STATUS_OK,
  adName,
  ageLabel,
  campaignType,
  foldCategories,
  genderLabel,
  hourLabel,
  mapMetrics,
  policyIssue,
  type GaqlRow,
} from "./mapping";
import { googleMockEnabled, mockGoogleFetch } from "./mock";

const digits = (s: string) => s.replace(/\D/g, "");
const env = () => ({
  developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? (googleMockEnabled() ? "mock-dev-token" : ""),
  clientId: process.env.GOOGLE_ADS_CLIENT_ID ?? (googleMockEnabled() ? "mock-client" : ""),
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? (googleMockEnabled() ? "mock-secret" : ""),
  version: process.env.GOOGLE_ADS_API_VERSION || DEFAULT_GOOGLE_ADS_API_VERSION,
  dailyOperations: Number(process.env.GOOGLE_ADS_DAILY_OPERATIONS ?? 15_000),
});

function makeClient(refreshToken: string, loginCustomerId?: string | null, onUsage?: (p: number) => void) {
  const e = env();
  if (!e.developerToken || !e.clientId || !e.clientSecret)
    throw new ConnectorError(
      "Google Ads is not configured: set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET.",
      "invalid_request",
    );
  return new GoogleAdsClient({
    refreshToken,
    developerToken: e.developerToken,
    clientId: e.clientId,
    clientSecret: e.clientSecret,
    loginCustomerId,
    version: e.version,
    dailyOperations: e.dailyOperations,
    onUsage,
    ...(googleMockEnabled() ? { fetchImpl: mockGoogleFetch, sleep: async () => {} } : {}),
  });
}

const METRICS =
  "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.view_through_conversions";

function dateWhere(r: DateRange) {
  if (!isIsoDate(r.from) || !isIsoDate(r.to)) throw new Error("Invalid date range");
  return `segments.date BETWEEN '${r.from}' AND '${r.to}'`;
}

/** Run a query; if Google rejects an optional metric (impression share on some resources), retry without it. */
async function queryWithFallback(
  c: GoogleAdsClient,
  cid: string,
  build: (withSis: boolean) => string,
  warnings: string[],
): Promise<GaqlRow[]> {
  try {
    return await c.query<GaqlRow>(cid, build(true));
  } catch (e) {
    if ((e as ConnectorError).kind !== "invalid_request") throw e;
    warnings.push("Search impression share is not available for some rows — shown as “—”.");
    return c.query<GaqlRow>(cid, build(false));
  }
}

const keywordLabel = (k: GaqlRow["adGroupCriterion"]) => {
  const t = k?.keyword?.text ?? "";
  return k?.keyword?.matchType === "EXACT" ? `[${t}]` : k?.keyword?.matchType === "PHRASE" ? `"${t}"` : t;
};

/** Sum rows that share a key (age/gender/geo views come per ad group; search terms per ad group). */
function aggregate<K extends string>(rows: GaqlRow[], key: (r: GaqlRow) => K) {
  const m = new Map<K, { row: GaqlRow; metrics: ReturnType<typeof mapMetrics> }>();
  for (const r of rows) {
    const k = key(r);
    const mm = mapMetrics(r);
    const prev = m.get(k);
    if (!prev) {
      m.set(k, { row: r, metrics: mm });
      continue;
    }
    const p = prev.metrics;
    p.spend += mm.spend;
    p.impressions += mm.impressions;
    p.clicks += mm.clicks;
    p.purchases += mm.purchases;
    p.purchaseValue += mm.purchaseValue;
    p.results += mm.results;
    p.resultsValue += mm.resultsValue;
    p.allConversions = (p.allConversions ?? 0) + (mm.allConversions ?? 0);
    p.viewThroughConv = (p.viewThroughConv ?? 0) + (mm.viewThroughConv ?? 0);
  }
  return [...m.values()];
}

export const googleConnector: Connector = {
  platform: "GOOGLE",

  oauth: {
    authorizeUrl(state, redirectUri) {
      if (googleMockEnabled()) return `${redirectUri}?code=mock-code&state=${encodeURIComponent(state)}`;
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", env().clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "https://www.googleapis.com/auth/adwords openid email");
      u.searchParams.set("access_type", "offline"); // refresh token
      u.searchParams.set("prompt", "consent"); // always return a refresh token
      u.searchParams.set("include_granted_scopes", "true");
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchangeCode(code, redirectUri) {
      const e = env();
      if (googleMockEnabled())
        return { token: "mock-refresh-token", expiresAt: null, userId: "mock-google-user", userName: "mock.user@example.com" };
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: e.clientId,
          client_secret: e.clientSecret,
        }),
      });
      const j = (await res.json()) as { refresh_token?: string; id_token?: string; error_description?: string; error?: string };
      if (!res.ok) throw new ConnectorError(`Google OAuth error: ${j.error_description ?? j.error}`, "auth");
      if (!j.refresh_token)
        throw new ConnectorError(
          "Google did not return a refresh token. Remove NorthScale at myaccount.google.com/permissions and connect again.",
          "auth",
        );
      let email: string | undefined;
      try {
        email = JSON.parse(Buffer.from((j.id_token ?? "").split(".")[1] ?? "", "base64url").toString()).email;
      } catch {
        /* id token is optional */
      }
      return { token: j.refresh_token, expiresAt: null, userId: email, userName: email };
    },
  },

  async inspectToken(refreshToken) {
    const ids = await makeClient(refreshToken).listAccessibleCustomers();
    return {
      id: ids[0] ?? "google",
      name: `${ids.length} accessible Google Ads account${ids.length === 1 ? "" : "s"}`,
      expiresAt: null,
      scopes: ["adwords"],
    };
  },

  /** Every non-manager account reachable by the login, directly or through a manager (MCC). */
  async listAccounts(refreshToken) {
    const c = makeClient(refreshToken);
    const ids = await c.listAccessibleCustomers();
    const out = new Map<string, ExternalAccount>();
    for (const id of ids) {
      let root: GaqlRow | undefined;
      try {
        [root] = await c.query<GaqlRow>(
          id,
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer",
          id,
        );
      } catch {
        continue; // e.g. cancelled accounts or ones the token cannot query
      }
      const cu = root?.customer;
      if (!cu) continue;
      if (!cu.manager) {
        if (!out.has(id))
          out.set(id, {
            externalId: formatCustomerId(id),
            name: cu.descriptiveName || formatCustomerId(id),
            currency: cu.currencyCode ?? "USD",
            timezone: cu.timeZone ?? "UTC",
            status: cu.status ?? "ENABLED",
            parent: null,
            loginCustomerId: null,
          });
        continue;
      }
      const children = await c
        .query<GaqlRow>(
          id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.manager = false",
          id,
        )
        .catch(() => [] as GaqlRow[]);
      for (const ch of children) {
        const cc = ch.customerClient;
        if (!cc?.id || out.has(cc.id)) continue;
        out.set(cc.id, {
          externalId: formatCustomerId(cc.id),
          name: cc.descriptiveName || formatCustomerId(cc.id),
          currency: cc.currencyCode ?? "USD",
          timezone: cc.timeZone ?? "UTC",
          status: cc.status ?? "ENABLED",
          parent: `${cu.descriptiveName ?? "Manager"} (MCC ${formatCustomerId(id)})`,
          loginCustomerId: id,
        });
      }
    }
    return [...out.values()].map((a) => ({
      ...a,
      status: a.status === "ENABLED" ? "Active" : a.status.charAt(0) + a.status.slice(1).toLowerCase(),
    }));
  },

  async syncRange(ctx, range): Promise<SyncResult> {
    const c = makeClient(ctx.token, ctx.loginCustomerId, ctx.onUsage);
    const cid = digits(ctx.externalId);
    const where = dateWhere(range);
    const warnings: string[] = [];
    const base = { connectionId: ctx.connectionId, clientId: ctx.clientId, platform: "GOOGLE" as const };

    // ── entities ──
    const [campaigns, adGroups, ads, actions] = await Promise.all([
      c.query<GaqlRow>(
        cid,
        "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
      ),
      c.query<GaqlRow>(
        cid,
        "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name FROM ad_group WHERE ad_group.status != 'REMOVED'",
      ),
      c.query<GaqlRow>(
        cid,
        "SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.policy_topic_entries, ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'",
      ),
      c
        .query<GaqlRow>(
          cid,
          "SELECT conversion_action.id, conversion_action.category, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED'",
        )
        .catch(() => [] as GaqlRow[]),
    ]);
    const present = new Set<string>();
    for (const a of actions) {
      const cat = (a as { conversionAction?: { category?: string } }).conversionAction?.category;
      const f = cat ? CATEGORY_TO_FIELD[cat] : undefined;
      if (f && f !== "purchaseCategory") present.add(f);
    }
    const adNames = new Map(ads.map((a) => [a.adGroupAd?.ad?.id ?? "", adName(a)]));
    const entities: EntityRow[] = [
      ...campaigns.map((r) => ({
        ...base,
        level: "CAMPAIGN" as const,
        externalId: r.campaign!.id!,
        name: r.campaign!.name ?? r.campaign!.id!,
        status: r.campaign!.status ?? null,
        effectiveStatus: r.campaign!.status ?? null,
        objective: r.campaign!.advertisingChannelSubType ?? null,
        campaignType: campaignType(r.campaign),
        isProspecting: !/brand|marca|remarketing|retarget/i.test(r.campaign!.name ?? ""),
        dailyBudget: r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) / 1e6 : null,
      })),
      ...adGroups.map((r) => ({
        ...base,
        level: "ADSET" as const,
        externalId: r.adGroup!.id!,
        name: r.adGroup!.name ?? r.adGroup!.id!,
        campaignExternalId: r.campaign?.id ?? null,
        status: r.adGroup!.status ?? null,
        effectiveStatus: r.adGroup!.status ?? null,
      })),
      ...ads.map((r) => ({
        ...base,
        level: "AD" as const,
        externalId: r.adGroupAd!.ad!.id!,
        name: adName(r),
        campaignExternalId: r.campaign?.id ?? null,
        adsetExternalId: r.adGroup?.id ?? null,
        status: r.adGroupAd?.status ?? null,
        effectiveStatus: r.adGroupAd?.policySummary?.approvalStatus === "DISAPPROVED" ? "DISAPPROVED" : (r.adGroupAd?.status ?? null),
        reviewFeedback: policyIssue(r),
        landingUrl: r.adGroupAd?.ad?.finalUrls?.[0] ?? null,
      })),
    ];

    // ── daily metrics per level ──
    const [acc, camp, adg, ad, kw, st, cats, adgCats] = await Promise.all([
      queryWithFallback(
        c,
        cid,
        (sis) => `SELECT segments.date, ${METRICS}${sis ? ", metrics.search_impression_share" : ""} FROM customer WHERE ${where}`,
        warnings,
      ),
      queryWithFallback(
        c,
        cid,
        (sis) =>
          `SELECT segments.date, campaign.id, campaign.name, ${METRICS}${sis ? ", metrics.search_impression_share" : ""} FROM campaign WHERE ${where}`,
        warnings,
      ),
      c.query<GaqlRow>(
        cid,
        `SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, ${METRICS} FROM ad_group WHERE ${where}`,
      ),
      c.query<GaqlRow>(
        cid,
        `SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ${METRICS} FROM ad_group_ad WHERE ${where}`,
      ),
      queryWithFallback(
        c,
        cid,
        (sis) =>
          `SELECT segments.date, campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ${METRICS}${sis ? ", metrics.search_impression_share" : ""} FROM keyword_view WHERE ${where}`,
        warnings,
      ),
      c.query<GaqlRow>(
        cid,
        `SELECT segments.date, campaign.id, campaign.name, search_term_view.search_term, ${METRICS} FROM search_term_view WHERE ${where}`,
      ),
      c.query<GaqlRow>(
        cid,
        `SELECT segments.date, campaign.id, segments.conversion_action_category, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE ${where}`,
      ),
      c.query<GaqlRow>(
        cid,
        `SELECT segments.date, ad_group.id, segments.conversion_action_category, metrics.all_conversions, metrics.all_conversions_value FROM ad_group WHERE ${where}`,
      ),
    ]);
    const catByAdGroup = new Map<string, GaqlRow[]>();
    for (const r of adgCats) {
      const k = `${r.segments?.date}|${r.adGroup?.id}`;
      catByAdGroup.set(k, [...(catByAdGroup.get(k) ?? []), r]);
    }

    // conversion categories per (date, campaign) and per date (account)
    const catByCampaign = new Map<string, GaqlRow[]>();
    const catByDay = new Map<string, GaqlRow[]>();
    for (const r of cats) {
      const k = `${r.segments?.date}|${r.campaign?.id}`;
      catByCampaign.set(k, [...(catByCampaign.get(k) ?? []), r]);
      catByDay.set(r.segments!.date!, [...(catByDay.get(r.segments!.date!) ?? []), r]);
    }
    const funnel = (rows: GaqlRow[] | undefined) => {
      const f = foldCategories(rows ?? [], present);
      return {
        addToCart: f.addToCart,
        initiateCheckout: f.initiateCheckout,
        leads: f.leads,
        extra: { conversionCategories: f.byCategory },
      };
    };

    const daily: DailyRow[] = [];
    const row = (
      r: GaqlRow,
      level: DailyRow["level"],
      key: Partial<DailyRow> & { entityId: string; entityName: string },
      extra: Partial<DailyRow> = {},
    ) => {
      const m = mapMetrics(r);
      daily.push({
        ...base,
        date: new Date(r.segments!.date! + "T00:00:00Z"),
        level,
        currency: ctx.currency,
        attribution: "default",
        ...m,
        ...key,
        ...extra,
      });
    };
    for (const r of acc) {
      const f = funnel(catByDay.get(r.segments!.date!));
      row(
        r,
        "ACCOUNT",
        { entityId: formatCustomerId(cid), entityName: String(ctx.meta.accountName ?? formatCustomerId(cid)) },
        { addToCart: f.addToCart, initiateCheckout: f.initiateCheckout, leads: f.leads, extra: f.extra },
      );
    }
    for (const r of camp) {
      const f = funnel(catByCampaign.get(`${r.segments?.date}|${r.campaign?.id}`));
      row(
        r,
        "CAMPAIGN",
        {
          entityId: r.campaign!.id!,
          entityName: r.campaign!.name ?? r.campaign!.id!,
          campaignId: r.campaign!.id!,
          campaignName: r.campaign!.name ?? null,
        },
        { addToCart: f.addToCart, initiateCheckout: f.initiateCheckout, leads: f.leads, extra: f.extra },
      );
    }
    for (const r of adg) {
      const f = funnel(catByAdGroup.get(`${r.segments?.date}|${r.adGroup?.id}`));
      row(
        r,
        "ADSET",
        {
          entityId: r.adGroup!.id!,
          entityName: r.adGroup!.name ?? r.adGroup!.id!,
          campaignId: r.campaign?.id ?? null,
          campaignName: r.campaign?.name ?? null,
          adsetId: r.adGroup!.id!,
          adsetName: r.adGroup!.name ?? null,
        },
        { addToCart: f.addToCart, initiateCheckout: f.initiateCheckout, leads: f.leads },
      );
    }
    for (const r of ad) {
      const id = r.adGroupAd!.ad!.id!;
      row(r, "AD", {
        entityId: id,
        entityName: adNames.get(id) ?? id,
        campaignId: r.campaign?.id ?? null,
        campaignName: r.campaign?.name ?? null,
        adsetId: r.adGroup?.id ?? null,
        adsetName: r.adGroup?.name ?? null,
        adId: id,
      });
    }
    const keywordEntities = new Map<string, EntityRow>();
    for (const r of kw) {
      const id = `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`;
      const name = keywordLabel(r.adGroupCriterion);
      row(r, "KEYWORD", {
        entityId: id,
        entityName: name,
        campaignId: r.campaign?.id ?? null,
        campaignName: r.campaign?.name ?? null,
        adsetId: r.adGroup?.id ?? null,
        adsetName: r.adGroup?.name ?? null,
      });
      keywordEntities.set(id, {
        ...base,
        level: "KEYWORD",
        externalId: id,
        name,
        campaignExternalId: r.campaign?.id ?? null,
        adsetExternalId: r.adGroup?.id ?? null,
        status: "ENABLED",
        effectiveStatus: "ENABLED",
      });
    }
    for (const { row: r, metrics } of aggregate(st, (x) => `${x.segments?.date}|${x.campaign?.id}|${x.searchTermView?.searchTerm}`)) {
      daily.push({
        ...base,
        date: new Date(r.segments!.date! + "T00:00:00Z"),
        level: "SEARCH_TERM",
        currency: ctx.currency,
        attribution: "default",
        ...metrics,
        entityId: `${r.campaign?.id}~${r.searchTermView?.searchTerm}`,
        entityName: r.searchTermView?.searchTerm ?? "",
        campaignId: r.campaign?.id ?? null,
        campaignName: r.campaign?.name ?? null,
      });
    }

    await upsertEntities([...entities, ...keywordEntities.values()]);
    const written = await replaceDaily(
      ctx.connectionId,
      range,
      { levels: ["ACCOUNT", "CAMPAIGN", "ADSET", "AD", "KEYWORD", "SEARCH_TERM"], attributions: ["default"] },
      daily,
    );
    if (!present.has("addToCart")) warnings.push("No enabled 'Add to cart' conversion action — ATC and funnel costs show “—”.");
    return {
      rows: written + entities.length,
      warnings: [...new Set(warnings)],
      usagePct: c.operations ? Math.min(100, (c.operations / env().dailyOperations) * 100) : 0,
    };
  },

  async syncBreakdowns(ctx, range): Promise<SyncResult> {
    const c = makeClient(ctx.token, ctx.loginCustomerId, ctx.onUsage);
    const cid = digits(ctx.externalId);
    const where = dateWhere(range);
    const warnings: string[] = [];
    const rows: BreakdownRow[] = [];
    const done: string[] = [];

    const push = (type: BreakdownRow["breakdownType"], r: GaqlRow, value: string, m: ReturnType<typeof mapMetrics>) =>
      rows.push({
        clientId: ctx.clientId,
        connectionId: ctx.connectionId,
        platform: "GOOGLE",
        date: new Date(r.segments!.date! + "T00:00:00Z"),
        level: "CAMPAIGN",
        entityId: r.campaign!.id!,
        entityName: r.campaign!.name ?? r.campaign!.id!,
        campaignId: r.campaign!.id!,
        breakdownType: type,
        breakdownValue: value,
        currency: ctx.currency,
        spend: m.spend,
        impressions: m.impressions,
        clicks: m.clicks,
        purchases: m.purchases,
        purchaseValue: m.purchaseValue,
        results: m.results,
        resultsValue: m.resultsValue,
      });

    const specs: { type: BreakdownRow["breakdownType"]; gaql: string; value: (r: GaqlRow) => string }[] = [
      {
        type: "HOUR",
        gaql: `SELECT segments.date, segments.hour, campaign.id, campaign.name, ${METRICS} FROM campaign WHERE ${where}`,
        value: (r) => hourLabel(r.segments?.hour),
      },
      {
        type: "DEVICE",
        gaql: `SELECT segments.date, segments.device, campaign.id, campaign.name, ${METRICS} FROM campaign WHERE ${where}`,
        value: (r) => r.segments?.device ?? "UNKNOWN",
      },
      {
        type: "AGE",
        gaql: `SELECT segments.date, campaign.id, campaign.name, ad_group_criterion.age_range.type, ${METRICS} FROM age_range_view WHERE ${where}`,
        value: (r) => ageLabel(r.adGroupCriterion?.ageRange?.type),
      },
      {
        type: "GENDER",
        gaql: `SELECT segments.date, campaign.id, campaign.name, ad_group_criterion.gender.type, ${METRICS} FROM gender_view WHERE ${where}`,
        value: (r) => genderLabel(r.adGroupCriterion?.gender?.type),
      },
      {
        type: "COUNTRY",
        gaql: `SELECT segments.date, campaign.id, campaign.name, geographic_view.country_criterion_id, geographic_view.location_type, ${METRICS} FROM geographic_view WHERE ${where} AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'`,
        value: (r) => r.geographicView?.countryCriterionId ?? "unknown",
      },
    ];

    for (const s of specs) {
      try {
        const data = await c.query<GaqlRow>(cid, s.gaql);
        let resolve = (v: string) => v;
        if (s.type === "COUNTRY") {
          const unknown = [
            ...new Set(
              data.map((r) => r.geographicView?.countryCriterionId).filter((id): id is string => !!id && !COUNTRY_BY_CRITERION[id]),
            ),
          ];
          const extra = new Map<string, string>();
          if (unknown.length) {
            const geo = await c
              .query<GaqlRow>(
                cid,
                `SELECT geo_target_constant.id, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.id IN (${unknown.map((u) => digits(u)).join(",")})`,
              )
              .catch(() => []);
            for (const g of geo)
              if (g.geoTargetConstant?.id && g.geoTargetConstant.countryCode)
                extra.set(g.geoTargetConstant.id, g.geoTargetConstant.countryCode);
          }
          resolve = (v) => COUNTRY_BY_CRITERION[v] ?? extra.get(v) ?? v;
        }
        for (const { row, metrics } of aggregate(data, (r) => `${r.segments?.date}|${r.campaign?.id}|${s.value(r)}`))
          push(s.type, row, resolve(s.value(row)), metrics);
        done.push(s.type);
      } catch (e) {
        const err = e as ConnectorError;
        if (err.kind === "auth" || err.kind === "rate_limit") throw e;
        warnings.push(`Breakdown ${s.type} failed: ${err.message}`);
      }
    }
    const written = await replaceBreakdowns(ctx.connectionId, range, done, rows);
    return { rows: written, warnings, usagePct: Math.min(100, (c.operations / env().dailyOperations) * 100) };
  },

  async healthCheck(ctx: ConnectorContext) {
    try {
      const c = makeClient(ctx.token, ctx.loginCustomerId);
      const [r] = await c.query<GaqlRow>(
        digits(ctx.externalId),
        "SELECT customer.id, customer.descriptive_name, customer.status, customer.currency_code, customer.time_zone, customer.test_account FROM customer",
      );
      const st = r?.customer?.status ?? "UNKNOWN";
      const ok = CUSTOMER_STATUS_OK.has(st);
      return {
        status: ok ? "OK" : "ERROR",
        message: ok ? undefined : `Google Ads account ${st.toLowerCase()}`,
        account: {
          accountName: r?.customer?.descriptiveName,
          accountStatus: ok ? "Active" : st.charAt(0) + st.slice(1).toLowerCase(),
          currency: r?.customer?.currencyCode,
          timezone: r?.customer?.timeZone,
          testAccount: r?.customer?.testAccount ?? false,
        },
      };
    } catch (e) {
      const err = e as ConnectorError;
      return { status: err.kind === "auth" ? "TOKEN_EXPIRED" : "ERROR", message: err.message };
    }
  },
};
