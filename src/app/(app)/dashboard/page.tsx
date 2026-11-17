import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader, PageHeaderSkeleton } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { DashboardView, type DashboardPrefs } from "@/components/dashboard/dashboard-view";
import { Skeleton } from "@/components/ui/skeleton";
import { pickGlobalParams } from "@/lib/filters";
import { getPageContext } from "@/server/page-context";
import { getDashboard } from "@/server/data/dashboard";
import { getPreference } from "@/server/prefs";

export const metadata: Metadata = { title: "Dashboard" };

function DashboardSkeleton() {
  return (
    <>
      <PageHeaderSkeleton title="Dashboard" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-[110px] rounded-xl" />
        ))}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Skeleton className="h-[360px] rounded-xl lg:col-span-2" />
        <Skeleton className="h-[360px] rounded-xl" />
      </div>
    </>
  );
}

async function DashboardContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams, "dashboard");
  const { client, filters } = ctx;
  if (!client) {
    return (
      <>
        <PageHeader title="Dashboard" ctx={ctx} />
        <EmptyState title="No clients yet">Add a client on the Clients page, or turn on “Demo data” in the sidebar.</EmptyState>
      </>
    );
  }
  const connections = Object.fromEntries(client.connections.map((c) => [c.id, { name: c.name, platform: c.platform }]));
  const [model, prefs] = await Promise.all([
    getDashboard({
      clientId: client.id,
      currency: client.currency,
      conn: ctx.connectionIds.length ? ctx.connectionIds : null,
      connections,
      range: filters.range,
      compareRange: filters.compareRange,
      gran: filters.granularity,
      today: ctx.today,
    }),
    getPreference<DashboardPrefs>(ctx.user.id, "dashboard"),
  ]);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(ctx.sp)) if (typeof v === "string") sp.set(k, v);
  const g = pickGlobalParams(sp);
  const link = (path: string, extra: Record<string, string>) => {
    const p = new URLSearchParams(g);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `${path}?${p}`;
  };
  return (
    <>
      <PageHeader title="Dashboard" ctx={ctx} />
      <DashboardView
        key={client.id}
        model={model}
        prefs={prefs}
        clientId={client.id}
        threshold={ctx.thresholdPct}
        hasCompare={!!filters.compareRange}
        today={ctx.today}
        links={{
          campaigns: link("/data", { platform: "meta", tab: "campaigns" }),
          creatives: link("/data", { platform: "meta", tab: "creatives" }),
          products: link("/data", { platform: "shopify", tab: "products" }),
          targets: link("/targets", {}),
        }}
      />
    </>
  );
}

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent searchParams={searchParams} />
    </Suspense>
  );
}
