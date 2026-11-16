"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { ExternalAccount } from "@/server/connectors/types";
import { linkAccounts } from "@/server/sync-actions";

export function AccountPicker({
  credentialId,
  clientId,
  clientSlug,
  clientName,
  accounts,
  linked,
}: {
  credentialId: string;
  clientId: string;
  clientSlug: string;
  clientName: string;
  accounts: ExternalAccount[];
  linked: string[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(linked));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = () =>
    start(async () => {
      setError(null);
      const chosen = accounts.filter((a) => selected.has(a.externalId));
      if (!chosen.length) return setError("Select at least one account.");
      const r = await linkAccounts({
        credentialId,
        clientId,
        accounts: chosen.map(({ externalId, name, currency, timezone }) => ({ externalId, name, currency, timezone })),
      });
      if (!r.ok) return setError(r.error);
      router.push(`/sync-status?client=${clientSlug}&connected=${chosen.length}`);
    });

  return (
    <Card className="overflow-hidden" data-testid="account-picker">
      <div className="border-b border-border px-4 py-3 text-[13px]">
        Choose which ad accounts belong to <b>{clientName}</b>. Each selected account starts a 13-month backfill; afterwards it syncs every
        hour.
      </div>
      <ul className="divide-y divide-border">
        {accounts.map((a) => (
          <li key={a.externalId}>
            <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-accent">
              <Checkbox checked={selected.has(a.externalId)} onCheckedChange={() => toggle(a.externalId)} aria-label={a.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{a.name}</div>
                <div className="text-[11.5px] text-muted">
                  {a.externalId} · {a.currency} · {a.timezone}
                  {a.parent ? ` · ${a.parent}` : ""}
                </div>
              </div>
              {linked.includes(a.externalId) && <span className="rounded bg-accent px-1.5 py-0.5 text-[10.5px] text-muted">linked</span>}
              <span className={a.status === "Active" ? "text-[11.5px] text-good" : "text-[11.5px] text-warn"}>{a.status}</span>
            </label>
          </li>
        ))}
        {accounts.length === 0 && (
          <li className="px-4 py-10 text-center text-[13px] text-muted">
            This login has no ad accounts. Check that it has access in Business Manager.
          </li>
        )}
      </ul>
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <Button onClick={submit} disabled={pending} data-testid="link-accounts">
          {pending ? "Linking…" : `Link ${selected.size} account${selected.size === 1 ? "" : "s"}`}
        </Button>
        {error && <span className="text-xs text-bad">{error}</span>}
      </div>
    </Card>
  );
}
