import type { Metadata } from "next";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { TeamManager } from "@/components/admin/team-manager";
import { requirePage } from "@/server/auth";
import { listTeam } from "@/server/admin-queries";

export const metadata: Metadata = { title: "Team Members" };

async function Content() {
  await requirePage("team");
  const t = await listTeam();
  return <TeamManager {...t} />;
}

export default function TeamPage() {
  return (
    <>
      <PageTitle title="Team Members" />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <Content />
      </Suspense>
    </>
  );
}
