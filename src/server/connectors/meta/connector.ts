import "server-only";
import type { DateRange } from "@/lib/periods";
import { addDays } from "@/lib/periods";
import { ConnectorError, type Connector, type ConnectorContext, type SyncResult } from "../types";
import {
  replaceBreakdowns,
  replaceDaily,
  upsertCreatives,
  upsertEntities,
  type BreakdownRow,
  type DailyRow,
  type EntityRow,
} from "../../sync/writer";
import { DEFAULT_META_API_VERSION, MetaClient, type MetaClientOptions } from "./client";
import { metaMockEnabled, mockMetaFetch } from "./mock";
import {
  ACCOUNT_STATUS,
  ATTRIBUTION_WINDOWS,
  BREAKDOWNS,
  LEVEL_ENUM,
  actionExtras,
  breakdownValue,
  entityOf,
  mapCreative,
  mapMetrics,
  normalizeAccountId,
  reviewFeedback,
  type MetaAd,
  type MetaInsightRow,
  type MetaLevel,
} from "./mapping";

const version = () => process.env.META_API_VERSION || DEFAULT_META_API_VERSION;

/** Every Meta client is created here, so mock mode (META_MOCK=1) swaps the transport in one place. */
function makeClient(o: Omit<MetaClientOptions, "version">) {
  return new MetaClient({ ...o, version: version(), ...(metaMockEnabled() ? { fetchImpl: mockMetaFetch, sleep: async () => {} } : {}) });
}

function client(ctx: Pick<ConnectorContext, "token" | "onUsage">) {
  return makeClient({ token: ctx.token, onUsage: ctx.onUsage });
}

const INSIGHT_FIELDS = [
  "account_id",
  "account_name",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "inline_link_clicks",
  "actions",
  "action_values",
  "video_thruplay_watched_actions",
  "results",
];
/** Fields Meta has deprecated or may reject for some accounts — dropped and retried instead of failing. */
const OPTIONAL_FIELDS = new Set(["reach", "results", "video_thruplay_watched_actions"]);

/** Fetch insights; falls back to an async report for heavy requests, and drops optional fields Meta rejects. */
async function fetchInsights(
  c: MetaClient,
  account: string,
  params: Record<string, unknown>,
  warnings: string[],
): Promise<MetaInsightRow[]> {
  let fields = [...INSIGHT_FIELDS];
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = { ...params, fields: fields.join(","), limit: 500 };
    try {
      return await c.all<MetaInsightRow>(`${account}/insights`, p);
    } catch (e) {
      const err = e as ConnectorError;
      const rejected = fields.find((f) => OPTIONAL_FIELDS.has(f) && err.message?.includes(f));
      if (err.kind === "invalid_request" && rejected) {
        fields = fields.filter((f) => f !== rejected);
        warnings.push(`Meta rejected field "${rejected}" — stored as “—”.`);
        continue;
      }
      // "Please reduce the amount of data you're asking for" → async report
      if (err.kind === "transient" || err.code === 1) return asyncInsights(c, account, p);
      throw e;
    }
  }
  return [];
}

async function asyncInsights(c: MetaClient, account: string, params: Record<string, unknown>): Promise<MetaInsightRow[]> {
  const run = await c.post<{ report_run_id: string }>(`${account}/insights`, params);
  for (let i = 0; i < 120; i++) {
    const st = await c.get<{ async_status: string; async_percent_completion: number }>(run.report_run_id, {
      fields: "async_status,async_percent_completion",
    });
    if (st.async_status === "Job Completed") return c.all<MetaInsightRow>(`${run.report_run_id}/insights`, { limit: 500 });
    if (st.async_status === "Job Failed" || st.async_status === "Job Skipped")
      throw new ConnectorError(`Async insights report ${st.async_status}`, "transient");
    await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 + i * 500)));
  }
  throw new ConnectorError("Async insights report timed out", "transient");
}

const RETARGETING = /\b(rt|rmkt|retarget|remarketing|dpa|existing|engagers?)\b/i;

function attributionLabel(spec: { event_type: string; window_days: number }[] | undefined): string | null {
  if (!spec?.length) return null;
  return spec
    .map(
      (s) =>
        `${s.window_days}d_${s.event_type === "CLICK_THROUGH" ? "click" : s.event_type === "VIEW_THROUGH" ? "view" : s.event_type.toLowerCase()}`,
    )
    .join("_");
}

export const metaConnector: Connector = {
  platform: "META",

  oauth: {
    authorizeUrl(state, redirectUri) {
      if (metaMockEnabled()) return `${redirectUri}?code=mock-code&state=${encodeURIComponent(state)}`;
      const u = new URL(`https://www.facebook.com/${version()}/dialog/oauth`);
      u.searchParams.set("client_id", process.env.META_APP_ID ?? "");
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      if (process.env.META_LOGIN_CONFIG_ID)
        u.searchParams.set("config_id", process.env.META_LOGIN_CONFIG_ID); // Facebook Login for Business
      else u.searchParams.set("scope", "ads_read,business_management,leads_retrieval,pages_show_list");
      return u.toString();
    },
    async exchangeCode(code, redirectUri) {
      const mock = metaMockEnabled();
      const appId = process.env.META_APP_ID ?? (mock ? "mock" : undefined),
        secret = process.env.META_APP_SECRET ?? (mock ? "mock" : undefined);
      if (!appId || !secret) throw new ConnectorError("META_APP_ID / META_APP_SECRET are not set", "invalid_request");
      const c = makeClient({ token: "" });
      const short = await c.get<{ access_token: string }>("oauth/access_token", {
        client_id: appId,
        client_secret: secret,
        redirect_uri: redirectUri,
        code,
      });
      // long-lived user token (~60 days)
      const long = await c.get<{ access_token: string; expires_in?: number }>("oauth/access_token", {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: secret,
        fb_exchange_token: short.access_token,
      });
      const me = await makeClient({ token: long.access_token }).get<{ id: string; name: string }>("me", { fields: "id,name" });
      return {
        token: long.access_token,
        expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
        userId: me.id,
        userName: me.name,
      };
    },
  },

  async inspectToken(token) {
    const c = makeClient({ token });
    const me = await c.get<{ id: string; name: string }>("me", { fields: "id,name" });
    let scopes: string[] = [];
    try {
      const perms = await c.get<{ data: { permission: string; status: string }[] }>("me/permissions");
      scopes = perms.data.filter((p) => p.status === "granted").map((p) => p.permission);
    } catch {
      /* system users may not expose permissions */
    }
    if (scopes.length && !scopes.includes("ads_read") && !scopes.includes("ads_management"))
      throw new ConnectorError("This token is missing the ads_read permission.", "permission");
    return { id: me.id, name: me.name, expiresAt: null, scopes };
  },

  async listAccounts(token) {
    const c = makeClient({ token });
    const rows = await c.all<{
      id: string;
      account_id: string;
      name: string;
      currency: string;
      timezone_name: string;
      account_status: number;
      business?: { name?: string };
    }>("me/adaccounts", { fields: "id,account_id,name,currency,timezone_name,account_status,business{name}", limit: 200 });
    return rows.map((r) => ({
      externalId: normalizeAccountId(r.id ?? r.account_id),
      name: r.name,
      currency: r.currency,
      timezone: r.timezone_name,
      status: ACCOUNT_STATUS[r.account_status]?.label ?? String(r.account_status),
      parent: r.business?.name ?? null,
    }));
  },

  async syncRange(ctx, range: DateRange): Promise<SyncResult> {
    const c = client(ctx);
    const account = normalizeAccountId(ctx.externalId);
    const warnings: string[] = [];
    const accountName = String(ctx.meta.accountName ?? account);
    const timeRange = { since: range.from, until: range.to };

    // ── entities (campaigns, ad sets, ads) ──
    const [campaigns, adsets, ads] = await Promise.all([
      c.all<{
        id: string;
        name: string;
        status: string;
        effective_status: string;
        objective?: string;
        daily_budget?: string;
        smart_promotion_type?: string;
      }>(`${account}/campaigns`, {
        fields: "id,name,status,effective_status,objective,daily_budget,smart_promotion_type",
        limit: 500,
      }),
      c.all<{
        id: string;
        name: string;
        campaign_id: string;
        status: string;
        effective_status: string;
        daily_budget?: string;
        attribution_spec?: { event_type: string; window_days: number }[];
      }>(`${account}/adsets`, { fields: "id,name,campaign_id,status,effective_status,daily_budget,attribution_spec", limit: 500 }),
      c.all<MetaAd>(`${account}/ads`, { fields: "id,name,status,effective_status,adset_id,campaign_id,ad_review_feedback", limit: 500 }),
    ]);
    const base = { connectionId: ctx.connectionId, clientId: ctx.clientId, platform: "META" as const };
    const campaignById = new Map(campaigns.map((x) => [x.id, x]));
    const entities: EntityRow[] = [
      ...campaigns.map((x) => ({
        ...base,
        level: "CAMPAIGN" as const,
        externalId: x.id,
        name: x.name,
        status: x.status,
        effectiveStatus: x.effective_status,
        objective: x.objective ?? null,
        campaignType: x.smart_promotion_type === "AUTOMATED_SHOPPING_ADS" ? "ADVANTAGE_PLUS_SHOPPING" : "MANUAL",
        isProspecting: !RETARGETING.test(x.name),
        dailyBudget: x.daily_budget ? Number(x.daily_budget) / 100 : null,
      })),
      ...adsets.map((x) => ({
        ...base,
        level: "ADSET" as const,
        externalId: x.id,
        name: x.name,
        campaignExternalId: x.campaign_id,
        status: x.status,
        effectiveStatus: x.effective_status,
        isProspecting: !RETARGETING.test(`${campaignById.get(x.campaign_id)?.name ?? ""} ${x.name}`),
        dailyBudget: x.daily_budget ? Number(x.daily_budget) / 100 : null,
      })),
      ...ads.map((x) => ({
        ...base,
        level: "AD" as const,
        externalId: x.id,
        name: x.name,
        campaignExternalId: x.campaign_id ?? null,
        adsetExternalId: x.adset_id ?? null,
        status: x.status ?? null,
        effectiveStatus: x.effective_status ?? null,
        reviewFeedback:
          x.effective_status === "DISAPPROVED" || x.effective_status === "WITH_ISSUES" ? (reviewFeedback(x) ?? x.effective_status) : null,
      })),
    ];
    await upsertEntities(entities);
    const attribution = attributionLabel(adsets.find((a) => a.attribution_spec?.length)?.attribution_spec);

    // ── daily insights per level ──
    const rows: DailyRow[] = [];
    const levels: MetaLevel[] = ["account", "campaign", "adset", "ad"];
    for (const level of levels) {
      const withWindows = level === "account";
      const data = await fetchInsights(
        c,
        account,
        {
          level,
          time_range: timeRange,
          time_increment: 1,
          use_unified_attribution_setting: true,
          ...(withWindows ? { action_attribution_windows: ATTRIBUTION_WINDOWS } : {}),
        },
        warnings,
      );
      for (const r of data) {
        const key = entityOf(r, level, account, accountName);
        const common = { ...base, date: new Date(r.date_start + "T00:00:00Z"), level: LEVEL_ENUM[level], currency: ctx.currency, ...key };
        const m = mapMetrics(r);
        rows.push({
          ...common,
          attribution: "default",
          ...m,
          extra: level === "account" || level === "campaign" ? (actionExtras(r) ?? undefined) : undefined,
        });
        if (withWindows)
          for (const w of ["7d_click", "1d_click"] as const) {
            const mw = mapMetrics(r, w);
            rows.push({
              ...common,
              attribution: w,
              spend: m.spend,
              impressions: m.impressions,
              clicks: m.clicks,
              purchases: mw.purchases,
              purchaseValue: mw.purchaseValue,
            });
          }
      }
    }
    const written = await replaceDaily(
      ctx.connectionId,
      range,
      { levels: ["ACCOUNT", "CAMPAIGN", "ADSET", "AD"], attributions: ["default", "7d_click", "1d_click"] },
      rows,
    );
    return {
      rows: written + entities.length,
      warnings,
      usagePct: c.maxUsage,
      metaPatch: { accountName, ...(attribution ? { attributionSetting: attribution } : {}) },
    };
  },

  async syncBreakdowns(ctx, range): Promise<SyncResult> {
    const c = client(ctx);
    const account = normalizeAccountId(ctx.externalId);
    const warnings: string[] = [];
    const rows: BreakdownRow[] = [];
    const done: string[] = [];
    let audienceSegments: boolean | undefined;
    for (const b of BREAKDOWNS) {
      // Hourly breakdowns over long ranges are heavy: split into 7-day windows.
      const step = b.type === "HOUR" ? 7 : 31;
      try {
        for (let from = range.from; from <= range.to; from = addDays(from, step)) {
          const to = addDays(from, step - 1) < range.to ? addDays(from, step - 1) : range.to;
          const data = await fetchInsights(
            c,
            account,
            {
              level: "campaign",
              time_range: { since: from, until: to },
              time_increment: 1,
              breakdowns: b.fields.join(","),
              use_unified_attribution_setting: true,
            },
            warnings,
          );
          for (const r of data) {
            const m = mapMetrics(r);
            rows.push({
              clientId: ctx.clientId,
              connectionId: ctx.connectionId,
              platform: "META",
              date: new Date(r.date_start + "T00:00:00Z"),
              level: "CAMPAIGN",
              entityId: r.campaign_id!,
              entityName: r.campaign_name ?? r.campaign_id!,
              campaignId: r.campaign_id ?? null,
              breakdownType: b.type,
              breakdownValue: breakdownValue(b.type, r),
              currency: ctx.currency,
              spend: m.spend,
              impressions: m.impressions,
              reach: m.reach,
              clicks: m.clicks,
              linkClicks: m.linkClicks,
              purchases: m.purchases,
              purchaseValue: m.purchaseValue,
              addToCart: m.addToCart,
              initiateCheckout: m.initiateCheckout,
              leads: m.leads,
              results: m.results,
              resultsValue: m.resultsValue,
            });
          }
        }
        done.push(b.type);
        if (b.type === "AUDIENCE_TYPE") audienceSegments = true;
      } catch (e) {
        const err = e as ConnectorError;
        if (err.kind === "auth" || err.kind === "rate_limit") throw e;
        if (b.type === "AUDIENCE_TYPE") {
          audienceSegments = false;
          warnings.push("Audience segments are not configured for this ad account (Advertising settings → Audience segments).");
        } else warnings.push(`Breakdown ${b.type} failed: ${err.message}`);
      }
    }
    // Hourly rows from the same day can collide when Meta repeats a campaign; keep the last.
    const written = await replaceBreakdowns(ctx.connectionId, range, done, rows);
    return { rows: written, warnings, usagePct: c.maxUsage, metaPatch: audienceSegments === undefined ? undefined : { audienceSegments } };
  },

  async syncCreatives(ctx): Promise<SyncResult> {
    const c = client(ctx);
    const account = normalizeAccountId(ctx.externalId);
    const ads = await c.all<MetaAd>(`${account}/ads`, {
      fields:
        "id,name,adset_id,campaign_id,effective_status,creative{id,name,object_type,thumbnail_url,image_url,title,body,video_id,link_url,object_story_spec,asset_feed_spec}",
      thumbnail_width: 400,
      thumbnail_height: 400,
      limit: 200,
    });
    const creatives = ads.map((ad) => {
      const m = mapCreative(ad);
      return { connectionId: ctx.connectionId, clientId: ctx.clientId, platform: "META" as const, adExternalId: ad.id, ...m };
    });
    await upsertCreatives(creatives);
    // landing URL + creative link on the ad entity (Landing Destination tab)
    await upsertEntities(
      ads.map((ad, i) => ({
        connectionId: ctx.connectionId,
        clientId: ctx.clientId,
        platform: "META" as const,
        level: "AD" as const,
        externalId: ad.id,
        name: ad.name,
        campaignExternalId: ad.campaign_id ?? null,
        adsetExternalId: ad.adset_id ?? null,
        effectiveStatus: ad.effective_status ?? null,
        landingUrl: creatives[i].landingUrl,
        creativeId: creatives[i].externalId,
      })),
    );
    return { rows: creatives.length, warnings: [], usagePct: c.maxUsage };
  },

  async healthCheck(ctx) {
    const c = client(ctx);
    try {
      const a = await c.get<{
        name: string;
        account_status: number;
        disable_reason?: number;
        spend_cap?: string;
        amount_spent?: string;
        currency: string;
        timezone_name: string;
      }>(normalizeAccountId(ctx.externalId), {
        fields: "name,account_status,disable_reason,spend_cap,amount_spent,currency,timezone_name",
      });
      const st = ACCOUNT_STATUS[a.account_status];
      const spendCap = a.spend_cap ? Number(a.spend_cap) / 100 : null;
      const spent = a.amount_spent ? Number(a.amount_spent) / 100 : null;
      return {
        status: st?.ok === false ? "ERROR" : "OK",
        message: st?.ok === false ? `Ad account ${st.label.toLowerCase()}` : undefined,
        account: {
          accountName: a.name,
          accountStatus: st?.label ?? a.account_status,
          disableReason: a.disable_reason ?? null,
          spendCap,
          amountSpent: spent,
          currency: a.currency,
          timezone: a.timezone_name,
        },
      };
    } catch (e) {
      const err = e as ConnectorError;
      if (err.kind === "auth") return { status: "TOKEN_EXPIRED", message: err.message };
      return { status: "ERROR", message: err.message };
    }
  },
};
