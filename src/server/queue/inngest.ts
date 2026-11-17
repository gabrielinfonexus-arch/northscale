import "server-only";
import { Inngest } from "inngest";
import { runSync, schedulableConnections, type SyncRequest } from "../sync/engine";
import { runWatchdogAll } from "../watchdog/run";
import { generateInsights, insightClientIds } from "../ai/insights";

export const inngest = new Inngest({ id: "northscale" });

export const SYNC_EVENT = "sync/connection.requested";

/** One connection sync. Never two at once for the same connection; throttled per platform (API rate limits). */
export const syncConnection = inngest.createFunction(
  {
    id: "sync-connection",
    triggers: [{ event: SYNC_EVENT }],
    concurrency: [{ key: "event.data.connectionId", limit: 1 }],
    throttle: { key: "event.data.platform", limit: 20, period: "1m" },
    retries: 4,
  },
  async ({ event, step }) => {
    const data = event.data as SyncRequest & { platform?: string };
    return step.run("run-sync", () => runSync(data, { throwRetryable: true }));
  },
);

/** Hourly: today's data for every connection. */
export const hourlySync = inngest.createFunction({ id: "hourly-sync", triggers: [{ cron: "TZ=UTC 7 * * * *" }] }, async ({ step }) => {
  const conns = await step.run("list-connections", () => schedulableConnections());
  if (conns.length)
    await step.sendEvent(
      "fan-out",
      conns.map((c) => ({ name: SYNC_EVENT, data: { connectionId: c.id, platform: c.platform, kind: "INCREMENTAL" } })),
    );
  return { connections: conns.length };
});

/** Daily: re-sync the last 7 days (late-attributed conversions), creatives and account health. */
export const dailyResync = inngest.createFunction({ id: "daily-resync", triggers: [{ cron: "TZ=UTC 23 8 * * *" }] }, async ({ step }) => {
  const conns = await step.run("list-connections", () => schedulableConnections());
  if (conns.length)
    await step.sendEvent(
      "fan-out",
      conns.map((c) => ({ name: SYNC_EVENT, data: { connectionId: c.id, platform: c.platform, kind: "DAILY" } })),
    );
  return { connections: conns.length };
});

/** Daily: Watchdog checks for every client, including those whose data only arrives by webhook (Shopify, Other Revenue). */
export const dailyWatchdog = inngest.createFunction(
  { id: "daily-watchdog", triggers: [{ cron: "TZ=UTC 41 10 * * *" }] },
  async ({ step }) => {
    const results = await step.run("run-watchdog", () => runWatchdogAll());
    return { clients: results.length };
  },
);

/** AI Insights: every morning (after the daily re-sync and Watchdog) and a weekly summary on Mondays — one event per client. */
export const INSIGHTS_EVENT = "ai/insights.requested";
async function fanOutInsights(
  cadence: "daily" | "weekly",
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>;
    sendEvent: (id: string, e: { name: string; data: object }[]) => Promise<unknown>;
  },
) {
  const ids = (await step.run("list-clients", () => insightClientIds())) as string[];
  if (ids.length)
    await step.sendEvent(
      "fan-out",
      ids.map((clientId) => ({ name: INSIGHTS_EVENT, data: { clientId, cadence } })),
    );
  return { clients: ids.length };
}
export const dailyInsights = inngest.createFunction(
  { id: "daily-ai-insights", triggers: [{ cron: "TZ=UTC 17 11 * * *" }] },
  async ({ step }) => fanOutInsights("daily", step as never),
);
export const weeklyInsights = inngest.createFunction(
  { id: "weekly-ai-insights", triggers: [{ cron: "TZ=UTC 47 11 * * 1" }] },
  async ({ step }) => fanOutInsights("weekly", step as never),
);
export const clientInsights = inngest.createFunction(
  { id: "client-ai-insights", triggers: [{ event: INSIGHTS_EVENT }], concurrency: [{ limit: 3 }], retries: 2 },
  async ({ event, step }) => {
    const d = event.data as { clientId: string; cadence: "daily" | "weekly" };
    return step.run("generate", () => generateInsights(d.clientId, d.cadence));
  },
);

export const functions = [syncConnection, hourlySync, dailyResync, dailyWatchdog, dailyInsights, weeklyInsights, clientInsights];
