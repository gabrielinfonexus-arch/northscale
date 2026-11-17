import type { Metadata } from "next";
import { Suspense } from "react";
import { AlertTriangle, CheckCircle2, FlaskConical } from "lucide-react";
import { PageTitle } from "@/components/shell/page-header";
import { SyncStatusTable } from "@/components/sync/sync-status-table";
import { Skeleton } from "@/components/ui/skeleton";
import { getPageContext } from "@/server/page-context";
import { getConnectionStatuses, snapshotTime } from "@/server/sync-status";
import { queueMode } from "@/server/queue/enqueue";

export const metadata: Metadata = { title: "Sync Status" };

const ERRORS: Record<string, string> = {
  meta_not_configured: "Meta isn't configured yet: set META_APP_ID and META_APP_SECRET (see README → Meta), or use a System User token.",
  google_not_configured:
    "Google Ads isn't configured yet: set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET (see README → Google Ads).",
  shopify_oauth_not_configured:
    "Shopify OAuth needs SHOPIFY_API_KEY / SHOPIFY_API_SECRET. You can also connect with an access token or the app's client ID + secret.",
  invalid_state: "The login session expired or was tampered with. Please try again.",
  forbidden: "You don't have permission to connect accounts for this client.",
  unsupported: "That platform connector arrives in a later phase.",
};

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams, "sync-status");
  const rows = await getConnectionStatuses();
  const now = snapshotTime();
  const error = typeof ctx.sp.error === "string" ? (ERRORS[ctx.sp.error] ?? ctx.sp.error) : null;
  const connected = typeof ctx.sp.connected === "string" ? Number(ctx.sp.connected) : 0;
  return (
    <>
      {error && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-bad-bg px-3 py-2 text-[13px] text-bad">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      )}
      {connected > 0 && (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-good-bg px-3 py-2 text-[13px] text-good"
        >
          <CheckCircle2 className="size-4" /> {connected} account{connected > 1 ? "s" : ""} linked — 13-month backfill started.
        </div>
      )}
      {(process.env.META_MOCK === "1" ||
        process.env.GOOGLE_ADS_MOCK === "1" ||
        process.env.SHOPIFY_MOCK === "1" ||
        queueMode() === "inline") && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-muted">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {process.env.META_MOCK === "1" ? "Meta mock mode is on (META_MOCK=1): connections use a simulated Graph API. " : ""}
            {process.env.GOOGLE_ADS_MOCK === "1" ? "Google Ads mock mode is on (GOOGLE_ADS_MOCK=1). " : ""}
            {process.env.SHOPIFY_MOCK === "1" ? "Shopify mock mode is on (SHOPIFY_MOCK=1). " : ""}
            {queueMode() === "inline"
              ? "Inngest isn't configured, so jobs run in-process without retries or schedules (fine for local dev)."
              : ""}
          </span>
        </div>
      )}
      <SyncStatusTable
        rows={rows}
        currentClient={ctx.client ? { id: ctx.client.id, name: ctx.client.name, slug: ctx.client.slug } : null}
        now={now}
      />
    </>
  );
}

export default function SyncStatusPage({ searchParams }: PageProps<"/sync-status">) {
  return (
    <>
      <PageTitle title="Sync Status" />
      <Suspense fallback={<Skeleton className="h-80 w-full rounded-xl" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}
