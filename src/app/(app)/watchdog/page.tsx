import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertFeed, type FeedRow } from "@/components/watchdog/feed";
import { RulesEditor } from "@/components/watchdog/rules-editor";
import { NotificationSettings } from "@/components/watchdog/notification-settings";
import { RunChecksButton } from "@/components/watchdog/run-now";
import { SeverityBadge } from "@/components/watchdog/severity";
import { cn } from "@/lib/utils";
import { getPageContext } from "@/server/page-context";
import {
  getNotificationSettings,
  getRuleSettings,
  listAlerts,
  type AlertRow,
  type AlertStatusFilter,
  type SeverityFilter,
} from "@/server/watchdog/queries";

export const metadata: Metadata = { title: "Watchdog" };

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VIEWS = [
  { id: "feed", label: "Alerts" },
  { id: "rules", label: "Rules" },
  { id: "notifications", label: "Notifications" },
] as const;
const STATUSES: { id: AlertStatusFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "muted", label: "Muted" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
];

function href(sp: SP, patch: Record<string, string | null>) {
  const p = new URLSearchParams();
  for (const k of ["client", "view", "status", "sev", "scope"]) {
    const v = k in patch ? patch[k] : str(sp[k]);
    if (v) p.set(k, v);
  }
  const q = p.toString();
  return q ? `/watchdog?${q}` : "/watchdog";
}

function Pill({ href, active, children, testId }: { href: string; active: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent font-medium text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function fmt(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function toFeed(rows: AlertRow[], tz: string): FeedRow[] {
  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    connectionName: r.connectionName,
    platform: r.platform,
    severity: r.severity,
    status: r.status,
    title: r.title,
    message: r.message,
    dataLink: r.dataLink,
    when: fmt(r.createdAt, tz),
    statusNote:
      r.status === "MUTED" && r.mutedUntil
        ? `Muted until ${fmt(r.mutedUntil, tz)}`
        : r.status === "RESOLVED" && r.resolvedAt
          ? `${r.autoResolved ? "Cleared automatically" : "Resolved"} ${fmt(r.resolvedAt, tz)}`
          : null,
  }));
}

async function Content({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await getPageContext(searchParams, "watchdog");
  const sp = ctx.sp;
  const view = (VIEWS.find((v) => v.id === str(sp.view))?.id ?? "feed") as (typeof VIEWS)[number]["id"];
  const canEdit = ctx.user.role !== "CLIENT_VIEWER";
  const client = ctx.client;
  const allScope = str(sp.scope) === "all" || !client;

  const header = (
    <PageTitle title="Watchdog">
      {canEdit && view === "feed" && (
        <RunChecksButton clientId={allScope ? null : client!.id} label={allScope ? "all clients" : client!.name} />
      )}
    </PageTitle>
  );
  const tabs = (
    <div className="mb-4 flex items-center gap-1 border-b border-border" role="tablist">
      {VIEWS.map((v) => (
        <Link
          key={v.id}
          role="tab"
          aria-selected={view === v.id}
          href={href(sp, { view: v.id === "feed" ? null : v.id })}
          className={cn(
            "-mb-px border-b-2 border-transparent px-3 pb-2 text-[13.5px] text-muted hover:text-foreground",
            view === v.id && "border-primary font-medium text-foreground",
          )}
        >
          {v.label}
        </Link>
      ))}
    </div>
  );

  if (!client)
    return (
      <>
        {header}
        <EmptyState title="No clients yet">Add a client and connect its accounts; the Watchdog checks them after every sync.</EmptyState>
      </>
    );

  if (view === "rules") {
    const rules = await getRuleSettings(client.id);
    return (
      <>
        {header}
        {tabs}
        <p className="mb-3 text-[13px] text-muted">
          Rules for <span className="font-medium text-foreground">{client.name}</span>. Targets come from the Targets page; checks run after
          every sync and once a day. The Watchdog only reads data — it never pauses or edits anything in your ad accounts.
        </p>
        <RulesEditor clientId={client.id} rules={rules} currency={client.currency} canEdit={canEdit} />
      </>
    );
  }

  if (view === "notifications") {
    const settings = await getNotificationSettings();
    return (
      <>
        {header}
        {tabs}
        <NotificationSettings key={`${settings.slackHint}:${settings.alertEmails.join()}:${settings.minSeverity}`} settings={settings} />
      </>
    );
  }

  const status = (STATUSES.find((s) => s.id === str(sp.status))?.id ?? "open") as AlertStatusFilter;
  const sevRaw = str(sp.sev);
  const severity: SeverityFilter = sevRaw === "CRITICAL" || sevRaw === "WARNING" || sevRaw === "INFO" ? sevRaw : "all";
  const { rows, counts } = await listAlerts({ clientId: allScope ? null : client.id, status, severity });
  const total = counts.CRITICAL + counts.WARNING + counts.INFO;

  return (
    <>
      {header}
      {tabs}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {STATUSES.map((s) => (
            <Pill key={s.id} href={href(sp, { status: s.id === "open" ? null : s.id })} active={status === s.id}>
              {s.label}
            </Pill>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <Pill href={href(sp, { sev: null })} active={severity === "all"}>
            All <span className="tabular-nums text-subtle">{total}</span>
          </Pill>
          {(["CRITICAL", "WARNING", "INFO"] as const).map((s) => (
            <Pill key={s} href={href(sp, { sev: s })} active={severity === s} testId={`sev-${s}`}>
              <SeverityBadge severity={s} className="h-auto bg-transparent px-0" />
              <span className="tabular-nums text-subtle">{counts[s]}</span>
            </Pill>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Pill href={href(sp, { scope: null })} active={!allScope}>
            {client.name}
          </Pill>
          <Pill href={href(sp, { scope: "all" })} active={allScope} testId="scope-all">
            All clients
          </Pill>
        </div>
      </div>
      {rows.length ? (
        <AlertFeed rows={toFeed(rows, client.timezone)} showClient={allScope} canEdit={canEdit} />
      ) : (
        <EmptyState title={status === "open" ? "All clear" : "Nothing here"}>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-good" aria-hidden />
            {status === "open" ? "No open alerts for the selected filters." : "No alerts match these filters."}
          </span>
        </EmptyState>
      )}
    </>
  );
}

export default function WatchdogPage({ searchParams }: PageProps<"/watchdog">) {
  return (
    <Suspense
      fallback={
        <>
          <PageTitle title="Watchdog">
            <Skeleton className="h-7 w-32" />
          </PageTitle>
          <Skeleton className="h-96 w-full rounded-xl" />
        </>
      }
    >
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
