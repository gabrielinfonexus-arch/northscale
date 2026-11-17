import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ArrowRight, Check, Circle } from "lucide-react";
import { PageTitle } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ClientForm } from "@/components/admin/client-form";
import { ArchiveClientButton, DisconnectButton } from "@/components/admin/client-actions-ui";
import { PLATFORM_LABEL } from "@/components/shell/platform";
import { requirePage } from "@/server/auth";
import { getClientAdmin } from "@/server/admin-queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Client" };

async function Content({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage("clients");
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const d = await getClientAdmin(slug);
  if (!d) notFound();
  const { client: c, checklist } = d;
  const steps = [
    { done: true, label: "Brand & economics", desc: "Currency, timezone, margins and costs (below).", href: null },
    {
      done: checklist.ads,
      label: "Connect ad accounts",
      desc: "Meta and Google Ads (read-only access).",
      href: `/sync-status?client=${c.slug}`,
    },
    {
      done: checklist.store,
      label: "Connect the Shopify store",
      desc: "Orders, refunds, COGS and UTM attribution.",
      href: `/sync-status?client=${c.slug}`,
    },
    {
      done: checklist.targets,
      label: "Set this month's targets",
      desc: "Spend, revenue, MER, ROAS, CPA… and the breakeven calculator.",
      href: `/targets?client=${c.slug}`,
    },
    {
      done: checklist.viewers,
      label: "Give the client access (optional)",
      desc: "Read-only viewers or a public link with an expiry.",
      href: `/client-viewers?client=${c.slug}`,
    },
  ];
  return (
    <>
      <PageTitle title={c.name}>
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard?client=${c.slug}`}>Open dashboard</Link>
        </Button>
        <ArchiveClientButton clientId={c.id} archived={c.archived} name={c.name} />
      </PageTitle>
      {sp.onboarding && (
        <p className="mb-3 rounded-md bg-good-bg px-3 py-2 text-[13px] text-good">Client created. Next: connect its accounts.</p>
      )}
      <Card className="mb-5 p-0" data-testid="onboarding">
        <ol className="divide-y divide-border">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-3 px-4 py-3">
              {s.done ? (
                <Check className="size-4 shrink-0 text-good" aria-label="done" />
              ) : (
                <Circle className="size-4 shrink-0 text-subtle" aria-label="to do" />
              )}
              <div className="min-w-0 flex-1">
                <div className={cn("text-[13.5px] font-medium", s.done && "text-muted")}>{s.label}</div>
                <div className="text-[12.5px] text-muted">{s.desc}</div>
              </div>
              {s.href && (
                <Button asChild variant={s.done ? "ghost" : "outline"} size="sm">
                  <Link href={s.href}>
                    {s.done ? "Review" : "Start"} <ArrowRight aria-hidden />
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ol>
      </Card>

      <h2 className="mb-2 text-[14px] font-medium">Connected accounts</h2>
      <Card className="mb-6 p-0">
        <ul className="divide-y divide-border text-[13px]">
          {d.connections.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-28 shrink-0 text-muted">{PLATFORM_LABEL[x.platform] ?? x.platform}</span>
              <span className="min-w-0 flex-1 truncate">
                {x.name} <span className="text-subtle">· {x.externalId}</span>
              </span>
              <span
                className={cn("text-[12px]", x.status === "OK" ? "text-good" : x.status === "DISCONNECTED" ? "text-subtle" : "text-bad")}
              >
                {x.status.replace("_", " ").toLowerCase()}
              </span>
              {x.status !== "DISCONNECTED" && x.platform !== "OTHER_REVENUE" && !x.isDemo && (
                <DisconnectButton connectionId={x.id} name={x.name} />
              )}
            </li>
          ))}
          {!d.connections.length && <li className="px-4 py-3 text-muted">No accounts yet.</li>}
        </ul>
      </Card>

      <h2 className="mb-2 text-[14px] font-medium">Settings</h2>
      <ClientForm key={JSON.stringify(c)} initial={c} mode="edit" />
    </>
  );
}

export default function ClientPage({ params, searchParams }: PageProps<"/clients/[slug]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <Content params={params} searchParams={searchParams} />
    </Suspense>
  );
}
