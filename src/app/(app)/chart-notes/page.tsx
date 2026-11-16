import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader, PageHeaderSkeleton } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { NotesList } from "@/components/notes/notes-list";
import { Skeleton } from "@/components/ui/skeleton";
import { getPageContext } from "@/server/page-context";
import { getNotes } from "@/server/notes";

export const metadata: Metadata = { title: "Chart Notes" };

async function NotesContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams);
  if (!ctx.client) {
    return (
      <>
        <PageHeader title="Chart Notes" ctx={ctx} showGranularity={false} />
        <EmptyState title="No clients yet">Add a client first.</EmptyState>
      </>
    );
  }
  const notes = await getNotes(ctx.client.id);
  return (
    <>
      <PageHeader title="Chart Notes" ctx={ctx} showGranularity={false} />
      <NotesList
        key={ctx.client.id}
        clientId={ctx.client.id}
        notes={notes}
        range={ctx.filters.range}
        today={ctx.today}
        canEdit={ctx.user.role !== "CLIENT_VIEWER"}
      />
    </>
  );
}

export default function ChartNotesPage({ searchParams }: PageProps<"/chart-notes">) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeaderSkeleton title="Chart Notes" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </>
      }
    >
      <NotesContent searchParams={searchParams} />
    </Suspense>
  );
}
