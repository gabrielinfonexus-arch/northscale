import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader, PageHeaderSkeleton } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { PnlView } from "@/components/pnl/pnl-view";
import { CostSettings } from "@/components/pnl/cost-settings";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRange } from "@/lib/periods";
import { pickGlobalParams } from "@/lib/filters";
import { cn } from "@/lib/utils";
import { getPageContext } from "@/server/page-context";
import { getCostItems, getCostSettings, getPnl, getProductCosts } from "@/server/pnl";

export const metadata: Metadata = { title: "P&L" };

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams, "pnl");
  const { client, filters } = ctx;
  if (!client)
    return (
      <>
        <PageHeader title="P&L" ctx={ctx} />
        <EmptyState title="No clients yet">Add a client first.</EmptyState>
      </>
    );
  // internal costs are never shown to Client Viewers
  const staff = ctx.user.role !== "CLIENT_VIEWER";
  const view = ctx.sp.view === "costs" && staff ? "costs" : "pnl";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(ctx.sp)) if (typeof v === "string") sp.set(k, v);
  const base = pickGlobalParams(sp);
  const tabHref = (v: string) => {
    const p = new URLSearchParams(base);
    if (v === "costs") p.set("view", "costs");
    return `/pnl${p.toString() ? `?${p}` : ""}`;
  };
  const tabs = (
    <nav className="mb-4 flex gap-1 border-b border-border" aria-label="P&L views">
      {[["pnl", "Profit & loss"], ...(staff ? [["costs", "Costs"]] : [])].map(([v, label]) => (
        <Link
          key={v}
          href={tabHref(v)}
          aria-current={view === v ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-[13px] text-muted hover:text-foreground",
            view === v ? "border-primary font-medium text-foreground" : "border-transparent",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );

  if (view === "costs") {
    const [settings, items, products] = await Promise.all([
      getCostSettings(client.id),
      getCostItems(client.id),
      getProductCosts(client.id),
    ]);
    return (
      <>
        <PageHeader title="P&L" ctx={ctx} showGranularity={false} />
        {tabs}
        <CostSettings
          key={client.id}
          clientId={client.id}
          currency={client.currency}
          settings={{
            shippingCostPerOrder: settings.shippingCostPerOrder,
            shippingCostPct: settings.shippingCostPct,
            paymentFeePct: settings.paymentFeePct,
            defaultMarginPct: settings.defaultMarginPct,
          }}
          items={items}
          products={products}
        />
      </>
    );
  }
  const model = await getPnl({
    clientId: client.id,
    currency: client.currency,
    range: filters.range,
    compareRange: filters.compareRange,
    gran: filters.granularity,
  });
  return (
    <>
      <PageHeader title="P&L" ctx={ctx} />
      {tabs}
      <PnlView model={model} threshold={ctx.thresholdPct} compareLabel={filters.compareRange ? formatRange(filters.compareRange) : null} />
      <p className="mt-3 text-[11.5px] text-subtle">
        P&amp;L is per client (all stores, ad accounts and other revenue), in {client.currency}. Account filters don&apos;t apply here.
      </p>
    </>
  );
}

export default function PnlPage({ searchParams }: PageProps<"/pnl">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeaderSkeleton title="P&L" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </>
      }
    >
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
