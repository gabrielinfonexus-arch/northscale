import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Check, Circle, Plus } from "lucide-react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArchiveClientButton } from "@/components/admin/client-actions-ui";
import { requirePage } from "@/server/auth";
import { listClientsAdmin } from "@/server/admin-queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[12px]", done ? "text-good" : "text-subtle")}>
      {done ? <Check className="size-3.5" aria-hidden /> : <Circle className="size-3" aria-hidden />}
      {label}
      <span className="sr-only">{done ? "done" : "to do"}</span>
    </span>
  );
}

async function Content() {
  await requirePage("clients");
  const clients = await listClientsAdmin();
  if (!clients.length)
    return (
      <EmptyState
        title="No clients yet"
        action={
          <Button asChild>
            <Link href="/clients/new">Add your first client</Link>
          </Button>
        }
      >
        Each client is a brand with its own accounts, currency and targets.
      </EmptyState>
    );
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-[13px]" data-testid="clients-table">
        <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-subtle">
          <tr>
            <th className="px-4 py-2 font-medium">Client</th>
            <th className="px-4 py-2 font-medium">Currency · timezone</th>
            <th className="px-4 py-2 text-right font-medium">Meta</th>
            <th className="px-4 py-2 text-right font-medium">Google</th>
            <th className="px-4 py-2 text-right font-medium">Shopify</th>
            <th className="px-4 py-2 font-medium">Setup</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr
              key={c.id}
              className={cn("border-b border-border last:border-0", c.archived && "opacity-60")}
              data-testid={`client-${c.slug}`}
            >
              <td className="px-4 py-2.5">
                <Link href={`/clients/${c.slug}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
                <div className="text-[12px] text-subtle">
                  {c.slug}
                  {c.isDemo && " · demo"}
                  {c.archived && " · archived"}
                  {c.problems > 0 && (
                    <span className="text-bad">
                      {" "}
                      · {c.problems} connection problem{c.problems > 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2.5 text-muted">
                {c.currency} · {c.timezone}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.META}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.GOOGLE}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{c.counts.SHOPIFY}</td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <Step done={c.checklist.ads} label="Ads" />
                  <Step done={c.checklist.store} label="Store" />
                  <Step done={c.checklist.targets} label="Targets" />
                  <Step done={c.checklist.viewers} label="Access" />
                </div>
              </td>
              <td className="px-4 py-2.5 text-right">
                <div className="flex justify-end gap-1.5">
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/clients/${c.slug}`}>Edit</Link>
                  </Button>
                  <ArchiveClientButton clientId={c.id} archived={c.archived} name={c.name} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export default function ClientsPage() {
  return (
    <>
      <PageTitle title="Clients">
        <Button asChild size="sm">
          <Link href="/clients/new">
            <Plus aria-hidden /> New client
          </Link>
        </Button>
      </PageTitle>
      <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
        <Content />
      </Suspense>
    </>
  );
}
