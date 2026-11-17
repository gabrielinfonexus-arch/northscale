"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellOff, Check, ChevronDown, ExternalLink, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PlatformDot } from "@/components/shell/platform";
import { muteAlert, reopenAlert, resolveAlert } from "@/server/watchdog-actions";
import { SeverityBadge } from "./severity";

export interface FeedRow {
  id: string;
  clientName: string;
  connectionName: string | null;
  platform: string | null;
  severity: "CRITICAL" | "WARNING" | "INFO";
  status: "OPEN" | "RESOLVED" | "MUTED";
  title: string;
  message: string;
  dataLink: string | null;
  when: string;
  statusNote: string | null;
}

export function AlertFeed({ rows, showClient, canEdit }: { rows: FeedRow[]; showClient: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(id);
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "Something went wrong."));
      router.refresh();
      setBusy(null);
    });
  };

  return (
    <Card className="divide-y divide-border p-0" data-testid="alert-feed">
      {error && <div className="px-4 py-2 text-[13px] text-bad">{error}</div>}
      {rows.map((a) => (
        <article
          key={a.id}
          data-testid="alert-row"
          aria-label={a.title}
          className={`flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:gap-4 ${busy === a.id && pending ? "opacity-50" : ""}`}
        >
          <div className="flex w-[150px] shrink-0 flex-row items-center gap-2 md:flex-col md:items-start md:gap-1">
            <SeverityBadge severity={a.severity} />
            <time className="text-[12px] tabular-nums text-muted">{a.when}</time>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
              {showClient && <span className="font-medium text-foreground">{a.clientName}</span>}
              {a.connectionName && (
                <span className="inline-flex items-center gap-1">
                  {a.platform && <PlatformDot platform={a.platform} />}
                  {a.connectionName}
                </span>
              )}
              {a.statusNote && <span className="rounded bg-accent px-1.5 py-px">{a.statusNote}</span>}
            </div>
            <h3 className="mt-0.5 text-[14px] font-medium leading-snug">{a.title}</h3>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{a.message}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {a.dataLink && (
              <Button asChild variant="outline" size="sm">
                <Link href={a.dataLink}>
                  <ExternalLink aria-hidden />
                  View data
                </Link>
              </Button>
            )}
            {canEdit && a.status !== "RESOLVED" && (
              <Button variant="outline" size="sm" disabled={pending} onClick={() => act(a.id, () => resolveAlert(a.id))}>
                <Check aria-hidden />
                Resolve
              </Button>
            )}
            {canEdit && a.status === "OPEN" && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={pending}>
                    <BellOff aria-hidden />
                    Mute
                    <ChevronDown aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {[1, 3, 7, 14].map((d) => (
                    <DropdownMenuItem key={d} onSelect={() => act(a.id, () => muteAlert(a.id, d))}>
                      Mute for {d} {d === 1 ? "day" : "days"}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && a.status !== "OPEN" && (
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => act(a.id, () => reopenAlert(a.id))}>
                <RotateCcw aria-hidden />
                Reopen
              </Button>
            )}
          </div>
        </article>
      ))}
    </Card>
  );
}
