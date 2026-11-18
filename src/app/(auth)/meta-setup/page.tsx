import type { Metadata } from "next";
import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { MetaSetupForm } from "@/components/sync/meta-setup-form";
import { requirePage } from "@/server/auth";
import { getMetaAppConfig } from "@/server/meta-app";

export const metadata: Metadata = { title: "Connect Meta" };

/** Shown inside the "Connect Meta" pop-up only while the Meta app keys aren't saved yet. */
async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const user = await requirePage("connect");
  const clientId = typeof sp.client === "string" ? sp.client : "";
  const startHref = `/api/connect/meta/start?client=${encodeURIComponent(clientId)}${sp.popup === "1" ? "&popup=1" : ""}`;
  const cfg = await getMetaAppConfig();
  const admin = user.role === "OWNER" || user.role === "ADMIN";
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-[17px] font-semibold">Connect Meta</h1>
        <p className="mt-1 text-[13px] text-muted">
          {admin
            ? "Paste your Meta app keys once — after that this button goes straight to Facebook."
            : "Ask an Owner or Admin to finish the Facebook setup."}
        </p>
      </div>
      {admin && <MetaSetupForm startHref={startHref} configured={!!cfg} />}
    </Card>
  );
}

export default function MetaSetupPage({ searchParams }: PageProps<"/meta-setup">) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
