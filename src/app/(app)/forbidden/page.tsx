import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { ALL_NAV } from "@/lib/nav";
import { canSeePage } from "@/lib/permissions";
import { getCurrentUser } from "@/server/auth";

export const metadata: Metadata = { title: "No access" };

async function Content() {
  const user = await getCurrentUser();
  const pages = ALL_NAV.filter((n) => canSeePage(user, n.href.slice(1)));
  return (
    <EmptyState title="You don't have access to this page">
      Ask an admin if you need it.
      {pages.length > 0 && (
        <span className="mt-3 flex flex-wrap justify-center gap-2">
          {pages.map((p) => (
            <Link key={p.href} href={p.href} className="rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-accent">
              {p.label}
            </Link>
          ))}
        </span>
      )}
    </EmptyState>
  );
}

export default function ForbiddenPage() {
  return (
    <>
      <PageTitle title="No access" />
      <Suspense>
        <Content />
      </Suspense>
    </>
  );
}
