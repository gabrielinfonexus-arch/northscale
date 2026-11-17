import "server-only";
import { z } from "zod/v4";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { prisma } from "@/lib/db";
import { addDays, isoDow, todayInTz, type DateRange } from "@/lib/periods";
import { resolveTabs } from "@/lib/data-tabs";
import { listClientsForJob, type ClientSummary } from "../clients";
import { AI_MODEL, aiConfigured, aiMockEnabled, anthropic, addUsage, FALLBACK, ZERO_USAGE } from "./config";
import { executeTool, type ToolContext } from "./tools";
import { recordUsage } from "./chat";
import { STABLE_SYSTEM } from "./prompt";

/**
 * AI Insights: the model runs on a schedule (daily in the morning, weekly summary on Monday) or on demand,
 * for each client. We build a compact data pack with the same read-only tools Hive-Mind uses, then ask for
 * a few short cards (what changed, likely cause, recommended action) as structured output.
 */

export type Cadence = "daily" | "weekly" | "on_demand";

const Card = z.object({
  priority: z.enum(["high", "medium", "low"]),
  title: z.string().describe("≤ 90 characters, specific, with the key number"),
  what_changed: z.string().describe("1–2 sentences with exact numbers, period and source"),
  likely_cause: z
    .string()
    .describe(
      "1–2 sentences; cite the evidence (breakdown, creative, funnel step, Chart Note, alert). Say 'unclear' if the data doesn't show it",
    ),
  action: z.string().describe("one concrete next step a media buyer can take (NorthScale itself never changes ad accounts)"),
  metrics: z
    .array(z.object({ label: z.string(), value: z.string(), change: z.string() }))
    .describe("2–4 supporting metrics, values copied from the data pack"),
  link: z.object({
    platform: z.enum(["all", "meta", "google", "shopify", "other"]),
    tab: z.string().describe("Data page tab id, e.g. core, campaigns, creatives, age, placements, audience, products, channels"),
  }),
});
const Output = z.object({ insights: z.array(Card).describe("3 to 6 cards, most important first; fewer if little changed") });
export type InsightCard = z.infer<typeof Card>;

/** The period an insight run looks at: daily = last 7 complete days vs the 7 before; weekly = last full Mon–Sun week vs the one before. */
export function insightPeriod(cadence: Cadence, today: string): { range: DateRange; compare: DateRange } {
  const y = addDays(today, -1);
  if (cadence === "weekly") {
    const end = addDays(today, -isoDow(today) - 1); // last Sunday
    const start = addDays(end, -6);
    return { range: { from: start, to: end }, compare: { from: addDays(start, -7), to: addDays(end, -7) } };
  }
  return { range: { from: addDays(y, -6), to: y }, compare: { from: addDays(y, -13), to: addDays(y, -7) } };
}

/** Gather the facts for one client (same tools and definitions as Hive-Mind). */
export async function buildInsightPack(client: ClientSummary, cadence: Cadence, today: string) {
  const { range, compare } = insightPeriod(cadence, today);
  const ctx: ToolContext = { clients: [client] };
  const hasMeta = client.connections.some((c) => c.platform === "META");
  const hasGoogle = client.connections.some((c) => c.platform === "GOOGLE");
  const hasShopify = client.connections.some((c) => c.platform === "SHOPIFY");
  const p = { from: range.from, to: range.to, compare: "previous" as const };
  const funnel = ["spend", "purchaseValue", "roas", "cpa", "purchases", "ctr", "cpc", "cpm", "costPerAtc", "cvr"];
  const calls: [string, string, unknown][] = [
    ["blended", "get_metrics", { ...p, platform: "all" }],
    [
      "blended_by_day",
      "get_metrics",
      {
        from: addDays(range.from, -7),
        to: range.to,
        platform: "all",
        level: "period",
        metrics: ["spend", "totalRevenue", "mer", "orders"],
        compare: "none",
      },
    ],
    ["targets_and_pacing", "get_targets_and_pacing", {}],
    ["open_alerts", "get_alerts", { status: "open", limit: 15 }],
    ["chart_notes", "get_chart_notes", { from: addDays(range.from, -14), to: range.to }],
  ];
  if (hasMeta)
    calls.push(
      ["meta", "get_metrics", { ...p, platform: "meta", metrics: funnel }],
      [
        "meta_campaigns",
        "get_metrics",
        { ...p, platform: "meta", level: "campaign", metrics: ["spend", "roas", "cpa", "purchases"], limit: 8 },
      ],
      [
        "meta_creatives",
        "get_top_entities",
        { ...p, platform: "meta", level: "creative", limit: 8, metrics: ["spend", "roas", "cpa", "ctr"] },
      ],
      ["meta_audience_types", "get_breakdown", { ...p, platform: "meta", breakdown: "audience_type" }],
      ["meta_age", "get_breakdown", { ...p, platform: "meta", breakdown: "age" }],
      ["meta_placements", "get_breakdown", { ...p, platform: "meta", breakdown: "placement" }],
    );
  if (hasGoogle)
    calls.push(
      ["google", "get_metrics", { ...p, platform: "google", metrics: funnel }],
      [
        "google_campaigns",
        "get_metrics",
        { ...p, platform: "google", level: "campaign", metrics: ["spend", "roas", "cpa", "purchases"], limit: 8 },
      ],
    );
  if (hasShopify) calls.push(["shopify", "get_shopify_summary", { from: range.from, to: range.to, compare: "previous" }]);

  const results = await Promise.all(
    calls.map(async ([key, tool, input]) => {
      try {
        return [key, JSON.parse(await executeTool(ctx, tool, input))] as const;
      } catch (e) {
        return [key, { error: (e as Error).message }] as const;
      }
    }),
  );
  return {
    client: client.name,
    slug: client.slug,
    currency: client.currency,
    cadence,
    period: range,
    compared_with: compare,
    data: Object.fromEntries(results),
  };
}

const INSIGHT_INSTRUCTIONS = `You are writing NorthScale "AI Insights" cards for one client. You get a data pack (JSON) built with the same tools and metric definitions as the rest of NorthScale.
Write 3–6 short cards, most important first (fewer if little changed). Each card: what changed (exact numbers from the pack, with period and source: platform-reported vs Shopify vs blended), the likely cause (cross the evidence: breakdowns, campaigns, creatives, funnel steps CTR/CPC/cost per ATC/CVR, Shopify new vs returning/AOV/discounts, Chart Notes, Watchdog alerts, pacing), and one concrete recommended action for a media buyer.
Priority: high = money at risk or a target being missed / big swing; medium = notable; low = good news or minor.
Never invent numbers; copy them as formatted in the pack. If a metric is "—" or not available, don't use it. Don't repeat the same point in two cards. Write in Brazilian Portuguese.
link: the Data page tab that shows the evidence (platform all|meta|google|shopify|other; tab ids: core, campaigns, adsets, ads, creatives, age, gender, placements, countries, audience, hour, day-of-week, keywords, search-terms, device, campaign-type, products, new-vs-returning, discount-codes, channels, refunds).`;

/** Deterministic cards for AI_MOCK=1 (tests / local dev without an API key). */
function mockCards(pack: Awaited<ReturnType<typeof buildInsightPack>>): InsightCard[] {
  const d = pack.data as Record<
    string,
    { total?: { values?: Record<string, string>; change?: Record<string, string> } } & Record<string, unknown>
  >;
  const b = d.blended?.total ?? {};
  const cards: InsightCard[] = [
    {
      priority: "medium",
      title: `MER ${b.values?.mer ?? "—"} na semana (${b.change?.mer?.split(" vs")[0] ?? "—"})`,
      what_changed: `Receita total ${b.values?.totalRevenue ?? "—"} com investimento de ${b.values?.spend ?? "—"} entre ${pack.period.from} e ${pack.period.to} (blended).`,
      likely_cause: "Resposta simulada (AI_MOCK): sem chamada à API.",
      action: "Abra a aba Core para ver a variação dia a dia.",
      metrics: ["mer", "totalRevenue", "spend"].map((k) => ({ label: k, value: b.values?.[k] ?? "—", change: b.change?.[k] ?? "" })),
      link: { platform: "all", tab: "core" },
    },
  ];
  const alerts = (d.open_alerts as unknown as unknown[]) ?? [];
  if (Array.isArray(alerts) && alerts.length)
    cards.push({
      priority: "high",
      title: `${alerts.length} alerta(s) do Watchdog em aberto`,
      what_changed: `Há ${alerts.length} alertas abertos para ${pack.client}.`,
      likely_cause: "Resposta simulada (AI_MOCK).",
      action: "Revise os alertas críticos no Watchdog.",
      metrics: [{ label: "Alertas abertos", value: String(alerts.length), change: "" }],
      link: { platform: "meta", tab: "creatives" },
    });
  return cards;
}

export async function generateInsights(clientId: string, cadence: Cadence) {
  if (!aiConfigured()) throw new Error("Set ANTHROPIC_API_KEY to generate AI Insights.");
  const client = (await listClientsForJob([clientId]))[0];
  if (!client) throw new Error("Client not found");
  const today = todayInTz(client.timezone);
  const pack = await buildInsightPack(client, cadence, today);
  let cards: InsightCard[];
  let usage = ZERO_USAGE;
  let model = AI_MODEL;
  if (aiMockEnabled()) cards = mockCards(pack);
  else {
    const res = await anthropic().beta.messages.parse({
      model: AI_MODEL,
      max_tokens: 16000,
      system: [
        { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: INSIGHT_INSTRUCTIONS },
      ],
      messages: [{ role: "user", content: `Data pack:\n${JSON.stringify(pack)}` }],
      output_config: { effort: "medium", format: betaZodOutputFormat(Output) },
      ...FALLBACK,
    });
    usage = addUsage(usage, res.usage);
    model = res.model;
    if (res.stop_reason === "refusal") throw new Error("The model declined to generate insights for this data.");
    if (!res.parsed_output) throw new Error("The model returned no insights (invalid output).");
    cards = res.parsed_output.insights;
  }
  const runId = `run_${Date.now().toString(36)}`;
  const rows = cards.slice(0, 6).map((c) => {
    const { platform, tab } = resolveTabs(c.link.platform, c.link.tab);
    const q = new URLSearchParams({ client: client.slug, platform, tab, from: pack.period.from, to: pack.period.to });
    return {
      clientId,
      cadence,
      priority: c.priority,
      title: c.title.slice(0, 200),
      whatChanged: c.what_changed,
      likelyCause: c.likely_cause,
      action: c.action,
      metrics: c.metrics.slice(0, 4),
      dataLink: `/data?${q.toString()}`,
      periodFrom: new Date(pack.period.from + "T00:00:00Z"),
      periodTo: new Date(pack.period.to + "T00:00:00Z"),
      runId,
      model,
    };
  });
  await prisma.aiInsight.createMany({ data: rows });
  if (usage.input || usage.output) {
    const org = await prisma.client.findUnique({ where: { id: clientId }, select: { organizationId: true } });
    await recordUsage({ organizationId: org?.organizationId, user: null, clientId, feature: "insights", model, usage });
  }
  return { runId, count: rows.length };
}

/** Clients the scheduler generates insights for: active, with at least one connected account (none when AI is not configured). */
export async function insightClientIds(): Promise<string[]> {
  if (!aiConfigured()) return [];
  const rows = await prisma.client.findMany({ where: { archivedAt: null, connections: { some: {} } }, select: { id: true } });
  return rows.map((r) => r.id);
}
