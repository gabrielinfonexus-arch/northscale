import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, PageHeaderSkeleton } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { DataView } from "@/components/data/data-view";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveTabs } from "@/lib/data-tabs";
import { getPageContext } from "@/server/page-context";
import { getCampaignOptions, getDataTable } from "@/server/data/data-page";
import { getPreference } from "@/server/prefs";

export const metadata: Metadata = { title: "Data" };

function DataSkeleton() {
  return (
    <>
      <PageHeaderSkeleton title="Data" />
      <Card className="overflow-hidden">
        <div className="flex gap-2 px-4 pt-3">
          {["w-24", "w-16", "w-14", "w-16", "w-28"].map((w, i) => (
            <Skeleton key={i} className={`h-7 ${w}`} />
          ))}
        </div>
        <div className="mt-2 h-10 border-y border-border bg-surface-2" />
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      </Card>
    </>
  );
}

const PLATFORM_ENUM = { meta: "META", google: "GOOGLE", shopify: "SHOPIFY", other: "OTHER_REVENUE" } as const;

async function DataContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams);
  const { client, filters } = ctx;
  if (!client) {
    return (
      <>
        <PageHeader title="Data" ctx={ctx} />
        <EmptyState
          title="No clients yet"
          action={
            <Link className="text-primary underline" href="/clients">
              Add a client
            </Link>
          }
        >
          Create a client and connect its Meta, Google Ads or Shopify accounts to see data here. You can also turn on “Demo data” in the
          sidebar.
        </EmptyState>
      </>
    );
  }
  const str = (k: string) => (typeof ctx.sp[k] === "string" ? (ctx.sp[k] as string) : undefined);
  const { platform, tab } = resolveTabs(str("platform"), str("tab"));
  const conn = ctx.connectionIds.length ? ctx.connectionIds : null;

  // Empty state when the client has no connection for this platform
  if (platform !== "all") {
    const needed = PLATFORM_ENUM[platform];
    const has = client.connections.some((c) => c.platform === needed && (!conn || conn.includes(c.id)));
    if (!has) {
      const name = { meta: "Meta", google: "Google Ads", shopify: "Shopify", other: "Other revenue" }[platform];
      return (
        <>
          <PageHeader title="Data" ctx={ctx} />
          <DataView
            model={{
              key: `${platform}.${tab}`,
              firstColumn: "",
              columns: [],
              defaultVisible: [],
              rows: [],
              total: {},
              totalCompare: null,
              currency: client.currency,
              compareLabel: null,
              defaultSort: { id: "first", desc: false },
              unavailable: {},
              hasTargets: false,
              notices: [
                {
                  tone: "info",
                  text: `Connect a ${name} account to ${client.name} to see data here (Clients → ${client.name} → Connect).`,
                },
              ],
            }}
            platform={platform}
            tab={tab}
            savedColumns={null}
            clientId={client.id}
            clientSlug={client.slug}
            range={filters.range}
            threshold={ctx.thresholdPct}
            campaign={null}
            campaigns={[]}
          />
        </>
      );
    }
  }

  const campaign = str("campaign") ?? null;
  const connections = Object.fromEntries(client.connections.map((c) => [c.id, { name: c.name, platform: c.platform }]));
  const [model, campaigns] = await Promise.all([
    getDataTable({
      clientId: client.id,
      currency: client.currency,
      newAudienceMinPct: client.newAudienceMinPct,
      conn,
      connections,
      range: filters.range,
      compareRange: filters.compareRange,
      gran: filters.granularity,
      platform,
      tab,
      campaign,
    }),
    getCampaignOptions(client.id, platform, conn),
  ]);
  const savedColumns = await getPreference<string[]>(ctx.user.id, `data.columns.${platform}.${tab}`);

  return (
    <>
      <PageHeader title="Data" ctx={ctx} />
      <DataView
        key={`${client.id}:${model.key}`}
        model={model}
        platform={platform}
        tab={tab}
        savedColumns={savedColumns}
        clientId={client.id}
        clientSlug={client.slug}
        range={filters.range}
        threshold={ctx.thresholdPct}
        campaign={campaign}
        campaigns={campaigns}
      />
    </>
  );
}

export default function DataPage({ searchParams }: PageProps<"/data">) {
  return (
    <Suspense fallback={<DataSkeleton />}>
      <DataContent searchParams={searchParams} />
    </Suspense>
  );
}
