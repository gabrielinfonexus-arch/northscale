import type { Metadata } from "next";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewersManager } from "@/components/admin/viewers-manager";
import { getPageContext } from "@/server/page-context";
import { listViewers } from "@/server/admin-queries";

export const metadata: Metadata = { title: "Client Viewers" };

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams, "client-viewers");
  if (!ctx.client) return <EmptyState title="No clients yet">Add a client first.</EmptyState>;
  const data = await listViewers(ctx.client.id);
  if (!data) return <EmptyState title="Client not found" />;
  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        Read-only access for <span className="font-medium text-foreground">{ctx.client.name}</span>. Switch client at the top right.
      </p>
      <ViewersManager key={ctx.client.id} clientId={ctx.client.id} clientName={ctx.client.name} data={data} />
    </>
  );
}

export default function ClientViewersPage({ searchParams }: PageProps<"/client-viewers">) {
  return (
    <>
      <PageTitle title="Client Viewers" />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}
