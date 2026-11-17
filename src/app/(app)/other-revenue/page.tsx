import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader, PageHeaderSkeleton } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { OtherRevenueManager } from "@/components/other-revenue/manager";
import { Skeleton } from "@/components/ui/skeleton";
import { prisma } from "@/lib/db";
import { getPageContext } from "@/server/page-context";
import { listOtherRevenue } from "@/server/other-revenue";

export const metadata: Metadata = { title: "Other Revenue" };

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams, "other-revenue");
  if (!ctx.client)
    return (
      <>
        <PageHeader title="Other Revenue" ctx={ctx} showGranularity={false} />
        <EmptyState title="No clients yet">Add a client first.</EmptyState>
      </>
    );
  const [{ rows, sources }, client] = await Promise.all([
    listOtherRevenue(ctx.client.id, ctx.filters.range.from, ctx.filters.range.to),
    prisma.client.findUnique({ where: { id: ctx.client.id }, select: { webhookKeyHash: true } }),
  ]);
  return (
    <>
      <PageHeader title="Other Revenue" ctx={ctx} showGranularity={false} />
      <OtherRevenueManager
        key={ctx.client.id}
        clientId={ctx.client.id}
        currency={ctx.client.currency}
        today={ctx.today}
        range={ctx.filters.range}
        entries={rows}
        sources={sources}
        hasKey={!!client?.webhookKeyHash}
        endpoint={`${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/other-revenue`}
      />
    </>
  );
}

export default function OtherRevenuePage({ searchParams }: PageProps<"/other-revenue">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeaderSkeleton title="Other Revenue" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </>
      }
    >
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
