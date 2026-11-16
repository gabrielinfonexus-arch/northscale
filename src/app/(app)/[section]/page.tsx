import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ALL_NAV, CURRENT_PHASE } from "@/lib/nav";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";

export function generateStaticParams() {
  return ALL_NAV.filter((n) => n.phase > CURRENT_PHASE).map((n) => ({ section: n.href.slice(1) }));
}

async function Placeholder({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const item = ALL_NAV.find((n) => n.href === `/${section}` && n.phase > CURRENT_PHASE);
  if (!item) notFound();
  return (
    <>
      <PageTitle title={item.label} />
      <EmptyState title={`${item.label} arrives in phase ${item.phase}`}>{item.description}</EmptyState>
    </>
  );
}

export default function SectionPage({ params }: PageProps<"/[section]">) {
  return (
    <Suspense fallback={null}>
      <Placeholder params={params} />
    </Suspense>
  );
}
